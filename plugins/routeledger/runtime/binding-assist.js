import fs from "node:fs/promises";
import path from "node:path";
import { planCodexProjectConfigWrite, renderCodexProjectConfig, writeCodexProjectConfig } from "./codex/src/index.js";
import { JsonFirstStorageAdapter } from "./json-first-storage.js";
import { resolveRouteLedgerBinding } from "./binding.js";
import { WORKSPACE_CONFIG_FILENAME, getWorkspaceConfigPath, resolveDefaultRouteLedgerDataDir, resolveWorkspaceConfigSync } from "./workspace-config.js";
const DISCOVERY_IGNORED_DIR_NAMES = new Set([
    ".git",
    "node_modules",
    ".pnpm-store"
]);
const isContainedWithin = (root, candidate) => {
    const relativePath = path.relative(root, candidate);
    return (relativePath.length === 0 ||
        (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)));
};
const describeCandidateRisks = (inspection) => {
    const risks = [];
    if (inspection.storageMode === "json_invalid" && inspection.jsonError !== null) {
        risks.push({
            code: typeof inspection.jsonError.code === "string"
                ? inspection.jsonError.code
                : "JSON_SOURCE_INVALID",
            severity: "error",
            message: typeof inspection.jsonError.message === "string"
                ? inspection.jsonError.message
                : "Canonical RouteLedger JSON is invalid.",
            details: inspection.jsonError.details !== null &&
                typeof inspection.jsonError.details === "object"
                ? inspection.jsonError.details
                : null
        });
    }
    if (inspection.conflict !== null) {
        risks.push({
            code: typeof inspection.conflict.code === "string"
                ? inspection.conflict.code
                : "JSON_SQLITE_CONFLICT",
            severity: "error",
            message: typeof inspection.conflict.message === "string"
                ? inspection.conflict.message
                : "Canonical JSON and SQLite disagree for this RouteLedger root.",
            details: inspection.conflict.details !== null &&
                typeof inspection.conflict.details === "object"
                ? inspection.conflict.details
                : null
        });
    }
    if (inspection.storageMode === "sqlite_unavailable" && inspection.sqliteError !== null) {
        risks.push({
            code: "SQLITE_UNAVAILABLE",
            severity: "warning",
            message: "SQLite read model is unavailable for this RouteLedger root.",
            details: inspection.sqliteError
        });
    }
    if (inspection.storageMode === "write_in_progress") {
        risks.push({
            code: "WRITE_IN_PROGRESS",
            severity: "warning",
            message: "A canonical JSON write is already in progress for this RouteLedger root.",
            details: inspection.writeLock === null ? null : { ...inspection.writeLock }
        });
    }
    return risks;
};
const inspectResolvedBindingCandidate = async (workspaceRoot, routeledgerRoot) => {
    const workspaceConfig = resolveWorkspaceConfigSync({
        projectRoot: workspaceRoot,
        autoCreate: false
    });
    if (workspaceConfig.status !== "ready") {
        const configTimestamp = workspaceConfig.status === "missing"
            ? null
            : (await fs.stat(workspaceConfig.workspaceConfigPath)).mtime.toISOString();
        return {
            id: `candidate_${Buffer.from(routeledgerRoot).toString("base64url").slice(0, 12)}`,
            routeledgerRoot,
            workspaceConfigPath: workspaceConfig.workspaceConfigPath,
            dataRoot: workspaceConfig.status === "missing" ? null : workspaceConfig.dataRoot,
            routeledgerDir: workspaceConfig.status === "missing" ? null : workspaceConfig.routeledgerDir,
            lastModified: configTimestamp,
            storage: {
                mode: "uninitialized",
                hasCanonicalJson: false,
                hasSqlite: false
            },
            activeProject: null,
            risks: workspaceConfig.diagnostics.map((diagnostic) => ({
                code: diagnostic.code,
                severity: diagnostic.severity,
                message: diagnostic.message
            }))
        };
    }
    const storage = new JsonFirstStorageAdapter({
        workspaceRoot,
        routeledgerRoot,
        autoCreateWorkspaceConfig: false
    });
    try {
        const [inspection, routeledgerStat] = await Promise.all([
            storage.inspectRuntimeBinding(),
            fs.stat(workspaceConfig.workspaceConfigPath)
        ]);
        return {
            id: `candidate_${Buffer.from(routeledgerRoot).toString("base64url").slice(0, 12)}`,
            routeledgerRoot,
            workspaceConfigPath: workspaceConfig.workspaceConfigPath,
            dataRoot: workspaceConfig.dataRoot,
            routeledgerDir: workspaceConfig.routeledgerDir,
            lastModified: routeledgerStat.mtime.toISOString(),
            storage: {
                mode: inspection.storageMode,
                hasCanonicalJson: inspection.hasCanonicalJson,
                hasSqlite: inspection.hasSqlite
            },
            activeProject: inspection.activeProject,
            risks: describeCandidateRisks(inspection)
        };
    }
    finally {
        storage.close();
    }
};
const inspectCandidate = async (candidateWorkspaceRoot) => {
    const workspaceConfig = resolveWorkspaceConfigSync({
        projectRoot: candidateWorkspaceRoot,
        autoCreate: false
    });
    if (workspaceConfig.status !== "ready") {
        const configTimestamp = workspaceConfig.status === "missing"
            ? null
            : (await fs.stat(workspaceConfig.workspaceConfigPath)).mtime.toISOString();
        return {
            id: `candidate_${Buffer.from(candidateWorkspaceRoot).toString("base64url").slice(0, 12)}`,
            routeledgerRoot: candidateWorkspaceRoot,
            workspaceConfigPath: workspaceConfig.workspaceConfigPath,
            dataRoot: workspaceConfig.status === "missing" ? null : workspaceConfig.dataRoot,
            routeledgerDir: workspaceConfig.status === "missing" ? null : workspaceConfig.routeledgerDir,
            lastModified: configTimestamp,
            storage: {
                mode: "uninitialized",
                hasCanonicalJson: false,
                hasSqlite: false
            },
            activeProject: null,
            risks: workspaceConfig.diagnostics.map((diagnostic) => ({
                code: diagnostic.code,
                severity: diagnostic.severity,
                message: diagnostic.message
            }))
        };
    }
    return inspectResolvedBindingCandidate(candidateWorkspaceRoot, workspaceConfig.dataRoot);
};
const compareCandidates = (left, right) => left.routeledgerRoot.localeCompare(right.routeledgerRoot, "en");
const buildDiscoverActions = (status, workspaceRoot, candidate) => {
    if (status === "none_found") {
        return [
            {
                type: "initialize_at_workspace_root",
                tool: "plan_routeledger_binding",
                routeledgerRoot: workspaceRoot,
                description: "Plan a new binding rooted at workspaceRoot before creating .routeledger."
            }
        ];
    }
    if (status === "single_candidate" && candidate !== null) {
        return [
            {
                type: "plan_binding",
                tool: "plan_routeledger_binding",
                routeledgerRoot: candidate.routeledgerRoot,
                description: "Generate a binding plan for the discovered RouteLedger root."
            },
            {
                type: "render_codex_config",
                tool: "render_host_binding_config",
                routeledgerRoot: candidate.routeledgerRoot,
                description: "Render a Codex config fragment for the discovered RouteLedger root."
            }
        ];
    }
    return [
        {
            type: "ask_user_for_binding_root",
            description: "Multiple RouteLedger roots were found. Choose one before rendering host config or restarting the MCP server."
        }
    ];
};
export const discoverRouteLedgerRoots = async (options) => {
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const routeledgerRoots = new Set();
    const visit = async (directory) => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const entryPath = path.join(directory, entry.name);
            if (entry.name === ".routeledger") {
                try {
                    const configStat = await fs.stat(path.join(entryPath, WORKSPACE_CONFIG_FILENAME));
                    if (configStat.isFile()) {
                        routeledgerRoots.add(directory);
                    }
                }
                catch {
                    // Ignore directories named .routeledger that are not workspace config entries.
                }
                continue;
            }
            if (DISCOVERY_IGNORED_DIR_NAMES.has(entry.name)) {
                continue;
            }
            await visit(entryPath);
        }
    };
    await visit(workspaceRoot);
    const candidates = await Promise.all([...routeledgerRoots]
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((candidateWorkspaceRoot) => inspectCandidate(candidateWorkspaceRoot)));
    candidates.sort(compareCandidates);
    if (candidates.length === 0) {
        return {
            workspaceRoot,
            status: "none_found",
            candidates,
            recommendedBinding: null,
            reasons: [
                {
                    code: "NO_ROUTELEDGER_ROOTS_FOUND",
                    severity: "warning",
                    message: "No .routeledger/config.json entrypoints were found within workspaceRoot."
                }
            ],
            recommendedNextActions: buildDiscoverActions("none_found", workspaceRoot, null)
        };
    }
    if (candidates.length === 1) {
        const [candidate] = candidates;
        const hasBlockingRisk = candidate.risks.some((risk) => risk.severity === "error");
        return {
            workspaceRoot,
            status: "single_candidate",
            candidates,
            recommendedBinding: {
                workspaceRoot,
                routeledgerRoot: candidate.routeledgerRoot,
                requiresUserDecision: hasBlockingRisk
            },
            reasons: candidate.risks,
            recommendedNextActions: buildDiscoverActions("single_candidate", workspaceRoot, candidate)
        };
    }
    return {
        workspaceRoot,
        status: "ambiguous",
        candidates,
        recommendedBinding: null,
        reasons: [
            {
                code: "MULTIPLE_ROUTELEDGER_ROOTS_FOUND",
                severity: "warning",
                message: "Multiple .routeledger/config.json entrypoints were found within workspaceRoot. Selecting automatically may bind the wrong state root."
            }
        ],
        recommendedNextActions: buildDiscoverActions("ambiguous", workspaceRoot, null)
    };
};
const buildPlanAction = (type, description, extra = {}) => ({
    type,
    description,
    ...extra
});
export const planRouteLedgerBinding = async (options) => {
    const workspaceRoot = options.binding.workspaceRoot ?? options.binding.processCwd;
    const currentBinding = {
        status: options.binding.status,
        workspaceRoot: options.binding.workspaceRoot,
        routeledgerRoot: options.binding.routeledgerRoot,
        workspaceConfigPath: options.binding.workspaceConfigPath,
        dataRoot: options.binding.dataRoot,
        routeledgerDir: options.binding.routeledgerDir,
        jsonProjectPath: options.binding.jsonProjectPath,
        sqliteDbPath: options.binding.sqliteDbPath
    };
    const checks = [];
    const risks = [];
    let source = "current_binding";
    let selectedRouteLedgerRoot = null;
    let selectedCandidate = null;
    if (typeof options.routeledgerRoot === "string") {
        source = "explicit_root";
        if (!path.isAbsolute(options.routeledgerRoot)) {
            checks.push({
                code: "ABSOLUTE_PATH_REQUIRED",
                status: "blocked",
                message: "routeledgerRoot must be an absolute path."
            });
            return {
                status: "blocked",
                workspaceRoot,
                source,
                currentBinding,
                targetBinding: null,
                selectedCandidate: null,
                checks,
                risks,
                requiresUserDecision: false,
                requiresInit: false,
                requiresHostConfigUpdate: false,
                requiresServerRestart: false,
                recommendedNextActions: [
                    buildPlanAction("retry_with_absolute_root", "Retry plan_routeledger_binding with an absolute routeledgerRoot.")
                ]
            };
        }
        selectedRouteLedgerRoot = path.resolve(options.routeledgerRoot);
    }
    else if (options.binding.routeledgerRoot !== null && options.binding.status !== "invalid") {
        selectedRouteLedgerRoot = options.binding.routeledgerRoot;
    }
    else {
        const discovery = await discoverRouteLedgerRoots({ workspaceRoot });
        if (discovery.status === "none_found") {
            return {
                status: "needs_user_decision",
                workspaceRoot,
                source: "none_found",
                currentBinding,
                targetBinding: null,
                selectedCandidate: null,
                checks: [
                    {
                        code: "NO_ROUTELEDGER_ROOTS_FOUND",
                        status: "warning",
                        message: "No RouteLedger roots were discovered in workspaceRoot."
                    }
                ],
                risks: discovery.reasons,
                requiresUserDecision: true,
                requiresInit: false,
                requiresHostConfigUpdate: false,
                requiresServerRestart: false,
                recommendedNextActions: [
                    buildPlanAction("plan_init_at_workspace_root", "Retry with an explicit routeledgerRoot if you intend to initialize a new RouteLedger root.", {
                        tool: "plan_routeledger_binding",
                        routeledgerRoot: workspaceRoot
                    })
                ]
            };
        }
        if (discovery.status === "ambiguous") {
            return {
                status: "needs_user_decision",
                workspaceRoot,
                source: "ambiguous",
                currentBinding,
                targetBinding: null,
                selectedCandidate: null,
                checks: [
                    {
                        code: "MULTIPLE_ROUTELEDGER_ROOTS_FOUND",
                        status: "warning",
                        message: "Multiple RouteLedger roots were discovered in workspaceRoot."
                    }
                ],
                risks: discovery.reasons,
                requiresUserDecision: true,
                requiresInit: false,
                requiresHostConfigUpdate: false,
                requiresServerRestart: false,
                recommendedNextActions: discovery.recommendedNextActions
            };
        }
        source = "discovered_single_candidate";
        selectedCandidate = discovery.candidates[0] ?? null;
        selectedRouteLedgerRoot = selectedCandidate?.routeledgerRoot ?? null;
    }
    if (selectedRouteLedgerRoot === null) {
        return {
            status: "blocked",
            workspaceRoot,
            source,
            currentBinding,
            targetBinding: null,
            selectedCandidate: null,
            checks,
            risks,
            requiresUserDecision: false,
            requiresInit: false,
            requiresHostConfigUpdate: false,
            requiresServerRestart: false,
            recommendedNextActions: []
        };
    }
    if (!isContainedWithin(workspaceRoot, selectedRouteLedgerRoot)) {
        checks.push({
            code: "ROUTELEDGER_ROOT_OUTSIDE_WORKSPACE",
            status: "blocked",
            message: "routeledgerRoot must stay within workspaceRoot."
        });
        return {
            status: "blocked",
            workspaceRoot,
            source,
            currentBinding,
            targetBinding: null,
            selectedCandidate,
            checks,
            risks,
            requiresUserDecision: false,
            requiresInit: false,
            requiresHostConfigUpdate: false,
            requiresServerRestart: false,
            recommendedNextActions: [
                buildPlanAction("choose_in_workspace_root", "Pick a routeledgerRoot that stays within workspaceRoot.")
            ]
        };
    }
    const targetBinding = resolveRouteLedgerBinding({
        workspaceRoot,
        routeledgerRoot: selectedRouteLedgerRoot,
        processCwd: options.binding.processCwd
    }, {
        autoCreateWorkspaceConfig: false
    });
    const requiresHostConfigUpdate = currentBinding.workspaceRoot !== workspaceRoot ||
        currentBinding.routeledgerRoot !== selectedRouteLedgerRoot;
    const requiresServerRestart = requiresHostConfigUpdate;
    const workspaceConfig = resolveWorkspaceConfigSync({
        projectRoot: workspaceRoot,
        autoCreate: false
    });
    checks.push({
        code: "WORKSPACE_ROOT_VALID",
        status: "ok",
        message: "workspaceRoot is available for binding planning."
    });
    checks.push({
        code: "ROUTELEDGER_ROOT_WITHIN_WORKSPACE",
        status: "ok",
        message: "routeledgerRoot stays within workspaceRoot."
    });
    if (workspaceConfig.status === "missing" || targetBinding.status === "uninitialized") {
        checks.push({
            code: workspaceConfig.status === "missing"
                ? "WORKSPACE_CONFIG_NOT_FOUND"
                : "ROUTELEDGER_STATE_NOT_INITIALIZED",
            status: "warning",
            message: workspaceConfig.status === "missing"
                ? "No .routeledger/config.json exists at the target workspaceRoot yet."
                : "The target workspace config is present, but RouteLedger state has not been initialized."
        });
        return {
            status: "needs_init",
            workspaceRoot,
            source,
            currentBinding,
            targetBinding: {
                workspaceRoot,
                routeledgerRoot: selectedRouteLedgerRoot,
                workspaceConfigPath: targetBinding.workspaceConfigPath ??
                    getWorkspaceConfigPath(workspaceRoot),
                dataRoot: targetBinding.dataRoot ??
                    (workspaceConfig.status === "missing"
                        ? selectedRouteLedgerRoot
                        : resolveDefaultRouteLedgerDataDir(workspaceRoot)),
                routeledgerDir: targetBinding.routeledgerDir ??
                    path.join(targetBinding.dataRoot ??
                        (workspaceConfig.status === "missing"
                            ? selectedRouteLedgerRoot
                            : resolveDefaultRouteLedgerDataDir(workspaceRoot)), ".routeledger"),
                jsonProjectPath: targetBinding.jsonProjectPath,
                sqliteDbPath: targetBinding.sqliteDbPath
            },
            selectedCandidate,
            checks,
            risks: (workspaceConfig.status === "missing"
                ? workspaceConfig.diagnostics
                : targetBinding.diagnostics).map((diagnostic) => ({
                code: diagnostic.code,
                severity: diagnostic.severity,
                message: diagnostic.message
            })),
            requiresUserDecision: true,
            requiresInit: true,
            requiresHostConfigUpdate,
            requiresServerRestart,
            recommendedNextActions: [
                buildPlanAction("render_codex_config", "Render host config for this target before restarting the MCP server.", {
                    tool: "render_host_binding_config",
                    routeledgerRoot: selectedRouteLedgerRoot
                }),
                buildPlanAction("initialize_routeledger", "Initialize RouteLedger at the planned routeledgerRoot after confirming the target.", {
                    tool: "init_project",
                    routeledgerRoot: selectedRouteLedgerRoot,
                    requiresUserDecision: true
                })
            ]
        };
    }
    if (targetBinding.status === "invalid") {
        return {
            status: "blocked",
            workspaceRoot,
            source,
            currentBinding,
            targetBinding: null,
            selectedCandidate,
            checks: checks.concat({
                code: "WORKSPACE_CONFIG_INVALID",
                status: "blocked",
                message: "The target routeledgerRoot has an invalid workspace config or dataDir."
            }),
            risks: targetBinding.diagnostics.map((diagnostic) => ({
                code: diagnostic.code,
                severity: diagnostic.severity,
                message: diagnostic.message
            })),
            requiresUserDecision: true,
            requiresInit: false,
            requiresHostConfigUpdate: false,
            requiresServerRestart: false,
            recommendedNextActions: [
                buildPlanAction("inspect_workspace_config", "Fix .routeledger/config.json or the configured dataDir before updating host config.")
            ]
        };
    }
    selectedCandidate ??= await inspectResolvedBindingCandidate(workspaceRoot, selectedRouteLedgerRoot);
    risks.push(...selectedCandidate.risks);
    if (selectedCandidate.risks.some((risk) => risk.severity === "error")) {
        checks.push({
            code: "TARGET_ROUTELEDGER_ROOT_HAS_BLOCKING_RISKS",
            status: "blocked",
            message: "The target RouteLedger root has blocking storage or canonical JSON risks."
        });
        return {
            status: "blocked",
            workspaceRoot,
            source,
            currentBinding,
            targetBinding: {
                workspaceRoot,
                routeledgerRoot: selectedRouteLedgerRoot,
                workspaceConfigPath: targetBinding.workspaceConfigPath,
                dataRoot: targetBinding.dataRoot,
                routeledgerDir: targetBinding.routeledgerDir,
                jsonProjectPath: targetBinding.jsonProjectPath,
                sqliteDbPath: targetBinding.sqliteDbPath
            },
            selectedCandidate,
            checks,
            risks,
            requiresUserDecision: true,
            requiresInit: false,
            requiresHostConfigUpdate,
            requiresServerRestart,
            recommendedNextActions: [
                buildPlanAction("inspect_workspace", "Review discovered RouteLedger roots before updating host config.", {
                    tool: "discover_routeledger_roots"
                })
            ]
        };
    }
    checks.push({
        code: "TARGET_ROUTELEDGER_ROOT_READY",
        status: selectedCandidate.risks.length > 0 ? "warning" : "ok",
        message: selectedCandidate.risks.length > 0
            ? "The target RouteLedger root is usable but has non-blocking risks."
            : "The target RouteLedger root is ready for binding."
    });
    return {
        status: "ready",
        workspaceRoot,
        source,
        currentBinding,
        targetBinding: {
            workspaceRoot,
            routeledgerRoot: selectedRouteLedgerRoot,
            workspaceConfigPath: targetBinding.workspaceConfigPath,
            dataRoot: targetBinding.dataRoot,
            routeledgerDir: targetBinding.routeledgerDir,
            jsonProjectPath: targetBinding.jsonProjectPath,
            sqliteDbPath: targetBinding.sqliteDbPath
        },
        selectedCandidate,
        checks,
        risks,
        requiresUserDecision: false,
        requiresInit: false,
        requiresHostConfigUpdate,
        requiresServerRestart,
        recommendedNextActions: [
            buildPlanAction("render_codex_config", "Render a Codex config or fragment for this binding.", {
                tool: "render_host_binding_config",
                routeledgerRoot: selectedRouteLedgerRoot
            })
        ]
    };
};
export const renderHostBindingConfig = async (options) => {
    const bindingPlan = await planRouteLedgerBinding({
        binding: options.binding,
        routeledgerRoot: options.routeledgerRoot
    });
    if (bindingPlan.status !== "ready" && bindingPlan.status !== "needs_init") {
        return {
            hostProfile: "codex",
            status: "blocked",
            bindingPlan,
            renderedConfig: null,
            writePlan: null
        };
    }
    const targetBinding = bindingPlan.targetBinding;
    const codexInput = {
        workspaceRoot: targetBinding.workspaceRoot,
        routeledgerRoot: targetBinding.routeledgerRoot,
        source: {
            kind: "workspace",
            routeLedgerWorkspaceRoot: options.routeLedgerWorkspaceRoot
        },
        serverName: options.serverName,
        existingConfigStrategy: options.existingConfigStrategy
    };
    return {
        hostProfile: "codex",
        status: "ready",
        bindingPlan,
        renderedConfig: {
            format: "toml",
            content: renderCodexProjectConfig(codexInput)
        },
        writePlan: await planCodexProjectConfigWrite(codexInput)
    };
};
export const writeHostBindingConfig = async (options) => {
    const bindingPlan = await planRouteLedgerBinding({
        binding: options.binding,
        routeledgerRoot: options.routeledgerRoot
    });
    if (bindingPlan.status !== "ready" && bindingPlan.status !== "needs_init") {
        return {
            hostProfile: "codex",
            status: "blocked",
            bindingPlan,
            writeResult: null
        };
    }
    const targetBinding = bindingPlan.targetBinding;
    const codexInput = {
        workspaceRoot: targetBinding.workspaceRoot,
        routeledgerRoot: targetBinding.routeledgerRoot,
        source: {
            kind: "workspace",
            routeLedgerWorkspaceRoot: options.routeLedgerWorkspaceRoot
        },
        serverName: options.serverName,
        outputPath: options.outputPath,
        existingConfigStrategy: options.existingConfigStrategy
    };
    return {
        hostProfile: "codex",
        status: "ready",
        bindingPlan,
        writeResult: await writeCodexProjectConfig(codexInput)
    };
};
