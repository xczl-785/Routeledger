import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  validateL3AuthorizationProfile,
  type L3AuthorityBindingIdentityV2,
  type L3AuthorizationProfileV2
} from "@routeledger/core";

export const LOCAL_L3_AUTHORITY_REGISTRY_SCHEMA_VERSION = 2 as const;

interface LocalL3AuthorityRegistryMarker {
  schemaVersion: typeof LOCAL_L3_AUTHORITY_REGISTRY_SCHEMA_VERSION;
  registryId: string;
  createdAt: string;
}

export interface LocalL3AuthorityBindingInput {
  projectId: string;
  workspaceRoot: string;
  routeledgerRoot: string;
  subjectId: string;
  hostKind: string;
  trustedClientId: string | null;
}

export interface BoundLocalL3AuthorityProfile {
  bindingKey: string;
  profile: L3AuthorizationProfileV2;
}

export interface LocalL3AuthorityProfileRegistry {
  bind(input: LocalL3AuthorityBindingInput): Promise<BoundLocalL3AuthorityProfile | null>;
}

export interface LoadLocalL3AuthorityProfileRegistryInput {
  registryRoot: string;
  workspaceRoot: string;
  routeledgerRoot: string;
}

export interface InstallLocalL3AuthorizationProfileInput
  extends LoadLocalL3AuthorityProfileRegistryInput {
  binding: LocalL3AuthorityBindingInput;
  profile: L3AuthorizationProfileV2;
  expectedProfileRevision?: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
};

const sha256 = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const isContainedPath = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const assertPrivateDirectory = async (directoryPath: string, label: string): Promise<void> => {
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory, not a symlink.`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group-writable or world-writable.`);
  }
  if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current OS user.`);
  }
};

const assertPrivateFile = async (filePath: string, label: string): Promise<void> => {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a symlink.`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group-writable or world-writable.`);
  }
  if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current OS user.`);
  }
};

const resolveTrustedRegistryRoot = async (
  input: LoadLocalL3AuthorityProfileRegistryInput,
  create: boolean
): Promise<string> => {
  if (!path.isAbsolute(input.registryRoot)) {
    throw new Error("Local L3 authority registry root must be absolute.");
  }
  const [workspaceRoot, routeledgerRoot] = await Promise.all([
    fs.realpath(input.workspaceRoot),
    fs.realpath(input.routeledgerRoot)
  ]);
  let registryRoot: string;
  try {
    const suppliedRoot = await fs.lstat(input.registryRoot);
    if (suppliedRoot.isSymbolicLink()) {
      throw new Error("Local L3 authority registry root must be a regular directory, not a symlink.");
    }
    registryRoot = await fs.realpath(input.registryRoot);
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await fs.realpath(path.dirname(input.registryRoot));
    await assertPrivateDirectory(parent, "Local L3 authority registry parent");
    await fs.mkdir(input.registryRoot, { mode: 0o700 });
    registryRoot = await fs.realpath(input.registryRoot);
  }
  await assertPrivateDirectory(registryRoot, "Local L3 authority registry root");
  if (isContainedPath(registryRoot, workspaceRoot) || isContainedPath(registryRoot, routeledgerRoot)) {
    throw new Error("Local L3 authority registry root must stay outside the workspace and RouteLedger root.");
  }
  return registryRoot;
};

