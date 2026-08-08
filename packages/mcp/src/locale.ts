import { canonicalizeLocale } from "@routeledger/core";

export type SupportedResponseLocale = "en" | "zh-CN";

export interface ResolvedResponseLocale {
  requested: string | null;
  resolved: SupportedResponseLocale;
}

export const resolveResponseLocale = (
  requested: unknown,
  runtimeDefault?: string
): ResolvedResponseLocale => {
  const candidate =
    typeof requested === "string" && requested.trim().length > 0
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
  } catch {
    return { requested: candidate, resolved: "en" };
  }
};

export const suggestContentLocale = (requested: unknown): string | null => {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    return null;
  }

  try {
    return canonicalizeLocale(requested);
  } catch {
    return null;
  }
};

const ZH_CODE_MESSAGES: Record<string, string> = {
  ACTION_NOT_IMPLEMENTED: "该操作尚未实现。",
  CONTENT_LOCALE_REQUIRED: "项目的 content_locale 尚未确认；请先与用户确认具体语言。",
  CONTENT_LOCALE_MUST_BE_CONCRETE: "content_locale 必须是具体语言，不能使用 auto。",
  CONTENT_LOCALE_INVALID: "content_locale 必须是有效的 BCP 47 locale。",
  ROUTELEDGER_NOT_INITIALIZED: "当前绑定尚未初始化 RouteLedger 项目。",
  ROUTELEDGER_BINDING_REQUIRED: "执行该操作前必须先绑定 routeledgerRoot。",
  ROUTELEDGER_BINDING_INVALID: "当前 workspaceRoot/routeledgerRoot binding 无效。",
  ROUTELEDGER_WRITE_BINDING_ASSERTION_REQUIRED:
    "写操作必须提供 expectedRouteLedgerRoot。",
  MCP_EXPECTED_ROUTELEDGER_ROOT_INVALID:
    "expectedRouteLedgerRoot 必须是非空绝对路径。",
  MCP_ROUTELEDGER_ROOT_MISMATCH:
    "expectedRouteLedgerRoot 与 MCP server 的 routeledgerRoot 不一致。",
  WORKSPACE_ROOT_UNTRUSTED:
    "没有发现可信 workspace root；RouteLedger 不会从 process.cwd() 自动创建项目。",
  NO_ROUTELEDGER_ROOTS_FOUND: "workspaceRoot 内没有发现 RouteLedger 配置入口。",
  MULTIPLE_ROUTELEDGER_ROOTS_FOUND:
    "workspaceRoot 内发现多个 RouteLedger 根，自动选择可能绑定错误项目。",
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
  CURRENT_VERSION_CLOSED_NEXT_VERSION_WAITING:
    "当前边界已关闭，下一个 Version 仍处于 `wait`。",
  CURRENT_VERSION_COMPLETE_NOT_CLOSED: "当前 Version 已完成，但尚未关闭。",
  CURRENT_VERSION_SHUTDOWN: "当前 Version 通过 shutdown 路径关闭，需要人工复核。",
  CURRENT_POINTER_DRIFT_RUNNING_VERSION:
    "current 指针与唯一运行中的 Version 不一致。",
  DIAGNOSTIC_VERSION_NOISE: "路线中存在可能干扰判断的 diagnostic/probe Version。",
  CONFIRMATION_REQUIRED: "该操作需要明确确认。",
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

const EN_CODE_MESSAGES: Record<string, string> = {
  CONTENT_LOCALE_REQUIRED:
    "The project content_locale is unresolved; confirm a concrete locale with the user first.",
  CONTENT_LOCALE_MUST_BE_CONCRETE:
    "content_locale must be concrete and cannot be auto.",
  CONTENT_LOCALE_INVALID: "content_locale must be a valid BCP 47 locale.",
  INVALID_VERSION_TRANSITION: "The current Version state does not allow this operation.",
  TARGET_ALREADY_CURRENT: "The target Version is already current.",
  VERSION_ALREADY_CLOSED: "The target Version is already closed.",
  TARGET_VERSION_NOT_COMPLETE:
    "Only a Version in the `complete` state can be closed.",
  TARGET_VERSION_NOT_READY:
    "Only a Version in the `ready` state can be started.",
  MISSING_RESIDUAL_AUDIT:
    "A residual audit is required before the Version can be closed.",
  CURRENT_VERSION_CLOSED_NEXT_VERSION_WAITING:
    "The current boundary is closed and the next Version is still in `wait`."
};

const ZH_ACTION_DESCRIPTIONS: Record<string, string> = {
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

const EN_ACTION_DESCRIPTIONS: Record<string, string> = {
  confirm_content_locale:
    "Confirm a concrete content_locale with the user before initialization or further writes.",
  set_project_content_locale:
    "Set the existing project to the concrete content_locale confirmed by the user."
};

const ZH_NEXT_ACTIONS: Record<string, { summary: string; reason: string }> = {
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

const EN_NEXT_ACTIONS: Record<string, { summary: string; reason: string }> = {
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

const localizedCodeMessage = (
  code: string,
  locale: SupportedResponseLocale
): string => {
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

const CODED_PRESENTATION_PATHS: Record<string, Set<string>> = {
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

const isCodedPresentationPath = (toolName: string, path: string[]): boolean => {
  if (path[0] === "error") {
    return SYSTEM_CODE_COLLECTION_KEYS.has(path.at(-1) ?? "");
  }

  return CODED_PRESENTATION_PATHS[toolName]?.has(path.join(".")) ?? false;
};

const localizeHumanReviewText = (
  value: string,
  locale: SupportedResponseLocale
): string => {
  const labels =
    locale === "zh-CN"
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
      : new Map<string, string>();

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

const localizeVersionStructureOperation = (
  record: Record<string, unknown>,
  locale: SupportedResponseLocale
): void => {
  if (typeof record.actionType !== "string" || typeof record.summary !== "string") {
    return;
  }

  const summaries: Record<string, [string, string]> = {
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
    const stepsRemaining =
      record.details !== null && typeof record.details === "object"
        ? (record.details as Record<string, unknown>).stepsRemaining
        : undefined;
    if (Array.isArray(stepsRemaining) && stepsRemaining.length > 0) {
      record.summary =
        locale === "zh-CN"
          ? `剩余步骤: ${stepsRemaining.join(" -> ")}`
          : `Remaining steps: ${stepsRemaining.join(" -> ")}`;
    } else if (record.summary.includes("已是 current") || record.summary.includes("already current")) {
      record.summary =
        locale === "zh-CN"
          ? "目标 Version 已是 current 且处于 running。"
          : "The target Version is already current and running.";
    } else {
      record.summary =
        locale === "zh-CN"
          ? "当前不可执行 transition。"
          : "Transition is not currently available.";
    }
  }
};

const localizeSystemValue = (
  value: unknown,
  locale: SupportedResponseLocale,
  valuePath: string[],
  toolName: string
): unknown => {
  if (valuePath.includes("metadata") || valuePath.includes("payload")) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => localizeSystemValue(item, locale, valuePath, toolName));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const record = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      key === "humanReviewText" &&
      typeof child === "string" &&
      HUMAN_REVIEW_TOOLS.has(toolName)
        ? localizeHumanReviewText(child, locale)
        : localizeSystemValue(child, locale, [...valuePath, key], toolName)
    ])
  );

  if (
    isCodedPresentationPath(toolName, valuePath) &&
    typeof record.code === "string" &&
    typeof record.message === "string"
  ) {
    record.message = localizedCodeMessage(record.code, locale);
  }

  if (
    isCodedPresentationPath(toolName, valuePath) &&
    typeof record.code === "string" &&
    typeof record.summary === "string"
  ) {
    record.summary = localizedCodeMessage(record.code, locale);
  }

  if (
    valuePath.at(-1) === "recommendedNextActions" &&
    typeof record.type === "string" &&
    typeof record.description === "string"
  ) {
    const catalog = locale === "zh-CN" ? ZH_ACTION_DESCRIPTIONS : EN_ACTION_DESCRIPTIONS;
    if (catalog[record.type] !== undefined) {
      record.description = catalog[record.type];
    }
  }

  if (
    typeof record.actionType === "string" &&
    (toolName === "next_action" || valuePath.at(-1) === "nextAction")
  ) {
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

  return record;
};

export const localizeToolResponse = <T extends {
  data?: unknown;
  error?: unknown;
  meta?: Record<string, unknown>;
}>(response: T, locale: ResolvedResponseLocale, toolName: string): T => ({
  ...response,
  ...(response.data === undefined
    ? {}
    : { data: localizeSystemValue(response.data, locale.resolved, ["data"], toolName) }),
  ...(response.error === undefined
    ? {}
    : {
        error: (() => {
          const localized = localizeSystemValue(
            response.error,
            locale.resolved,
            ["error"],
            toolName
          ) as Record<string, unknown>;
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
