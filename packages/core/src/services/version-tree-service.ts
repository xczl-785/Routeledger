import type { Actor } from "../domain/actor.js";
import { DomainError } from "../domain/errors.js";
import type { TransitionEventDraft } from "../domain/transition-event.js";
import type { Version } from "../domain/version.js";

export const VERSION_TREE_ACTION_TYPES = [
  "create_version",
  "insert_version",
  "create_child_version",
  "reorder_versions"
] as const;

export type VersionTreeActionType = (typeof VERSION_TREE_ACTION_TYPES)[number];

export interface VersionTreePayload {
  title?: string;
  description?: string;
  parentVersionId?: string | null;
  previousVersionId?: string | null;
  nextVersionId?: string | null;
  siblingVersionIds?: string[];
}

export interface NormalizeVersionTreePayloadInput {
  versions: Version[];
  actionType: VersionTreeActionType;
  targetId: string;
  payload: VersionTreePayload;
}

export interface ApplyVersionTreeMutationInput {
  versions: Version[];
  actionType: VersionTreeActionType;
  targetId: string;
  payload: VersionTreePayload;
  actor: Actor;
  now: string;
}

export interface ApplyVersionTreeMutationResult {
  versions: Version[];
  eventDrafts: TransitionEventDraft[];
}

type OrderedTree = {
  orderedByParent: Map<string | null, Version[]>;
  traversal: Version[];
  versionMap: Map<string, Version>;
};

const TREE_FIELDS = [
  "parentVersionId",
  "previousVersionId",
  "nextVersionId",
  "order",
  "updatedAt"
] as const;

const normalizeText = (value: string | undefined, field: string): string => {
  const normalized = value?.trim() ?? "";

  if (normalized.length === 0) {
    throw new DomainError("MISSING_REQUIRED_FIELD", `${field} 不能为空`, {
      field
    });
  }

  return normalized;
};

const normalizeOptionalText = (value: string | undefined): string => value?.trim() ?? "";