const writeJsonAtomic = async (filePath: string, value: unknown): Promise<void> => {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const readJson = async (filePath: string, label: string): Promise<unknown> => {
  await assertPrivateFile(filePath, label);
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
};

const parseMarker = (value: unknown): LocalL3AuthorityRegistryMarker => {
  if (
    !isObject(value) ||
    value.schemaVersion !== LOCAL_L3_AUTHORITY_REGISTRY_SCHEMA_VERSION ||
    typeof value.registryId !== "string" ||
    value.registryId.trim().length === 0 ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new Error("Local L3 authority registry marker is invalid and cannot be trusted.");
  }
  return value as unknown as LocalL3AuthorityRegistryMarker;
};

const parseProfile = (value: unknown): L3AuthorizationProfileV2 => {
  if (!isObject(value)) {
    throw new Error("Local L3 authorization profile is invalid and cannot be trusted.");
  }
  const profile = value as unknown as L3AuthorizationProfileV2;
  const validation = validateL3AuthorizationProfile(profile);
  if (!validation.valid) {
    throw new Error(
      `Local L3 authorization profile is invalid: ${validation.issues[0]?.code ?? "UNKNOWN"}.`
    );
  }
  return profile;
};

export const digestLocalL3AuthorityPath = async (candidate: string): Promise<string> =>
  `sha256:${sha256(await fs.realpath(candidate))}`;

export const buildLocalL3AuthorityBindingIdentity = async (
  input: LocalL3AuthorityBindingInput
): Promise<L3AuthorityBindingIdentityV2> => {
  if (
    input.projectId.trim().length === 0 ||
    input.subjectId.trim().length === 0 ||
    input.hostKind.trim().length === 0 ||
    (input.trustedClientId !== null && input.trustedClientId.trim().length === 0)
  ) {
    throw new Error("Local L3 authority binding identity contains an empty trusted field.");
  }
  const [workspaceRootDigest, routeledgerRootDigest] = await Promise.all([
    digestLocalL3AuthorityPath(input.workspaceRoot),
    digestLocalL3AuthorityPath(input.routeledgerRoot)
  ]);
  return {
    projectId: input.projectId,
    workspaceRootDigest,
    routeledgerRootDigest,
    subjectId: input.subjectId,
    hostKind: input.hostKind,
    trustedClientId: input.trustedClientId
  };
};

export const buildLocalL3AuthorityBindingKey = (
  identity: L3AuthorityBindingIdentityV2
): string => `b2-${sha256(JSON.stringify(canonicalize(identity)))}`;

const bindingDirectory = (registryRoot: string, bindingKey: string): string =>
  path.join(registryRoot, "bindings", bindingKey);

const ensureRegistryMarker = async (registryRoot: string): Promise<void> => {
  const markerPath = path.join(registryRoot, "registry-v2.json");
  try {
    parseMarker(await readJson(markerPath, "Local L3 authority registry marker"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const marker = {
      schemaVersion: LOCAL_L3_AUTHORITY_REGISTRY_SCHEMA_VERSION,
      registryId: `registry-${randomUUID()}`,
      createdAt: new Date().toISOString()
    } satisfies LocalL3AuthorityRegistryMarker;
    try {
      await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600
      });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      parseMarker(await readJson(markerPath, "Local L3 authority registry marker"));
    }
  }
};

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const withBindingLock = async <T>(directory: string, operation: () => Promise<T>): Promise<T> => {
  const lockPath = path.join(directory, "profile.lock");
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lock = await fs.lstat(lockPath);
      if (!lock.isDirectory() || lock.isSymbolicLink()) {
        throw new Error("Local L3 authorization profile lock is invalid and cannot be trusted.");
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the Local L3 authorization profile lock.");
      }
      await delay(20);
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
};

const profileAuthorizationSemantics = (profile: L3AuthorizationProfileV2): unknown =>
  canonicalize({
    profileId: profile.profileId,
    status: profile.status,
    binding: profile.binding,
    mode: profile.mode,
    delegatedPolicy: profile.delegatedPolicy,
    limits: profile.limits
  });

export const loadLocalL3AuthorityProfileRegistry = async (
  input: LoadLocalL3AuthorityProfileRegistryInput
): Promise<LocalL3AuthorityProfileRegistry> => {
  const registryRoot = await resolveTrustedRegistryRoot(input, false);
  parseMarker(
    await readJson(path.join(registryRoot, "registry-v2.json"), "Local L3 authority registry marker")
  );
  return {
    bind: async (bindingInput) => {
      const identity = await buildLocalL3AuthorityBindingIdentity(bindingInput);
      const bindingKey = buildLocalL3AuthorityBindingKey(identity);
      const profilePath = path.join(bindingDirectory(registryRoot, bindingKey), "profile.json");
      let profile: L3AuthorizationProfileV2;
      try {
        profile = parseProfile(await readJson(profilePath, "Local L3 authorization profile"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      if (JSON.stringify(canonicalize(profile.binding)) !== JSON.stringify(canonicalize(identity))) {
        throw new Error("Local L3 authorization profile binding does not match the verified project binding.");
      }
      return { bindingKey, profile: structuredClone(profile) };
    }
  };
};

export const installLocalL3AuthorizationProfile = async (
  input: InstallLocalL3AuthorizationProfileInput
): Promise<BoundLocalL3AuthorityProfile> => {
  const registryRoot = await resolveTrustedRegistryRoot(input, true);
  await ensureRegistryMarker(registryRoot);
  const identity = await buildLocalL3AuthorityBindingIdentity(input.binding);
  if (JSON.stringify(canonicalize(input.profile.binding)) !== JSON.stringify(canonicalize(identity))) {
    throw new Error("Local L3 authorization profile binding does not match the verified project binding.");
  }
  const validation = validateL3AuthorizationProfile(input.profile);
  if (!validation.valid) {
    throw new Error(`Local L3 authorization profile is invalid: ${validation.issues[0]?.code ?? "UNKNOWN"}.`);
  }
  const bindingKey = buildLocalL3AuthorityBindingKey(identity);
  const directory = bindingDirectory(registryRoot, bindingKey);
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(directory), 0o700);
  await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await assertPrivateDirectory(directory, "Local L3 authority binding directory");
  const profilePath = path.join(directory, "profile.json");
  await withBindingLock(directory, async () => {
    let existing: L3AuthorizationProfileV2 | null = null;
    try {
      existing = parseProfile(await readJson(profilePath, "Local L3 authorization profile"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing !== null) {
      if (input.expectedProfileRevision === undefined) {
        throw new Error("expectedProfileRevision is required when replacing an existing profile.");
      }
      if (existing.profileRevision !== input.expectedProfileRevision) {
        throw new Error("Local L3 authorization profile revision conflict.");
      }
      if (input.profile.profileRevision !== existing.profileRevision + 1) {
        throw new Error("Replacement profile revision must increment by exactly one.");
      }
      const semanticsChanged =
        JSON.stringify(profileAuthorizationSemantics(existing)) !==
        JSON.stringify(profileAuthorizationSemantics(input.profile));
      const expectedModeEpoch = semanticsChanged ? existing.modeEpoch + 1 : existing.modeEpoch;
      if (input.profile.modeEpoch !== expectedModeEpoch) {
        throw new Error(
          semanticsChanged
            ? "Authorization-effective profile changes must increment modeEpoch by exactly one."
            : "Metadata-only profile changes must preserve modeEpoch."
        );
      }
    } else {
      if (input.expectedProfileRevision !== undefined) {
        throw new Error("Cannot compare-and-swap a profile that does not exist.");
      }
      if (input.profile.profileRevision !== 1 || input.profile.modeEpoch !== 1) {
        throw new Error("A new Local L3 authorization profile must start at revision 1 and modeEpoch 1.");
      }
    }
    await writeJsonAtomic(profilePath, input.profile);
  });
  return { bindingKey, profile: structuredClone(input.profile) };
};
