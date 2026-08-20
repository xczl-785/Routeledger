import fs from "node:fs";
import path from "node:path";
import { PROJECT_DOCUMENT_PATH } from "../../json/src/index.js";
import { ROUTELEDGER_DB_DIRECTORY, ROUTELEDGER_DB_FILENAME, ROUTELEDGER_DIRECTORY } from "./storage-paths.js";
import { isPhysicalPathContainedWithinSync } from "./physical-path.js";
export const WORKSPACE_CONFIG_VERSION = 1;
export const WORKSPACE_CONFIG_FILENAME = "config.json";
export const DEFAULT_WORKSPACE_DATA_DIR = ".";
export const ROUTELEDGER_GIT_ATTRIBUTES_FILENAME = ".gitattributes";
export const ROUTELEDGER_GIT_ATTRIBUTES_CONTENT = "*.json text eol=lf\n" +
    "**/*.json text eol=lf\n" +
    "events/** linguist-generated=true\n" +
    "ordinary_write_receipts/** linguist-generated=true\n" +
    "approval_artifacts/** linguist-generated=true\n" +
    "pending_operations/** linguist-generated=true\n" +
    "operations/** linguist-generated=true\n" +
    "audit_packs/** linguist-generated=true\n";
const normalizeWorkspaceRoot = (workspaceRoot) => workspaceRoot;
export const getWorkspaceConfigDirectory = (workspaceRoot) => path.join(normalizeWorkspaceRoot(workspaceRoot), ROUTELEDGER_DIRECTORY);
export const getWorkspaceConfigPath = (workspaceRoot) => path.join(getWorkspaceConfigDirectory(workspaceRoot), WORKSPACE_CONFIG_FILENAME);
export const resolveDefaultRouteLedgerDataDir = (workspaceRoot) => path.resolve(normalizeWorkspaceRoot(workspaceRoot), DEFAULT_WORKSPACE_DATA_DIR);
const buildResolution = (workspaceRoot, dataRoot, config, status, diagnostics) => ({
    status,
    workspaceRoot,
    workspaceConfigPath: getWorkspaceConfigPath(workspaceRoot),
    dataRoot,
    routeledgerDir: path.join(dataRoot, ROUTELEDGER_DIRECTORY),
    jsonProjectPath: path.resolve(dataRoot, PROJECT_DOCUMENT_PATH),
    sqliteDbPath: path.join(dataRoot, ROUTELEDGER_DB_DIRECTORY, ROUTELEDGER_DB_FILENAME),
    config,
    diagnostics
});
const writeWorkspaceConfig = (workspaceRoot, dataDir) => {
    const configDirectory = getWorkspaceConfigDirectory(workspaceRoot);
    const configPath = getWorkspaceConfigPath(workspaceRoot);
    fs.mkdirSync(configDirectory, { recursive: true });
    ensureRouteLedgerGitAttributes(configDirectory);
    if (fs.existsSync(configPath)) {
        return;
    }
    fs.writeFileSync(configPath, `${JSON.stringify({
        version: WORKSPACE_CONFIG_VERSION,
        dataDir
    }, null, 2)}\n`, "utf8");
};
export const ensureRouteLedgerGitAttributes = (routeledgerDirectory) => {
    fs.mkdirSync(routeledgerDirectory, { recursive: true });
    const attributesPath = path.join(routeledgerDirectory, ROUTELEDGER_GIT_ATTRIBUTES_FILENAME);
    if (!fs.existsSync(attributesPath)) {
        fs.writeFileSync(attributesPath, ROUTELEDGER_GIT_ATTRIBUTES_CONTENT, "utf8");
        return;
    }
    const currentContent = fs.readFileSync(attributesPath, "utf8").replaceAll("\r\n", "\n");
    const currentLines = new Set(currentContent.split("\n").filter((line) => line.length > 0));
    const missingLines = ROUTELEDGER_GIT_ATTRIBUTES_CONTENT
        .split("\n")
        .filter((line) => line.length > 0 && !currentLines.has(line));
    if (missingLines.length === 0)
        return;
    const separator = currentContent.length === 0 || currentContent.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(attributesPath, `${currentContent}${separator}${missingLines.join("\n")}\n`, "utf8");
};
const toInvalidResolution = (workspaceRoot, diagnostics) => buildResolution(workspaceRoot, resolveDefaultRouteLedgerDataDir(workspaceRoot), null, "invalid", diagnostics);
const parseWorkspaceConfig = (workspaceRoot, rawContent) => {
    let parsed;
    try {
        parsed = JSON.parse(rawContent);
    }
    catch (error) {
        return toInvalidResolution(workspaceRoot, [
            {
                code: "WORKSPACE_CONFIG_MALFORMED_JSON",
                severity: "error",
                message: error instanceof Error
                    ? `${getWorkspaceConfigPath(workspaceRoot)} contains malformed JSON: ${error.message}`
                    : `${getWorkspaceConfigPath(workspaceRoot)} contains malformed JSON.`
            }
        ]);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return toInvalidResolution(workspaceRoot, [
            {
                code: "WORKSPACE_CONFIG_INVALID_SCHEMA",
                severity: "error",
                message: `${getWorkspaceConfigPath(workspaceRoot)} must contain a JSON object.`
            }
        ]);
    }
    const configRecord = parsed;
    if (!Object.prototype.hasOwnProperty.call(configRecord, "dataDir")) {
        return toInvalidResolution(workspaceRoot, [
            {
                code: "WORKSPACE_CONFIG_DATA_DIR_MISSING",
                severity: "error",
                message: `${getWorkspaceConfigPath(workspaceRoot)} must define dataDir.`
            }
        ]);
    }
    if (typeof configRecord.dataDir !== "string") {
        return toInvalidResolution(workspaceRoot, [
            {
                code: "WORKSPACE_CONFIG_INVALID_SCHEMA",
                severity: "error",
                message: `${getWorkspaceConfigPath(workspaceRoot)} dataDir must be a string.`
            }
        ]);
    }
    if (configRecord.dataDir.trim().length === 0) {
        return toInvalidResolution(workspaceRoot, [
            {
                code: "WORKSPACE_CONFIG_DATA_DIR_EMPTY",
                severity: "error",
                message: `${getWorkspaceConfigPath(workspaceRoot)} dataDir must be a non-empty string.`
            }
        ]);
    }
    if (configRecord.version !== WORKSPACE_CONFIG_VERSION) {
        return toInvalidResolution(workspaceRoot, [
            {
                code: "WORKSPACE_CONFIG_INVALID_SCHEMA",
                severity: "error",
                message: `${getWorkspaceConfigPath(workspaceRoot)} version must equal ${WORKSPACE_CONFIG_VERSION}.`
            }
        ]);
    }
    if (path.isAbsolute(configRecord.dataDir)) {
        return toInvalidResolution(workspaceRoot, [
            {
                code: "WORKSPACE_CONFIG_DATA_DIR_ABSOLUTE",
                severity: "error",
                message: `${getWorkspaceConfigPath(workspaceRoot)} dataDir must be workspace-relative, not absolute.`
            }
        ]);
    }
    const dataRootInput = `${workspaceRoot}${path.sep}${configRecord.dataDir}`;
    if (!isPhysicalPathContainedWithinSync(workspaceRoot, dataRootInput)) {
        return toInvalidResolution(workspaceRoot, [
            {
                code: "WORKSPACE_CONFIG_DATA_DIR_OUTSIDE_WORKSPACE",
                severity: "error",
                message: `${getWorkspaceConfigPath(workspaceRoot)} dataDir must stay within workspaceRoot.`
            }
        ]);
    }
    const dataRoot = path.resolve(workspaceRoot, configRecord.dataDir);
    try {
        const stat = fs.statSync(dataRoot);
        if (!stat.isDirectory()) {
            return toInvalidResolution(workspaceRoot, [
                {
                    code: "ROUTELEDGER_DATA_DIR_NOT_DIRECTORY",
                    severity: "error",
                    message: `${dataRoot} exists but is not a directory.`
                }
            ]);
        }
        fs.accessSync(dataRoot, fs.constants.R_OK | fs.constants.W_OK);
    }
    catch (error) {
        const errorCode = typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : null;
        if (errorCode === "ENOENT") {
            return toInvalidResolution(workspaceRoot, [
                {
                    code: "ROUTELEDGER_DATA_DIR_NOT_FOUND",
                    severity: "error",
                    message: `${dataRoot} does not exist.`
                }
            ]);
        }
        if (errorCode === "EACCES" || errorCode === "EPERM") {
            return toInvalidResolution(workspaceRoot, [
                {
                    code: "ROUTELEDGER_DATA_DIR_PERMISSION_DENIED",
                    severity: "error",
                    message: `${dataRoot} is not accessible with the required permissions.`
                }
            ]);
        }
        return toInvalidResolution(workspaceRoot, [
            {
                code: "ROUTELEDGER_DATA_DIR_UNREADABLE",
                severity: "error",
                message: `${dataRoot} is not readable.`
            }
        ]);
    }
    return buildResolution(workspaceRoot, dataRoot, {
        version: WORKSPACE_CONFIG_VERSION,
        dataDir: configRecord.dataDir
    }, "ready", []);
};
export const resolveWorkspaceConfigSync = (options) => {
    const workspaceRoot = normalizeWorkspaceRoot(options.projectRoot);
    const configPath = getWorkspaceConfigPath(workspaceRoot);
    if (!fs.existsSync(configPath)) {
        if (options.autoCreate === true) {
            writeWorkspaceConfig(workspaceRoot, options.defaultDataDir ?? DEFAULT_WORKSPACE_DATA_DIR);
        }
        else {
            return buildResolution(workspaceRoot, resolveDefaultRouteLedgerDataDir(workspaceRoot), null, "missing", [
                {
                    code: "WORKSPACE_CONFIG_NOT_FOUND",
                    severity: "warning",
                    message: `${configPath} does not exist.`
                }
            ]);
        }
    }
    if (options.autoCreate === true) {
        ensureRouteLedgerGitAttributes(getWorkspaceConfigDirectory(workspaceRoot));
    }
    try {
        const content = fs.readFileSync(configPath, "utf8");
        return parseWorkspaceConfig(workspaceRoot, content);
    }
    catch (error) {
        const errorCode = typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : null;
        if (errorCode === "ENOENT" && options.autoCreate !== true) {
            return buildResolution(workspaceRoot, resolveDefaultRouteLedgerDataDir(workspaceRoot), null, "missing", [
                {
                    code: "WORKSPACE_CONFIG_NOT_FOUND",
                    severity: "warning",
                    message: `${configPath} does not exist.`
                }
            ]);
        }
        if (errorCode === "EACCES" || errorCode === "EPERM") {
            return toInvalidResolution(workspaceRoot, [
                {
                    code: "ROUTELEDGER_DATA_DIR_PERMISSION_DENIED",
                    severity: "error",
                    message: `${configPath} is not accessible with the required permissions.`
                }
            ]);
        }
        return toInvalidResolution(workspaceRoot, [
            {
                code: "ROUTELEDGER_DATA_DIR_UNREADABLE",
                severity: "error",
                message: error instanceof Error
                    ? `${configPath} could not be read: ${error.message}`
                    : `${configPath} could not be read.`
            }
        ]);
    }
};
