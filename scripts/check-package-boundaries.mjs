/* global console, process */

import { builtinModules } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
]);

const toPosix = (value) => value.replaceAll(path.sep, "/");

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8"));

const walkFiles = async (directory) => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "dist-plugin-runtime"].includes(entry.name)) continue;
      files.push(...await walkFiles(target));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }
  return files;
};

const packageNameFromSpecifier = (specifier) => {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
};

const collectModuleSpecifiers = (sourceText, filePath) => {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

const createViolation = (rule, file, target) => ({
  rule,
  file,
  target,
  fingerprint: `${rule}|${file}|${target}`
});

const isProductionSource = (relativeFile) =>
  relativeFile.includes("/src/") &&
  !relativeFile.includes("/src/testing/") &&
  !/\.(?:test|spec)\.[cm]?tsx?$/.test(relativeFile);

export const checkPackageBoundaries = async ({
  repoRoot,
  baselineFingerprints = []
}) => {
  const packagesRoot = path.join(repoRoot, "packages");
  const packageEntries = await fs.readdir(packagesRoot, { withFileTypes: true });
  const packages = [];
  for (const entry of packageEntries) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(packagesRoot, entry.name);
    const manifestPath = path.join(packageRoot, "package.json");
    try {
      const manifest = await readJson(manifestPath);
      packages.push({ directoryName: entry.name, packageRoot, manifest });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const allViolations = [];
  const packageForResolvedPath = (resolvedPath) =>
    packages.find(
      (candidate) =>
        resolvedPath === candidate.packageRoot ||
        resolvedPath.startsWith(`${candidate.packageRoot}${path.sep}`)
    );

  for (const owner of packages) {
    const files = await walkFiles(owner.packageRoot);
    for (const configPath of files.filter((file) => /^tsconfig.*\.json$/.test(path.basename(file)))) {
      const config = await readJson(configPath);
      for (const include of config.include ?? []) {
        const resolvedInclude = path.resolve(path.dirname(configPath), include);
        const targetPackage = packageForResolvedPath(resolvedInclude);
        if (targetPackage !== undefined && targetPackage !== owner) {
          const file = toPosix(path.relative(repoRoot, configPath));
          allViolations.push(
            createViolation("TSCONFIG_CROSS_PACKAGE_INCLUDE", file, include)
          );
        }
      }
    }

    const dependencyNames = new Set([
      ...Object.keys(owner.manifest.dependencies ?? {}),
      ...Object.keys(owner.manifest.peerDependencies ?? {}),
      ...Object.keys(owner.manifest.optionalDependencies ?? {})
    ]);
    for (const sourcePath of files.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))) {
      const relativeFile = toPosix(path.relative(repoRoot, sourcePath));
      const production = isProductionSource(relativeFile);
      const sourceText = await fs.readFile(sourcePath, "utf8");
      for (const specifier of collectModuleSpecifiers(sourceText, sourcePath)) {
        if (specifier.startsWith(".")) {
          const resolvedImport = path.resolve(path.dirname(sourcePath), specifier);
          const targetPackage = packageForResolvedPath(resolvedImport);
          if (targetPackage !== undefined && targetPackage !== owner) {
            allViolations.push(
              createViolation("CROSS_PACKAGE_RELATIVE_IMPORT", relativeFile, specifier)
            );
          }
          continue;
        }
        if (!production || BUILTIN_MODULES.has(specifier)) continue;
        const dependencyName = packageNameFromSpecifier(specifier);
        if (!dependencyNames.has(dependencyName)) {
          allViolations.push(
            createViolation("UNDECLARED_BARE_DEPENDENCY", relativeFile, dependencyName)
          );
        }
      }
    }
  }

  const baseline = new Set(baselineFingerprints);
  const currentFingerprints = new Set(allViolations.map((violation) => violation.fingerprint));
  return {
    violations: allViolations.filter((violation) => !baseline.has(violation.fingerprint)),
    staleBaselineFingerprints: [...baseline]
      .filter((fingerprint) => !currentFingerprints.has(fingerprint))
      .sort()
  };
};

const runCli = async () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const baselinePath = path.join(repoRoot, "scripts/testing/package-boundary-baseline.json");
  const baseline = await readJson(baselinePath);
  const result = await checkPackageBoundaries({
    repoRoot,
    baselineFingerprints: baseline.fingerprints
  });
  for (const violation of result.violations) {
    console.error(`${violation.rule}: ${violation.file} -> ${violation.target}`);
  }
  for (const fingerprint of result.staleBaselineFingerprints) {
    console.error(`STALE_PACKAGE_BOUNDARY_BASELINE: ${fingerprint}`);
  }
  if (result.violations.length > 0 || result.staleBaselineFingerprints.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("Package boundary checks passed.");
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await runCli();
}
