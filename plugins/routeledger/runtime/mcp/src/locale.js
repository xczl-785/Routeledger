import { canonicalizeLocale } from "../../core/src/index.js";
export const resolveResponseLocale = (requested, runtimeDefault) => {
    const candidate = typeof requested === "string" && requested.trim().length > 0
        ? requested
        : runtimeDefault;
    if (candidate === undefined) {
        return { requested: null, resolved: "en" };
    }
    try {
        const canonical = canonicalizeLocale(candidate);
        return {
            requested: canonical,
            resolved: canonical === "zh" || canonical.startsWith("zh-") ? "zh-CN" : "en"
        };
    }
    catch {
        return { requested: candidate, resolved: "en" };
    }
};
export const suggestContentLocale = (requested) => {
    if (typeof requested !== "string" || requested.trim().length === 0) {
        return null;
    }
    try {
        return canonicalizeLocale(requested);
    }
    catch {
        return null;
    }
};
const ZH_CODE_MESSAGES = {
    ACTION_NOT_IMPLEMENTED: "该操作尚未实现。",
    CONTENT_LOCALE_REQUIRED: "项目的 content_locale 尚未确认；请先与用户确认具体语言。",
    CONTENT_LOCALE_MUST_BE_CONCRETE: "content_locale 必须是具体语言，不能使用 auto。",
    CONTENT_LOCALE_INVALID: "content_locale 必须是有效的 BCP 47 locale。",
    ROUTELEDGER_NOT_INITIALIZED: "当前绑定尚未初始化 RouteLedger 项目。",
    ROUTELEDGER_BINDING_REQUIRED: "执行该操作前必须先绑定 routeledgerRoot。",
    ROUTELEDGER_BINDING_INVALID: "当前 workspaceRoot/routeledgerRoot binding 无效。",
    ROUTELEDGER_WRITE_BINDING_ASSERTION_REQUIRED: "写操作必须提供 expectedRouteLedgerRoot。",
    MCP_EXPECTED_ROUTELEDGER_ROOT_INVALID: "expectedRouteLedgerRoot 必须是非空绝对路径。",
    MCP_ROUTELEDGER_ROOT_MISMATCH: "expectedRouteLedgerRoot 与 MCP server 的 routeledgerRoot 不一致。",
    WORKSPACE_ROOT_UNTRUSTED: "没有发现可信 workspace root；RouteLedger 不会从 process.cwd() 自动创建项目。",
    NO_ROUTELEDGER_ROOTS_FOUND: "workspaceRoot 内没有发现 RouteLedger 配置入口。",
    MULTIPLE_ROUTELEDGER_ROOTS_FOUND: "workspaceRoot 内发现多个 RouteLedger 根，自动选择可能绑定错误项目。",
    SQLITE_UNAVAILABLE: "SQLite read model 当前不可用。",
    WORKSPACE_ROOT_VALID: "workspaceRoot 可用于 binding 规划。",
    ROUTELEDGER_ROOT_WITHIN_WORKSPACE: "routeledgerRoot 位于 workspaceRoot 内。",
    TARGET_ROUTELEDGER_ROOT_READY: "目标 RouteLedger 根可用，但存在非阻断风险。",
    TARGET_VERSION_NOT_COMPLETE: "只有处于 `complete` 状态的 Version 才能关闭。",
    TARGET_VERSION_NOT_READY: "只有处于 `ready` 状态的 Version 才能启动。",
    MISSING_RESIDUAL_AUDIT: "关闭 Version 前必须完成 residual audit。",
    OPEN_TODOS: "仍有未关闭 Todo。",
    OPEN_TODOS_BLOCK_CLOSE: "未关闭 Todo 会阻止当前 Version 关闭。",
    UNRESOLVED_DEFERRED_BLOCKS_CLOSE: "未正确路由的 Deferred 会阻止当前 Version 关闭。",
    DUE_DEFERRED_REQUIRES_REVIEW: "到期 Deferred 必须在启动目标 Version 前复评。",
    CONSTRAINT_VIOLATED: "存在已明确违反的 Constraint。",
    CONSTRAINT_EVIDENCE_MISSING: "Constraint 要求的验证证据缺失。",
    PENDING_L3_PROPOSAL_NEEDS_DECISION: "存在待审批或拒绝的 L3 proposal。",
    CURRENT_VERSION_CLOSED_NEXT_VERSION_WAITING: "当前边界已关闭，下一个 Version 仍处于 `wait`。",
    CURRENT_VERSION_COMPLETE_NOT_CLOSED: "当前 Version 已完成，但尚未关闭。",
    CURRENT_VERSION_SHUTDOWN: "当前 Version 通过 shutdown 路径关闭，需要人工复核。",
    CURRENT_POINTER_DRIFT_RUNNING_VERSION: "current 指针与唯一运行中的 Version 不一致。",
    DIAGNOSTIC_VERSION_NOISE: "路线中存在可能干扰判断的 diagnostic/probe Version。",
    CONFIRMATION_REQUIRED: "该操作需要明确确认。",
    COMMIT_REPLAY_MISMATCH: "已提交操作只能使用原始且完全匹配的 approval artifact 重放。",
    CLOSE_GATE_FAILED: "Version close gate 未通过。",
    START_GATE_BLOCKED: "Version start gate 未通过。",
    INVALID_TOOL_INPUT: "工具输入无效。",
    INVALID_VERSION_TRANSITION: "当前 Version 状态不允许该操作。",
    TARGET_ALREADY_CURRENT: "目标 Version 已经是 current。",
    VERSION_ALREADY_CLOSED: "目标 Version 已经关闭。",
    PROJECT_NOT_FOUND: "未找到指定 Project。",
    VERSION_NOT_FOUND: "未找到指定 Version。",
    TODO_NOT_FOUND: "未找到指定 Todo。",
    DEFERRED_NOT_FOUND: "未找到指定 Deferred。",
    CONSTRAINT_NOT_FOUND: "未找到指定 Constraint。",
    WRITE_IN_PROGRESS: "该 RouteLedger 根当前已有 canonical JSON 写操作。"
};
const EN_CODE_MESSAGES = {
    CONTENT_LOCALE_REQUIRED: "The project content_locale is unresolved; confirm a concrete locale with the user first.",
    CONTENT_LOCALE_MUST_BE_CONCRETE: "content_locale must be concrete and cannot be auto.",
    CONTENT_LOCALE_INVALID: "content_locale must be a valid BCP 47 locale.",
    INVALID_VERSION_TRANSITION: "The current Version state does not allow this operation.",
    TARGET_ALREADY_CURRENT: "The target Version is already current.",
    VERSION_ALREADY_CLOSED: "The target Version is already closed.",
    TARGET_VERSION_NOT_COMPLETE: "Only a Version in the `complete` state can be closed.",
    TARGET_VERSION_NOT_READY: "Only a Version in the `ready` state can be started.",
    MISSING_RESIDUAL_AUDIT: "A residual audit is required before the Version can be closed.",
    CURRENT_VERSION_CLOSED_NEXT_VERSION_WAITING: "The current boundary is closed and the next Version is still in `wait`.",
    COMMIT_REPLAY_MISMATCH: "A committed operation can only be replayed with its original, exactly matching approval artifact."
};
const ZH_ACTION_DESCRIPTIONS = {
    inspect_runtime: "读取当前 binding 和 runtime 摘要后再重试。",
    inspect_workspace: "初始化前检查 workspaceRoot 内是否已有 RouteLedger 项目。",
    plan_binding: "在修改 host 配置或初始化前规划 binding 目标。",
    initialize_routeledger: "用户确认项目参数后初始化 RouteLedger。",
    confirm_content_locale: "初始化或继续写入前，与用户确认具体 content_locale。",
    set_project_content_locale: "为现有项目设置用户已确认的具体 content_locale。",
    activate_explicit_workspace_binding: "使用明确的 workspaceRoot 激活本次 MCP binding。",
    provide_explicit_workspace_root: "提供 host 项目的绝对 workspaceRoot。",
    render_codex_config: "为已选定的 RouteLedger 根生成 Codex binding 配置。",
    retry_with_assertion: "使用当前绑定的 routeledgerRoot 作为断言后重试。",
    ask_user_for_binding_root: "发现多个 RouteLedger 根；请用户选择正确目标。",
    initialize_at_workspace_root: "先规划 workspaceRoot binding，再创建 RouteLedger 项目。"
};
const EN_ACTION_DESCRIPTIONS = {
    confirm_content_locale: "Confirm a concrete content_locale with the user before initialization or further writes.",
    set_project_content_locale: "Set the existing project to the concrete content_locale confirmed by the user."
};
const ZH_NEXT_ACTIONS = {
    close_todo: {
        summary: "先关闭当前 Version 的未完成 Todo。",
        reason: "未关闭 Todo 会阻止 Version 收口。"
    },
    close_version: {
        summary: "准备 residual audit 后关闭当前 Version。",
        reason: "当前 Version 已完成，但尚未关闭。"
    },
    prepare_version: {
        summary: "准备目标 Version。",
        reason: "目标 Version 仍处于 `wait`。"
    },
    review_context: {
        summary: "先复核当前 RouteLedger 上下文。",
        reason: "现有 gate 或路线状态需要进一步处理。"
    },
    review_deferred: {
        summary: "先复评到期 Deferred。",
        reason: "到期 Deferred 会阻止目标 Version 启动。"
    },
    review_pending_proposal: {
        summary: "先处理待决 L3 proposal。",
        reason: "待决 proposal 会影响后续路线判断。"
    },
    set_current_version: {
        summary: "修正 current Version 指针。",
        reason: "current 指针与实际运行边界不一致。"
    },
    start_version: {
        summary: "启动目标 Version。",
        reason: "目标 Version 已准备完成并通过 start gate。"
    },
    none: {
        summary: "当前没有明确的单一步骤建议。",
        reason: "请结合完整上下文进一步判断。"
    }
};
const EN_NEXT_ACTIONS = {
    close_todo: {
        summary: "Close the current Version's unfinished Todo first.",
        reason: "An open Todo blocks Version closeout."
    },
    close_version: {
        summary: "Prepare the residual audit, then close the current Version.",
        reason: "The current Version is complete but not closed."
    },
    prepare_version: {
        summary: "Prepare the target Version.",
        reason: "The target Version is still in `wait`."
    },
    review_context: {
        summary: "Review the current RouteLedger context first.",
        reason: "The current gate or route state requires further handling."
    },
    review_deferred: {
        summary: "Review due Deferred work first.",
        reason: "Due Deferred work blocks the target Version from starting."
    },
    review_pending_proposal: {
        summary: "Resolve the pending L3 proposal first.",
        reason: "The pending proposal affects subsequent route decisions."
    },
    set_current_version: {
        summary: "Repair the current Version pointer.",
        reason: "The current pointer does not match the running boundary."
    },
    start_version: {
        summary: "Start the target Version.",
        reason: "The target Version is ready and its start gate passes."
    },
    none: {
        summary: "There is no single clear next action.",
        reason: "Review the complete context before deciding what to do next."
    }
};
const localizedCodeMessage = (code, locale) => {
    if (locale === "zh-CN") {
        return ZH_CODE_MESSAGES[code] ?? `RouteLedger 返回 ${code}；请查看结构化详情。`;
    }
    return EN_CODE_MESSAGES[code] ?? `RouteLedger reported ${code}; inspect the structured details.`;
};
const SYSTEM_CODE_COLLECTION_KEYS = new Set([
    "blockers",
    "diagnostics",
    "issues",
    "risks",
    "warnings"
]);
const HUMAN_REVIEW_TOOLS = new Set([
    "batch_create_versions",
    "close_version",
    "propose_l3_operation",
    "shutdown_version",
    "transition_version"
]);
const CODED_PRESENTATION_PATHS = {
    batch_create_versions: new Set(["data.blockers", "data.issues", "data.risks"]),
    check_close_gate: new Set(["data.blockers"]),
    check_start_gate: new Set(["data.blockers"]),
    close_version: new Set(["data.blockers"]),
    discover_routeledger_roots: new Set(["data.diagnostics"]),
    get_current_context: new Set(["data.warnings"]),
    get_runtime_context: new Set(["data.diagnostics"]),
    get_version_structure: new Set(["data.legalOperations.blockers"]),
    get_version_transition_guide: new Set([
        "data.closeGate.blockers",
        "data.startGate.blockers"
    ]),
    plan_routeledger_binding: new Set(["data.diagnostics", "data.risks"]),
    plan_version_closeout: new Set(["data.blockers"]),
    shutdown_version: new Set(["data.blockers", "data.ordinaryCloseGate.blockers"]),
    summarize_version_closeout: new Set(["data.blockers"]),
    transition_version: new Set(["data.blockers"])
};
const isCodedPresentationPath = (toolName, path) => {
    if (path[0] === "error") {
        return SYSTEM_CODE_COLLECTION_KEYS.has(path.at(-1) ?? "");
    }
    return CODED_PRESENTATION_PATHS[toolName]?.has(path.join(".")) ?? false;
};
const localizeHumanReviewText = (value, locale) => {
    const labels = locale === "zh-CN"
        ? new Map([
            ["RouteLedger batch proposal ", "RouteLedger 批量提案 "],
            ["RouteLedger proposal ", "RouteLedger 提案 "],
            ["action: ", "操作: "],
            ["carrierAction: ", "承载操作: "],
            ["target: ", "目标: "],
            ["digest: ", "摘要: "],
            ["items: ", "条目数: "],
            ["reason: ", "理由: "],
            ["blockers: ", "阻断项: "],
            ["forced-path: ", "强制路径: "],
            ["stateReason: ", "状态理由: "],
            ["ordinaryCloseBlockers: ", "常规关闭阻断项: "]
        ])
        : new Map();
    return value
        .split("\n")
        .map((line) => {
        for (const [prefix, replacement] of labels) {
            if (line.startsWith(prefix)) {
                const suffix = line.slice(prefix.length);
                return `${replacement}${suffix === "none" ? "无" : suffix}`;
            }
        }
        return line;
    })
        .join("\n");
};
const TRANSITION_GUIDE_LABELS = {
    "Review pending L3 proposals": ["复核待决 L3 proposal", "Review pending L3 proposals"],
    "Prepare current version": ["准备当前 Version", "Prepare current Version"],
    "Start current version": ["启动当前 Version", "Start current Version"],
    "Approve start proposal": ["审批启动 proposal", "Approve start proposal"],
    "Commit start proposal": ["提交启动 proposal", "Commit start proposal"],
    "Close current version boundary": [
        "关闭当前 Version 边界",
        "Close the current Version boundary"
    ],
    "Approve close proposal": ["审批关闭 proposal", "Approve close proposal"],
    "Commit close proposal": ["提交关闭 proposal", "Commit close proposal"],
    "Close from version boundary": ["关闭来源 Version 边界", "Close the source Version boundary"],
    "Prepare target version": ["准备目标 Version", "Prepare the target Version"],
    "Start target version": ["启动目标 Version", "Start the target Version"],
    "Set current to target version": [
        "将目标 Version 设为 current",
        "Set the target Version as current"
    ],
    "Approve transition proposal": ["审批转换 proposal", "Approve transition proposal"],
    "Commit transition proposal": ["提交转换 proposal", "Commit transition proposal"],
    "Start target after current switch": [
        "切换 current 后启动目标 Version",
        "Start the target Version after switching current"
    ]
};
const TRANSITION_GUIDE_NOTES = {
    "Read-only guide only. It never creates pending proposals; execute the listed existing tools step by step.": [
        "这是只读向导，不会创建待决 proposal；请逐步执行列出的现有工具。",
        "This guide is read-only. It never creates pending proposals; execute the listed tools step by step."
    ],
    "Pending L3 proposals already exist. Resolve them first so the live route and approval chain stay unambiguous.": [
        "当前已有待决 L3 proposal；请先处理，避免 live route 和审批链产生歧义。",
        "Pending L3 proposals already exist. Resolve them first so the live route and approval chain remain unambiguous."
    ],
    "fromVersion and targetVersion already identify the current running version; no route operation is needed.": [
        "fromVersion 与 targetVersion 已指向当前 running Version，无需路线操作。",
        "fromVersion and targetVersion already identify the current running Version; no route operation is needed."
    ],
    "fromVersion and targetVersion already identify the current closed version; no route operation is needed.": [
        "fromVersion 与 targetVersion 已指向当前 closed Version，无需路线操作。",
        "fromVersion and targetVersion already identify the current closed Version; no route operation is needed."
    ],
    "Target start gate contains self-referential undo blockers. Treat them as controller judgment items instead of guessing whether they are rollback guardrails or delayed cleanup.": [
        "目标 start gate 含有自引用 Undo 阻断项；应交由控制者裁决，不要猜测它是回滚护栏还是延迟清理。",
        "The target start gate contains self-referential Undo blockers. Treat them as controller judgment items instead of guessing their purpose."
    ]
};
const TRANSITION_GUIDE_REASONS = {
    "现有 pending proposal 会改变 live route，guide 不会替你裁决、复用或生成新的 proposal。": [
        "现有待决 proposal 会改变当前路线；向导不会代替你裁决、复用或生成新 proposal。",
        "Existing pending proposals can change the live route. The guide will not decide, reuse, or create proposals for you."
    ],
    "current version 仍是 wait；先用 prepare_version 进入 ready，再重新读取 guide。": [
        "当前 Version 仍是 `wait`；先用 prepare_version 进入 `ready`，再重新读取向导。",
        "The current Version is still in `wait`; use prepare_version to enter `ready`, then read the guide again."
    ],
    "current version 已 ready；用 transition_version 生成 start_version proposal。": [
        "当前 Version 已是 `ready`；用 transition_version 生成 start_version proposal。",
        "The current Version is `ready`; use transition_version to create a start_version proposal."
    ],
    "current version start gate 仍有 blockers，transition_version 目前不会创建 proposal。": [
        "当前 Version 的 start gate 仍有阻断项，transition_version 暂不会创建 proposal。",
        "The current Version start gate still has blockers, so transition_version will not create a proposal."
    ],
    "start_version proposal 创建后，再走现有 approve_l3_operation 审批链。": [
        "创建 start_version proposal 后，再执行现有 approve_l3_operation 审批链。",
        "After creating the start_version proposal, use the existing approve_l3_operation approval chain."
    ],
    "审批通过后，再提交 start_version proposal。": [
        "审批通过后，再提交 start_version proposal。",
        "Commit the start_version proposal after approval."
    ],
    "current version 已满足 close gate；用 close_version 生成 close proposal。": [
        "当前 Version 已满足 close gate；用 close_version 生成关闭 proposal。",
        "The current Version satisfies the close gate; use close_version to create a close proposal."
    ],
    "current version close gate 仍未通过，需先处理 blockers 或补 residual audit。": [
        "当前 Version 的 close gate 尚未通过；先处理阻断项或补充 residual audit。",
        "The current Version close gate has not passed; resolve the blockers or provide a residual audit first."
    ],
    "close_version proposal 创建后，再走现有 approve_l3_operation 审批链。": [
        "创建 close_version proposal 后，再执行现有 approve_l3_operation 审批链。",
        "After creating the close_version proposal, use the existing approve_l3_operation approval chain."
    ],
    "拿到 approval artifact 后，再用 commit_l3_operation 落地 close。": [
        "取得 approval artifact 后，再用 commit_l3_operation 提交关闭操作。",
        "After obtaining the approval artifact, use commit_l3_operation to commit the close operation."
    ],
    "from version 已经 close，无需再次创建 close proposal。": [
        "来源 Version 已是 `close`，无需再次创建关闭 proposal。",
        "The source Version is already in `close`; no additional close proposal is needed."
    ],
    "from version 已满足 close gate，可先用 close_version 生成 close proposal。": [
        "来源 Version 已满足 close gate；可先用 close_version 生成关闭 proposal。",
        "The source Version satisfies the close gate; use close_version to create a close proposal."
    ],
    "from version close gate 仍未通过，需先处理 blockers 或补 residual audit。": [
        "来源 Version 的 close gate 尚未通过；先处理阻断项或补充 residual audit。",
        "The source Version close gate has not passed; resolve the blockers or provide a residual audit first."
    ],
    "target version 仍是 wait，需先 prepare_version 才能进入 ready/start 路径。": [
        "目标 Version 仍是 `wait`；需先执行 prepare_version，才能进入 ready/start 路径。",
        "The target Version is still in `wait`; run prepare_version before entering the ready/start path."
    ],
    "target version 不在 wait，无需 prepare。": [
        "目标 Version 不在 `wait`，无需 prepare。",
        "The target Version is not in `wait`, so prepare is not needed."
    ],
    "target version 已经是 current 且处于 running，本步无需执行。": [
        "目标 Version 已是 current 且处于 `running`，无需执行本步骤。",
        "The target Version is already current and running, so this step is not needed."
    ],
    "target version 尚未 ready；先 prepare，再重新进入 transition_version。": [
        "目标 Version 尚未 `ready`；先 prepare，再重新执行 transition_version。",
        "The target Version is not yet `ready`; prepare it before running transition_version again."
    ],
    "target start gate 仍有 blockers，transition_version 目前不会创建 proposal。": [
        "目标 start gate 仍有阻断项，transition_version 暂不会创建 proposal。",
        "The target start gate still has blockers, so transition_version will not create a proposal."
    ],
    "关闭 from 边界后，用 transition_version 生成 start_version proposal。": [
        "关闭来源边界后，用 transition_version 生成 start_version proposal。",
        "After closing the source boundary, use transition_version to create a start_version proposal."
    ],
    "关闭 from 边界后，用 transition_version 先生成 set_current_version proposal。": [
        "关闭来源边界后，用 transition_version 先生成 set_current_version proposal。",
        "After closing the source boundary, use transition_version to create a set_current_version proposal first."
    ],
    "transition_version 创建 proposal 后，再审批对应 L3 proposal。": [
        "transition_version 创建 proposal 后，再审批对应的 L3 proposal。",
        "After transition_version creates the proposal, approve the corresponding L3 proposal."
    ],
    "审批通过后，再提交对应的 transition proposal。": [
        "审批通过后，再提交对应的转换 proposal。",
        "Commit the corresponding transition proposal after approval."
    ],
    "set_current_version 提交后，需要再次执行 transition_version 生成 start_version proposal。": [
        "提交 set_current_version 后，需再次执行 transition_version 生成 start_version proposal。",
        "After committing set_current_version, run transition_version again to create a start_version proposal."
    ],
    "当前路径不需要额外的二次 start proposal。": [
        "当前路径不需要额外的第二个启动 proposal。",
        "The current path does not require an additional start proposal."
    ],
    "二次 transition_version 创建 start proposal 后，再审批。": [
        "第二次 transition_version 创建启动 proposal 后，再进行审批。",
        "Approve the start proposal after the second transition_version call creates it."
    ],
    "审批通过后，再提交 start proposal。": [
        "审批通过后，再提交启动 proposal。",
        "Commit the start proposal after approval."
    ]
};
const selectLocalizedText = (values, locale) => (locale === "zh-CN" ? values[0] : values[1]);
const localizeTransitionGuideNote = (value, locale) => {
    const fixed = TRANSITION_GUIDE_NOTES[value];
    if (fixed !== undefined) {
        return selectLocalizedText(fixed, locale);
    }
    const targetState = value.match(/^target version 目前是 (suspend|complete|close)，已超出本 guide 的常规 close -> start 向导路径。$/)?.[1];
    if (targetState !== undefined) {
        return locale === "zh-CN"
            ? `目标 Version 当前处于 \`${targetState}\`，已超出本向导的常规 close -> start 路径。`
            : `The target Version is in \`${targetState}\`, outside this guide's ordinary close -> start path.`;
    }
    if (value ===
        "fromVersion 不是当前 current version。请先确认 live current，再决定是否仍按该 from -> target 顺序推进。") {
        return locale === "zh-CN"
            ? "fromVersion 不是当前 Version。请先确认当前路线，再决定是否仍按该来源到目标的顺序推进。"
            : "fromVersion is not the current Version. Confirm the live route before continuing from the source to the target.";
    }
    return value;
};
const localizeTransitionGuideStep = (record, locale) => {
    if (typeof record.label === "string") {
        const label = TRANSITION_GUIDE_LABELS[record.label];
        if (label !== undefined) {
            record.label = selectLocalizedText(label, locale);
        }
    }
    if (typeof record.reason === "string") {
        const reason = TRANSITION_GUIDE_REASONS[record.reason];
        if (reason !== undefined) {
            record.reason = selectLocalizedText(reason, locale);
        }
    }
};
const localizeDocDriftSummary = (record, locale) => {
    if (locale !== "zh-CN" || typeof record.summaryText !== "string") {
        return;
    }
    const project = record.project;
    const routeTruth = record.routeTruth;
    const currentVersion = routeTruth?.currentVersion;
    const checkedFiles = Array.isArray(record.checkedFiles) ? record.checkedFiles : [];
    const unreadableFiles = Array.isArray(record.unreadableFiles) ? record.unreadableFiles : [];
    const warnings = Array.isArray(record.warnings) ? record.warnings : [];
    const coverage = record.coverage;
    const currentVersionText = currentVersion === null || currentVersion === undefined
        ? "当前没有 current Version。"
        : `当前 Version：${String(currentVersion.title)} (${String(currentVersion.id)})。`;
    record.summaryText = [
        `已检查项目 ${String(project?.name ?? "")} 的 ${checkedFiles.length} 个入口文件。`,
        currentVersionText,
        `当前路线事实包含 ${Number(routeTruth?.openTodoCount ?? 0)} 个未关闭 Todo、${Number(routeTruth?.openUndoCount ?? 0)} 个未关闭 Undo，以及 ${Number(routeTruth?.pendingProposalCount ?? 0)} 个待决 proposal。`,
        `发现 ${warnings.length} 个 warning，另有 ${unreadableFiles.length} 个文件无法读取。`,
        `覆盖率为 partial：识别到 ${Number(coverage?.recognizedAssertionCount ?? 0)} 条显式 current Version 声明；${Number(coverage?.notDetectedAssertionCount ?? 0)} 个声明字段未检测到。`
    ].join(" ");
};
const localizeDocDriftPresentation = (record, locale) => {
    localizeDocDriftSummary(record, locale);
    const warnings = Array.isArray(record.warnings)
        ? record.warnings
        : [];
    for (const warning of warnings) {
        const file = typeof warning.file === "string" ? warning.file : null;
        if (warning.code === "STALE_CURRENT_VERSION") {
            if (typeof warning.assertionKind === "string") {
                const kind = warning.assertionKind;
                warning.summary =
                    locale === "zh-CN"
                        ? `${file ?? "入口文档"} 的 ${kind} 声明与 RouteLedger 当前事实不一致。`
                        : `${file ?? "An entry document"} declares ${kind} inconsistently with the current RouteLedger truth.`;
            }
            else {
                warning.summary =
                    locale === "zh-CN"
                        ? `${file ?? "入口文档"} 提到了 current 路线，但没有可核对的当前 Version ID、标题或状态声明。`
                        : `${file ?? "An entry document"} mentions the current route without an explicit comparable current-Version ID, title, or state declaration.`;
                warning.actual =
                    locale === "zh-CN"
                        ? "文档提到了 current 路线，但没有显式可比较的 current Version 声明。"
                        : "The document mentions the current route without an explicit comparable current-Version declaration.";
            }
            continue;
        }
        if (warning.code === "STALE_TRUTH_SOURCE") {
            warning.summary =
                locale === "zh-CN"
                    ? `${file ?? "入口文档"} 将 SQLite 表述为真源，但未明确当前真源是 .routeledger canonical JSON。`
                    : `${file ?? "An entry document"} presents SQLite as the source of truth without identifying .routeledger canonical JSON as the current source.`;
            warning.expected =
                locale === "zh-CN"
                    ? ".routeledger canonical JSON 是运行时真源。"
                    : ".routeledger canonical JSON is the runtime source of truth.";
            warning.actual =
                locale === "zh-CN"
                    ? "文档将 SQLite 表述为真源。"
                    : "SQLite is presented as the source of truth.";
            continue;
        }
        if (warning.code === "MISSING_EXPECTED_POINTER") {
            warning.summary =
                locale === "zh-CN"
                    ? `入口文档没有指向期望路径 ${String(warning.expected ?? "")}。`
                    : `No entry document points to the expected path ${String(warning.expected ?? "")}.`;
            warning.actual =
                locale === "zh-CN"
                    ? "检查的入口文件均未包含期望指针路径。"
                    : "No checked entry file contains the expected pointer path.";
        }
    }
    const suggestedTodos = Array.isArray(record.suggestedTodos)
        ? record.suggestedTodos
        : [];
    for (const todo of suggestedTodos) {
        if (typeof todo.title !== "string") {
            continue;
        }
        if (todo.title.startsWith("同步 ")) {
            const target = todo.title.slice("同步 ".length).replace(/ 的 current version 指针$/, "");
            todo.title =
                locale === "zh-CN"
                    ? `同步 ${target} 的 current Version 声明`
                    : `Synchronize the current Version declaration in ${target}`;
            todo.reason = warnings.find((warning) => warning.code === "STALE_CURRENT_VERSION" && warning.file === todo.file)?.summary ?? todo.reason;
        }
        else if (todo.title.startsWith("修正文档真源表述：")) {
            const target = todo.title.slice("修正文档真源表述：".length);
            todo.title =
                locale === "zh-CN"
                    ? `修正文档真源表述：${target}`
                    : `Correct the source-of-truth statement in ${target}`;
            todo.reason = warnings.find((warning) => warning.code === "STALE_TRUTH_SOURCE" && warning.file === todo.file)?.summary ?? todo.reason;
        }
        else if (todo.title.startsWith("补入口文档指针：")) {
            const target = todo.title.slice("补入口文档指针：".length);
            todo.title =
                locale === "zh-CN"
                    ? `补入口文档指针：${target}`
                    : `Add the entry-document pointer: ${target}`;
            todo.reason = warnings.find((warning) => warning.code === "MISSING_EXPECTED_POINTER" && warning.expected === target)?.summary ?? todo.reason;
        }
    }
    const coverage = record.coverage;
    if (coverage !== undefined && Array.isArray(coverage.limitations)) {
        coverage.limitations =
            locale === "zh-CN"
                ? [
                    "仅比较显式的中文或英文 current Version 声明。",
                    "partial 结果不能证明检查文档中的所有路线表述均为最新。"
                ]
                : [
                    "Only explicit Chinese or English current-Version declarations are compared.",
                    "A partial result does not prove that every route statement in the checked documents is current."
                ];
    }
};
const localizeVersionStructureOperation = (record, locale) => {
    if (typeof record.actionType !== "string" || typeof record.summary !== "string") {
        return;
    }
    const summaries = {
        prepare_version: ["wait -> ready", "wait -> ready"],
        mark_version_complete: ["running -> complete", "running -> complete"],
        close_version: [
            "complete -> close；需要 residual audit，且所有 open item 必须已收口。",
            "complete -> close; requires residual audit and closure of every open item."
        ],
        shutdown_version: [
            "强制路径：即使常规关闭仍有阻断项，也会紧急关闭该 Version。",
            "Forced path: emergency shutdown closes the Version even when ordinary close blockers remain."
        ],
        reopen_version: ["close|suspend -> ready", "close|suspend -> ready"],
        set_current_version: [
            "切换 current 指针；若旧 current 正在 running，会自动 suspend。",
            "Switch the current pointer; a running previous current Version is suspended automatically."
        ],
        create_todo: ["为当前 Version 补充 Todo。", "Add a Todo to the current Version."]
    };
    const fixed = summaries[record.actionType];
    if (fixed !== undefined) {
        record.summary = locale === "zh-CN" ? fixed[0] : fixed[1];
        return;
    }
    if (record.actionType === "transition_version") {
        const stepsRemaining = record.details !== null && typeof record.details === "object"
            ? record.details.stepsRemaining
            : undefined;
        if (Array.isArray(stepsRemaining) && stepsRemaining.length > 0) {
            record.summary =
                locale === "zh-CN"
                    ? `剩余步骤: ${stepsRemaining.join(" -> ")}`
                    : `Remaining steps: ${stepsRemaining.join(" -> ")}`;
        }
        else if (record.summary.includes("已是 current") || record.summary.includes("already current")) {
            record.summary =
                locale === "zh-CN"
                    ? "目标 Version 已是 current 且处于 running。"
                    : "The target Version is already current and running.";
        }
        else {
            record.summary =
                locale === "zh-CN"
                    ? "当前不可执行 transition。"
                    : "Transition is not currently available.";
        }
    }
};
const localizeSystemValue = (value, locale, valuePath, toolName) => {
    if (valuePath.includes("metadata") || valuePath.includes("payload")) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => localizeSystemValue(item, locale, valuePath, toolName));
    }
    if (typeof value === "string") {
        if (toolName === "get_version_transition_guide" &&
            valuePath.at(-1) === "notes") {
            return localizeTransitionGuideNote(value, locale);
        }
        return value;
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    const record = Object.fromEntries(Object.entries(value).map(([key, child]) => [
        key,
        key === "humanReviewText" &&
            typeof child === "string" &&
            HUMAN_REVIEW_TOOLS.has(toolName)
            ? localizeHumanReviewText(child, locale)
            : localizeSystemValue(child, locale, [...valuePath, key], toolName)
    ]));
    if (isCodedPresentationPath(toolName, valuePath) &&
        typeof record.code === "string" &&
        typeof record.message === "string") {
        record.message = localizedCodeMessage(record.code, locale);
    }
    if (isCodedPresentationPath(toolName, valuePath) &&
        typeof record.code === "string" &&
        typeof record.summary === "string") {
        record.summary = localizedCodeMessage(record.code, locale);
    }
    if (valuePath.at(-1) === "recommendedNextActions" &&
        typeof record.type === "string" &&
        typeof record.description === "string") {
        const catalog = locale === "zh-CN" ? ZH_ACTION_DESCRIPTIONS : EN_ACTION_DESCRIPTIONS;
        if (catalog[record.type] !== undefined) {
            record.description = catalog[record.type];
        }
    }
    if (typeof record.actionType === "string" &&
        (toolName === "next_action" || valuePath.at(-1) === "nextAction")) {
        const catalog = locale === "zh-CN" ? ZH_NEXT_ACTIONS : EN_NEXT_ACTIONS;
        const localized = catalog[record.actionType];
        if (localized !== undefined) {
            record.summary = localized.summary;
            record.reason = localized.reason;
        }
    }
    if (toolName === "get_version_structure" && valuePath.at(-1) === "legalOperations") {
        localizeVersionStructureOperation(record, locale);
    }
    if (toolName === "get_version_transition_guide" &&
        valuePath.at(-1) === "recommendedSteps") {
        localizeTransitionGuideStep(record, locale);
    }
    if (toolName === "check_doc_drift" && valuePath.length === 1) {
        localizeDocDriftPresentation(record, locale);
    }
    return record;
};
export const localizeToolResponse = (response, locale, toolName) => ({
    ...response,
    ...(response.data === undefined
        ? {}
        : { data: localizeSystemValue(response.data, locale.resolved, ["data"], toolName) }),
    ...(response.error === undefined
        ? {}
        : {
            error: (() => {
                const localized = localizeSystemValue(response.error, locale.resolved, ["error"], toolName);
                if (typeof localized.code === "string" && typeof localized.message === "string") {
                    localized.message = localizedCodeMessage(localized.code, locale.resolved);
                }
                return localized;
            })()
        }),
    meta: {
        ...(response.meta ?? {}),
        language: {
            responseLocale: locale.resolved,
            requestedResponseLocale: locale.requested
        }
    }
});