const buildOrderedTree = (versions: Version[]): OrderedTree => {
  const versionMap = new Map<string, Version>();

  for (const version of versions) {
    if (versionMap.has(version.id)) {
      throw new DomainError("INVALID_VERSION_TRANSITION", "version id 不允许重复", {
        versionId: version.id
      });
    }

    versionMap.set(version.id, version);
  }

  for (const version of versions) {
    if (version.parentVersionId === version.id) {
      throw new DomainError("INVALID_VERSION_TRANSITION", "version 不允许将自己设为 parent", {
        versionId: version.id
      });
    }

    if (version.previousVersionId === version.id || version.nextVersionId === version.id) {
      throw new DomainError("INVALID_VERSION_TRANSITION", "version 不允许自引用 sibling 指针", {
        versionId: version.id
      });
    }

    if (version.parentVersionId !== null && !versionMap.has(version.parentVersionId)) {
      throw new DomainError("PROJECT_VERSION_MISMATCH", "parent version 不存在", {
        versionId: version.id,
        parentVersionId: version.parentVersionId
      });
    }

    if (version.previousVersionId !== null && !versionMap.has(version.previousVersionId)) {
      throw new DomainError("PROJECT_VERSION_MISMATCH", "previous version 不存在", {
        versionId: version.id,
        previousVersionId: version.previousVersionId
      });
    }

    if (version.nextVersionId !== null && !versionMap.has(version.nextVersionId)) {
      throw new DomainError("PROJECT_VERSION_MISMATCH", "next version 不存在", {
        versionId: version.id,
        nextVersionId: version.nextVersionId
      });
    }
  }

  const unorderedByParent = new Map<string | null, Version[]>();

  for (const version of versions) {
    const siblings = unorderedByParent.get(version.parentVersionId) ?? [];
    siblings.push(version);
    unorderedByParent.set(version.parentVersionId, siblings);
  }

  const orderedByParent = new Map<string | null, Version[]>();

  for (const [parentVersionId, siblings] of unorderedByParent.entries()) {
    for (const sibling of siblings) {
      if (sibling.previousVersionId !== null) {
        const previous = versionMap.get(sibling.previousVersionId)!;

        if (previous.parentVersionId !== parentVersionId) {
          throw new DomainError("PROJECT_VERSION_MISMATCH", "previous version 必须属于同一 parent", {
            versionId: sibling.id,
            parentVersionId,
            previousVersionId: previous.id
          });
        }

        if (previous.nextVersionId !== sibling.id) {
          throw new DomainError("INVALID_VERSION_TRANSITION", "previous/next sibling 指针不一致", {
            versionId: sibling.id,
            previousVersionId: previous.id,
            previousNextVersionId: previous.nextVersionId
          });
        }
      }

      if (sibling.nextVersionId !== null) {
        const next = versionMap.get(sibling.nextVersionId)!;

        if (next.parentVersionId !== parentVersionId) {
          throw new DomainError("PROJECT_VERSION_MISMATCH", "next version 必须属于同一 parent", {
            versionId: sibling.id,
            parentVersionId,
            nextVersionId: next.id
          });
        }

        if (next.previousVersionId !== sibling.id) {
          throw new DomainError("INVALID_VERSION_TRANSITION", "next/previous sibling 指针不一致", {
            versionId: sibling.id,
            nextVersionId: next.id,
            nextPreviousVersionId: next.previousVersionId
          });
        }
      }
    }

    const heads = siblings.filter((sibling) => sibling.previousVersionId === null);

    if (heads.length !== 1) {
      throw new DomainError("INVALID_VERSION_TRANSITION", "同 parent 下必须存在且仅存在一个 sibling head", {
        parentVersionId,
        headCount: heads.length,
        siblingIds: siblings.map((sibling) => sibling.id)
      });
    }

    const orderedSiblings: Version[] = [];
    const seen = new Set<string>();
    let current: Version | undefined = heads[0];

    while (current !== undefined) {
      if (seen.has(current.id)) {
        throw new DomainError("INVALID_VERSION_TRANSITION", "version sibling 链存在环", {
          parentVersionId,
          versionId: current.id
        });
      }

      seen.add(current.id);
      orderedSiblings.push(current);
      current = current.nextVersionId === null ? undefined : versionMap.get(current.nextVersionId);
    }

    if (orderedSiblings.length !== siblings.length) {
      throw new DomainError("INVALID_VERSION_TRANSITION", "version sibling 链存在缺失或重复节点", {
        parentVersionId,
        orderedIds: orderedSiblings.map((sibling) => sibling.id),
        siblingIds: siblings.map((sibling) => sibling.id)
      });
    }

    orderedByParent.set(parentVersionId, orderedSiblings);
  }

  const traversal: Version[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visitVersion = (version: Version): void => {
    if (visiting.has(version.id)) {
      throw new DomainError("INVALID_VERSION_TRANSITION", "version tree 存在 parent/child 环", {
        versionId: version.id
      });
    }

    if (visited.has(version.id)) {
      throw new DomainError("INVALID_VERSION_TRANSITION", "version tree 节点重复访问", {
        versionId: version.id
      });
    }

    visiting.add(version.id);
    traversal.push(version);

    for (const child of orderedByParent.get(version.id) ?? []) {
      visitVersion(child);
    }

    visiting.delete(version.id);
    visited.add(version.id);
  };

  for (const root of orderedByParent.get(null) ?? []) {
    visitVersion(root);
  }

  if (visited.size !== versions.length) {
    throw new DomainError("INVALID_VERSION_TRANSITION", "version tree 存在无根节点或 parent 环", {
      visitedIds: [...visited],
      allVersionIds: versions.map((version) => version.id)
    });
  }

  return {
    orderedByParent,
    traversal,
    versionMap
  };
};

const requireExistingVersion = (tree: OrderedTree, versionId: string, field: string): Version => {
  const version = tree.versionMap.get(versionId);

  if (version === undefined) {
    throw new DomainError("PROJECT_VERSION_MISMATCH", `${field} 指向的 version 不存在`, {
      field,
      versionId
    });
  }

  return version;
};

const requireNewTargetId = (tree: OrderedTree, targetId: string): void => {
  if (tree.versionMap.has(targetId)) {
    throw new DomainError("INVALID_VERSION_TRANSITION", "新 version targetId 已存在", {
      targetId
    });
  }
};

const assertAnchorIsMutable = (version: Version, field: string): void => {
  if (version.state === "close") {
    throw new DomainError("INVALID_VERSION_TRANSITION", "close version 的邻接关系不可改动", {
      field,
      versionId: version.id
    });
  }
};

const assertParentAllowsChildren = (parentVersion: Version): void => {
  if (parentVersion.state === "close") {
    throw new DomainError("INVALID_VERSION_TRANSITION", "close version 不允许新增 child", {
      parentVersionId: parentVersion.id
    });
  }
};

const requireSiblingList = (tree: OrderedTree, parentVersionId: string | null): Version[] =>
  (tree.orderedByParent.get(parentVersionId) ?? []).slice();

const buildNormalizedSiblingScope = (siblings: Version[]): string[] => siblings.map((item) => item.id);

const normalizeSiblingInsert = (options: {
  siblings: Version[];
  previousVersionId: string | null;
  nextVersionId: string | null;
  parentVersionId: string | null;
  targetId: string;
}): {
  parentVersionId: string | null;
  previousVersionId: string | null;
  nextVersionId: string | null;
  siblingVersionIds: string[];
} => {
  const { siblings, previousVersionId, nextVersionId, parentVersionId, targetId } = options;

  if (previousVersionId === null && nextVersionId === null) {
    throw new DomainError("MISSING_REQUIRED_FIELD", "previousVersionId / nextVersionId 至少需要一项", {
      targetId
    });
  }

  if (previousVersionId !== null && nextVersionId !== null && previousVersionId === nextVersionId) {
    throw new DomainError("INVALID_VERSION_TRANSITION", "previousVersionId 与 nextVersionId 不能相同", {
      targetId,
      previousVersionId,
      nextVersionId
    });
  }

  const previousIndex =
    previousVersionId === null
      ? -1
      : siblings.findIndex((version) => version.id === previousVersionId);
  const nextIndex =
    nextVersionId === null ? -1 : siblings.findIndex((version) => version.id === nextVersionId);

  if (previousVersionId !== null && previousIndex === -1) {
    throw new DomainError("PROJECT_VERSION_MISMATCH", "previousVersionId 不属于当前 sibling 范围", {
      targetId,
      previousVersionId,
      parentVersionId
    });
  }

  if (nextVersionId !== null && nextIndex === -1) {
    throw new DomainError("PROJECT_VERSION_MISMATCH", "nextVersionId 不属于当前 sibling 范围", {
      targetId,
      nextVersionId,
      parentVersionId
    });
  }

  if (previousIndex !== -1) {
    assertAnchorIsMutable(siblings[previousIndex]!, "previousVersionId");
  }

  if (nextIndex !== -1) {
    assertAnchorIsMutable(siblings[nextIndex]!, "nextVersionId");
  }

  if (previousIndex !== -1 && nextIndex !== -1 && previousIndex + 1 !== nextIndex) {
    throw new DomainError("INVALID_VERSION_TRANSITION", "双锚必须相邻", {
      targetId,
      previousVersionId,
      nextVersionId,
      parentVersionId
    });
  }

  return {
    parentVersionId,
    previousVersionId,
    nextVersionId,
    siblingVersionIds: buildNormalizedSiblingScope(siblings)
  };
};

const normalizeCreateVersionPayload = (
  tree: OrderedTree,
  targetId: string,
  payload: VersionTreePayload
): VersionTreePayload => {
  requireNewTargetId(tree, targetId);
  const siblings = requireSiblingList(tree, null);
  const previous = siblings.at(-1) ?? null;

  if (previous !== null) {
    assertAnchorIsMutable(previous, "previousVersionId");
  }

  return {
    title: normalizeText(payload.title, "title"),
    description: normalizeOptionalText(payload.description),
    parentVersionId: null,
    previousVersionId: previous?.id ?? null,
    nextVersionId: null,
    siblingVersionIds: buildNormalizedSiblingScope(siblings)
  };
};

const normalizeInsertVersionPayload = (
  tree: OrderedTree,
  targetId: string,
  payload: VersionTreePayload
): VersionTreePayload => {
  requireNewTargetId(tree, targetId);
  const previous =
    payload.previousVersionId === undefined || payload.previousVersionId === null
      ? null
      : requireExistingVersion(tree, payload.previousVersionId, "previousVersionId");
  const next =
    payload.nextVersionId === undefined || payload.nextVersionId === null
      ? null
      : requireExistingVersion(tree, payload.nextVersionId, "nextVersionId");

  if (previous !== null && next !== null && previous.parentVersionId !== next.parentVersionId) {
    throw new DomainError("PROJECT_VERSION_MISMATCH", "双锚必须属于同一 parent", {
      targetId,
      previousVersionId: previous.id,
      nextVersionId: next.id
    });
  }

  const parentVersionId = previous?.parentVersionId ?? next?.parentVersionId ?? null;
  const siblings = requireSiblingList(tree, parentVersionId);
  const normalized = normalizeSiblingInsert({
    siblings,
    previousVersionId: previous?.id ?? null,
    nextVersionId: next?.id ?? null,
    parentVersionId,
    targetId
  });

  return {
    title: normalizeText(payload.title, "title"),
    description: normalizeOptionalText(payload.description),
    parentVersionId: normalized.parentVersionId,
    previousVersionId: normalized.previousVersionId,
    nextVersionId: normalized.nextVersionId,
    siblingVersionIds: normalized.siblingVersionIds
  };
};

const normalizeCreateChildVersionPayload = (
  tree: OrderedTree,
  targetId: string,
  payload: VersionTreePayload
): VersionTreePayload => {
  requireNewTargetId(tree, targetId);

  if (payload.parentVersionId === undefined || payload.parentVersionId === null) {
    throw new DomainError("MISSING_REQUIRED_FIELD", "create_child_version 必须传 parentVersionId", {
      targetId
    });
  }

  const parentVersion = requireExistingVersion(tree, payload.parentVersionId, "parentVersionId");
  assertParentAllowsChildren(parentVersion);
  const siblings = requireSiblingList(tree, parentVersion.id);

  if (
    (payload.previousVersionId === undefined || payload.previousVersionId === null) &&
    (payload.nextVersionId === undefined || payload.nextVersionId === null)
  ) {
    const previous = siblings.at(-1) ?? null;

    if (previous !== null) {
      assertAnchorIsMutable(previous, "previousVersionId");
    }

    return {
      title: normalizeText(payload.title, "title"),
      description: normalizeOptionalText(payload.description),
      parentVersionId: parentVersion.id,
      previousVersionId: previous?.id ?? null,
      nextVersionId: null,
      siblingVersionIds: buildNormalizedSiblingScope(siblings)
    };
  }

  const previous =
    payload.previousVersionId === undefined || payload.previousVersionId === null
      ? null
      : requireExistingVersion(tree, payload.previousVersionId, "previousVersionId");
  const next =
    payload.nextVersionId === undefined || payload.nextVersionId === null
      ? null
      : requireExistingVersion(tree, payload.nextVersionId, "nextVersionId");

  if (previous !== null && previous.parentVersionId !== parentVersion.id) {
    throw new DomainError("PROJECT_VERSION_MISMATCH", "previousVersionId 必须属于 parent 的 children", {
      targetId,
      parentVersionId: parentVersion.id,
      previousVersionId: previous.id
    });
  }

  if (next !== null && next.parentVersionId !== parentVersion.id) {
    throw new DomainError("PROJECT_VERSION_MISMATCH", "nextVersionId 必须属于 parent 的 children", {
      targetId,
      parentVersionId: parentVersion.id,
      nextVersionId: next.id
    });
  }

  const normalized = normalizeSiblingInsert({
    siblings,
    previousVersionId: previous?.id ?? null,
    nextVersionId: next?.id ?? null,
    parentVersionId: parentVersion.id,
    targetId
  });

  return {
    title: normalizeText(payload.title, "title"),
    description: normalizeOptionalText(payload.description),
    parentVersionId: normalized.parentVersionId,
    previousVersionId: normalized.previousVersionId,
    nextVersionId: normalized.nextVersionId,
    siblingVersionIds: normalized.siblingVersionIds
  };
};

const normalizeReorderPayload = (
  tree: OrderedTree,
  targetId: string,
  payload: VersionTreePayload
): VersionTreePayload => {
  const targetVersion = requireExistingVersion(tree, targetId, "targetId");

  if (targetVersion.state === "close") {
    throw new DomainError("INVALID_VERSION_TRANSITION", "close version 不允许 reorder", {
      targetId
    });
  }

  if (targetVersion.previousVersionId !== null) {
    assertAnchorIsMutable(
      requireExistingVersion(tree, targetVersion.previousVersionId, "previousVersionId"),
      "previousVersionId"
    );
  }

  if (targetVersion.nextVersionId !== null) {
    assertAnchorIsMutable(
      requireExistingVersion(tree, targetVersion.nextVersionId, "nextVersionId"),
      "nextVersionId"
    );
  }

  const previous =
    payload.previousVersionId === undefined || payload.previousVersionId === null
      ? null
      : requireExistingVersion(tree, payload.previousVersionId, "previousVersionId");
  const next =
    payload.nextVersionId === undefined || payload.nextVersionId === null
      ? null
      : requireExistingVersion(tree, payload.nextVersionId, "nextVersionId");

  if (previous !== null && previous.id === targetId) {
    throw new DomainError("INVALID_VERSION_TRANSITION", "previousVersionId 不允许等于目标 version", {
      targetId
    });
  }

  if (next !== null && next.id === targetId) {
    throw new DomainError("INVALID_VERSION_TRANSITION", "nextVersionId 不允许等于目标 version", {
      targetId
    });
  }

  if (previous !== null && previous.parentVersionId !== targetVersion.parentVersionId) {
    throw new DomainError("PROJECT_VERSION_MISMATCH", "reorder 只允许同 parent 内移动", {
      targetId,
      targetParentVersionId: targetVersion.parentVersionId,
      previousVersionId: previous.id,
      previousParentVersionId: previous.parentVersionId
    });
  }

  if (next !== null && next.parentVersionId !== targetVersion.parentVersionId) {
    throw new DomainError("PROJECT_VERSION_MISMATCH", "reorder 只允许同 parent 内移动", {
      targetId,
      targetParentVersionId: targetVersion.parentVersionId,
      nextVersionId: next.id,
      nextParentVersionId: next.parentVersionId
    });
  }

  const siblings = requireSiblingList(tree, targetVersion.parentVersionId);
  const siblingsWithoutTarget = siblings.filter((version) => version.id !== targetId);
  const normalized = normalizeSiblingInsert({
    siblings: siblingsWithoutTarget,
    previousVersionId: previous?.id ?? null,
    nextVersionId: next?.id ?? null,
    parentVersionId: targetVersion.parentVersionId,
    targetId
  });

  return {
    parentVersionId: targetVersion.parentVersionId,
    previousVersionId: normalized.previousVersionId,
    nextVersionId: normalized.nextVersionId,
    siblingVersionIds: buildNormalizedSiblingScope(siblings)
  };
};

export const normalizeVersionTreePayload = (
  input: NormalizeVersionTreePayloadInput
): VersionTreePayload => {
  const tree = buildOrderedTree(input.versions);

  switch (input.actionType) {
    case "create_version":
      return normalizeCreateVersionPayload(tree, input.targetId, input.payload);
    case "insert_version":
      return normalizeInsertVersionPayload(tree, input.targetId, input.payload);
    case "create_child_version":
      return normalizeCreateChildVersionPayload(tree, input.targetId, input.payload);
    case "reorder_versions":
      return normalizeReorderPayload(tree, input.targetId, input.payload);
    default: {
      const exhaustiveActionType: never = input.actionType;
      return exhaustiveActionType;
    }
  }
};

const insertSibling = (
  siblings: Version[],
  version: Version,
  previousVersionId: string | null,
  nextVersionId: string | null
): Version[] => {
  if (previousVersionId !== null) {
    const previousIndex = siblings.findIndex((item) => item.id === previousVersionId);
    return siblings
      .slice(0, previousIndex + 1)
      .concat(version)
      .concat(siblings.slice(previousIndex + 1));
  }

  if (nextVersionId !== null) {
    const nextIndex = siblings.findIndex((item) => item.id === nextVersionId);
    return siblings.slice(0, nextIndex).concat(version).concat(siblings.slice(nextIndex));
  }

  return siblings.concat(version);
};

const rebuildVersions = (
  originalVersions: Version[],
  orderedByParent: Map<string | null, Version[]>,
  now: string
): Version[] => {
  const originalMap = new Map(originalVersions.map((version) => [version.id, version]));
  const rebuilt = new Map<string, Version>();
  let order = 1;

  const visitParent = (parentVersionId: string | null): void => {
    const siblings = orderedByParent.get(parentVersionId) ?? [];

    for (let index = 0; index < siblings.length; index += 1) {
      const sibling = siblings[index]!;
      const previousVersionId = siblings[index - 1]?.id ?? null;
      const nextVersionId = siblings[index + 1]?.id ?? null;
      const original = originalMap.get(sibling.id);
      const treeUpdated =
        original === undefined ||
        original.parentVersionId !== parentVersionId ||
        original.previousVersionId !== previousVersionId ||
        original.nextVersionId !== nextVersionId ||
        original.order !== order;

      const nextVersion: Version = {
        ...sibling,
        parentVersionId,
        previousVersionId,
        nextVersionId,
        order,
        updatedAt: treeUpdated ? now : sibling.updatedAt
      };

      rebuilt.set(nextVersion.id, nextVersion);
      order += 1;
      visitParent(nextVersion.id);
    }
  };

  visitParent(null);

  return [...rebuilt.values()].sort((left, right) => left.order - right.order);
};

const createTreeChangeMetadata = (before: Version, after: Version) => ({
  before: {
    parentVersionId: before.parentVersionId,
    previousVersionId: before.previousVersionId,
    nextVersionId: before.nextVersionId,
    order: before.order
  },
  after: {
    parentVersionId: after.parentVersionId,
    previousVersionId: after.previousVersionId,
    nextVersionId: after.nextVersionId,
    order: after.order
  }
});

const buildEventDrafts = (
  beforeVersions: Version[],
  afterVersions: Version[],
  actionType: VersionTreeActionType
): TransitionEventDraft[] => {
  const beforeMap = new Map(beforeVersions.map((version) => [version.id, version]));
  const drafts: TransitionEventDraft[] = [];

  for (const version of afterVersions) {
    const previous = beforeMap.get(version.id);

    if (previous === undefined) {
      drafts.push({
        targetType: "version",
        targetId: version.id,
        eventType: "version.created",
        toState: version.state,
        metadata: {
          actionType,
          parentVersionId: version.parentVersionId,
          previousVersionId: version.previousVersionId,
          nextVersionId: version.nextVersionId,
          order: version.order,
          isCurrent: version.isCurrent
        }
      });
      continue;
    }

    if (
      TREE_FIELDS.some((field) => previous[field] !== version[field])
    ) {
      drafts.push({
        targetType: "version",
        targetId: version.id,
        eventType: "version.tree_changed",
        metadata: {
          actionType,
          ...createTreeChangeMetadata(previous, version)
        }
      });
    }
  }

  return drafts;
};

export const applyVersionTreeMutation = (
  input: ApplyVersionTreeMutationInput
): ApplyVersionTreeMutationResult => {
  const normalizedPayload = normalizeVersionTreePayload({
    versions: input.versions,
    actionType: input.actionType,
    targetId: input.targetId,
    payload: input.payload
  });
  const tree = buildOrderedTree(input.versions);
  const orderedByParent = new Map<string | null, Version[]>(
    [...tree.orderedByParent.entries()].map(([parentVersionId, siblings]) => [
      parentVersionId,
      siblings.slice()
    ])
  );

  switch (input.actionType) {
    case "create_version":
    case "insert_version":
    case "create_child_version": {
      const parentVersionId = normalizedPayload.parentVersionId ?? null;
      const siblings = orderedByParent.get(parentVersionId) ?? [];
      const createdVersion: Version = {
        id: input.targetId,
        projectId: input.versions[0]!.projectId,
        title: normalizedPayload.title!,
        description: normalizedPayload.description ?? "",
        state: "wait",
        parentVersionId,
        previousVersionId: null,
        nextVersionId: null,
        order: 0,
        isCurrent: false,
        createdBy: input.actor,
        createdAt: input.now,
        updatedAt: input.now,
        closedAt: null,
        stateReason: null
      };

      orderedByParent.set(
        parentVersionId,
        insertSibling(
          siblings,
          createdVersion,
          normalizedPayload.previousVersionId ?? null,
          normalizedPayload.nextVersionId ?? null
        )
      );
      break;
    }
    case "reorder_versions": {
      const targetVersion = requireExistingVersion(tree, input.targetId, "targetId");
      const parentVersionId = targetVersion.parentVersionId;
      const siblings = (orderedByParent.get(parentVersionId) ?? []).filter(
        (version) => version.id !== targetVersion.id
      );

      orderedByParent.set(
        parentVersionId,
        insertSibling(
          siblings,
          targetVersion,
          normalizedPayload.previousVersionId ?? null,
          normalizedPayload.nextVersionId ?? null
        )
      );
      break;
    }
    default: {
      const exhaustiveActionType: never = input.actionType;
      return exhaustiveActionType;
    }
  }

  const nextVersions = rebuildVersions(input.versions, orderedByParent, input.now);

  return {
    versions: nextVersions,
    eventDrafts: buildEventDrafts(input.versions, nextVersions, input.actionType)
  };
};
