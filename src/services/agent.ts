import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { ToolRunnableConfig } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";

import { config } from "../config";
import { AppError } from "../errors/app-error";
import {
  taskRepository as defaultTaskRepository,
  type TaskRepository,
} from "./task-repository";
import {
  type AlarmToolFailure,
  type AnalyzeAlarmSuccess,
  type CreateAlarmSessionSuccess,
  type ListAlarmsSuccess,
  type NormalizedAlarmRecord,
} from "../tools/alarm-tools";
import {
  type CreateWorkOrderSuccess,
  type WorkOrderToolFailure,
} from "../tools/workorder-tools";
import {
  createToolRegistry,
  type AgentTool,
  type ToolRegistry,
} from "../tools";
import {
  TASK_CREATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  buildTaskCreatedReply,
  buildTaskListReply,
  tryHandleTaskCommand,
} from "../tools/task-tools";
import { createAppLogger } from "../utils/app-logger";
import { maskUserId } from "../utils/logger";

const MAX_CONTEXT_ROUNDS = 3;
const MAX_CONTEXT_MESSAGES = MAX_CONTEXT_ROUNDS * 2;
const DEFAULT_AGENT_TIMEOUT_MS = 8000;
const INVALID_AGENT_REPLY_TEXT = "抱歉，我暂时无法生成有效回复，请稍后再试。";
const DEFAULT_ALARM_ANALYZE_PROMPT =
  "如需继续分析，请回复“分析第 1 条告警”这样的指令。";
const MISSING_ALARM_LIST_REPLY =
  "当前会话里还没有可分析的告警列表，系统运行中可能还没有生成告警。";
const UNTREATED_ALARM_STATUS = "Untreated";
const AMBIGUOUS_ALARM_SELECTION_REPLY =
  "当前有多条告警候选，请明确回复“分析第 N 条告警”。";
const CANCEL_CONFIRMATION_REPLY =
  "好的，当前先不建单。我会保留这条告警的分析结果，如需继续建单，请重新确认。";
const CONFIRMATION_PENDING_REPLY =
  "当前正在等待你确认是否建单。请回复“确认建单”或“先不建单”。";
const WORKORDER_CONTEXT_MISSING_REPLY =
  "当前未配置全局建单上下文，暂时只能完成告警分析";
const WORKORDER_CONTEXT_INVALID_REPLY =
  "当前建单上下文不完整，请先重新分析目标告警，再确认是否建单。";
const WORKORDER_WORKFLOW_NOT_CONFIGURED_REPLY =
  "当前未配置工单工作流地址，暂时无法创建工单。";
const TASK_CREATE_REPLY_MISSING_BOTH =
  "要创建告警定时任务，还需要补充告警范围和执行时间，例如“每天 08:00 获取当前告警信息”。系统会自动转换为 6 字段 cron。";
const TASK_CREATE_REPLY_MISSING_SCOPE =
  "还缺少告警范围，请补充例如“当前告警信息”。";
const TASK_CREATE_REPLY_MISSING_TIME =
  "还缺少执行时间，请补充例如“08:00”或“每天早上 8 点”。系统会自动转换为 6 字段 cron。";
const CREATE_ALARM_SESSION_TOOL_NAME = "create_alarm_session";
const LIST_ALARMS_TOOL_NAME = "list_alarms";
const ANALYZE_ALARM_TOOL_NAME = "analyze_alarm";
const CREATE_WORK_ORDER_TOOL_NAME = "create_work_order";
const agentLogger = createAppLogger("agent");

const AGENT_SYSTEM_PROMPT = [
  "你是 Rundo Line Agent Demo。",
  "请根据用户输入的语言，使用对应的语言简洁自然的回复用户。",
  "当问题依赖最新、当前、实时、今天、本周、近期变化的外部信息时，优先调用 `search.tavily` 再回答。",
  "如果 `search.tavily` 返回搜索不可用、超时或未配置，请直接告诉用户当前无法获取最新外部信息，不要编造答案。",
  "告警链路已经由系统状态机接管：查看告警、分析第 N 条告警、确认或取消建单会由系统显式编排。",
  "任务链路已经接入：`/task` 命令以及创建、查询告警定时任务的自然语言请求会由系统显式编排。",
  "如果用户想直接建单，但还没有完成告警分析和确认节点，请明确提示需要先查看并分析具体告警。",
  "工单创建会在确认节点通过后由系统显式调用 `create_work_order`，不要在未确认时自行调用，也不要伪造工单结果。",
  "对于不需要实时外部信息的稳定问题，可以直接回答。",
].join("\n");

const LINE_CHANNEL_RESPONSE_PROMPT = [
  "当前渠道是 LINE 文本消息。",
  "你的最终回复必须是纯文本。",
  "不要使用 Markdown 标题、粗体、斜体、代码块、行内代码、引用、表格或 Markdown 链接语法。",
  "可以用自然换行组织内容；如需列点，只能使用纯文本编号，例如“1.”、“2.”。",
  "除非用户明确要求，否则不要输出 URL；如果必须给出链接，直接输出完整网址纯文本。",
].join("\n");

const ALARM_LIST_PATTERNS = [
  /^(请)?(帮我|给我)?(查看|查询|列出|展示|显示|看看|看一下)(当前)?(未处理)?告警$/u,
  /^(请)?(帮我|给我)?(查看|查询|列出|展示|显示|看看|看一下)(当前)?(未处理)?告警列表$/u,
  /^(当前)?(未处理)?告警$/u,
  /^(当前)?(未处理)?告警列表$/u,
  /^看告警$/u,
];
const ALARM_ANALYZE_PREFIX_PATTERN =
  /^(请)?(帮我|给我)?(分析|诊断|排查|看下|看看)/u;
const ALARM_INDEX_PATTERN =
  /第\s*([0-9一二三四五六七八九十两零]+)\s*(条|个|项)/u;
const CURRENT_ALARM_PATTERN = /(这条|这一条|该告警|当前告警|当前这条)/u;
const CONFIRM_PATTERNS = [
  /^是$/u,
  /^是的$/u,
  /^确认$/u,
  /^确认建单$/u,
  /^建单$/u,
  /^创建工单$/u,
  /^是创建工单$/u,
  /^是的创建工单$/u,
  /^请建单$/u,
  /^需要建单$/u,
];
const CANCEL_PATTERNS = [
  /^否$/u,
  /^不用$/u,
  /^不建单$/u,
  /^先不建单$/u,
  /^暂不建单$/u,
  /^继续观察$/u,
  /^先观察$/u,
  /^否先观察$/u,
  /^否先不建单$/u,
];
const WORKORDER_CONTEXT_KEYS = [
  "WORKORDER_TENANT_ID",
  "WORKORDER_PMMS_AUTHORIZATION",
  "WORKORDER_USER",
] as const;

export type AgentChannel = "line_webhook" | "chat_api";

export interface ProcessUserMessageInput {
  channel: AgentChannel;
  userId: string;
  message: string;
  webhookEventId?: string;
  messageId?: string;
}

export interface NormalizedUserMessageInput {
  channel: AgentChannel;
  userId: string;
  message: string;
  rawMessage: string;
  webhookEventId?: string;
  messageId?: string;
}

export interface ProcessUserMessageResult {
  reply: string;
  usedTools: string[];
}

export type AgentRuntimeResult = {
  messages?: BaseMessage[];
};

export type AgentRuntime = {
  invoke: (state: { messages: BaseMessage[] }) => Promise<AgentRuntimeResult>;
};

type AgentTools = AgentTool[];
type AgentToolName =
  | typeof TASK_CREATE_TOOL_NAME
  | typeof TASK_LIST_TOOL_NAME
  | typeof CREATE_ALARM_SESSION_TOOL_NAME
  | typeof LIST_ALARMS_TOOL_NAME
  | typeof ANALYZE_ALARM_TOOL_NAME
  | typeof CREATE_WORK_ORDER_TOOL_NAME;
type WorkOrderContextKey = (typeof WORKORDER_CONTEXT_KEYS)[number];
type PendingConfirmationAction = "create_work_order";
type PendingConfirmationResolution = "cancel" | "confirm" | null;
type AlarmListIntent = {
  status: string;
};
type AlarmAnalyzeIntent =
  | {
      type: "current";
    }
  | {
      index: number;
      type: "index";
    };
type TaskListIntent = {
  type: "list";
};
type TaskCreateDraft = {
  alertScope?: string;
  cron?: string;
};
type TaskCreateIntent = TaskCreateDraft & {
  type: "create";
};

export interface WorkOrderGlobalContext {
  pmmsAuthorization?: string;
  tenantId?: string;
  user?: string;
}

export interface WorkOrderGlobalContextAvailability {
  available: boolean;
  missingKeys: WorkOrderContextKey[];
}

export interface AgentAlarmWorkflowState {
  alarmList: NormalizedAlarmRecord[];
  alarmSessionId?: string;
  lastAnalysisMarkdown?: string;
  lastWorkOrderResult?: Record<string, unknown>;
  pendingConfirmation?: PendingConfirmationAction;
  selectedAlarm?: NormalizedAlarmRecord;
}

export interface AgentTaskWorkflowState {
  pendingCreateDraft?: TaskCreateDraft;
}

export interface AgentSessionContext {
  alarmWorkflow: AgentAlarmWorkflowState;
  messages: BaseMessage[];
  taskWorkflow: AgentTaskWorkflowState;
}

type AgentServiceErrorType =
  | "INVALID_ARGUMENT"
  | "MISSING_API_KEY"
  | "AGENT_INIT_FAILED"
  | "AGENT_INVOCATION_FAILED";

interface AgentServiceOptions {
  createRuntimeAgent?: (tools: AgentTools) => AgentRuntime;
  memoryStore?: AgentConversationMemory;
  taskRepository?: TaskRepository;
  toolRegistry?: ToolRegistry<AgentTool>;
}

export class AgentServiceError extends Error {
  constructor(
    public readonly type: AgentServiceErrorType,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentServiceError";
  }
}

type InvokableTool = {
  invoke: (input: unknown, config?: ToolRunnableConfig) => Promise<unknown>;
  name: string;
};

type StoredAgentSessionContext = {
  alarmWorkflow: AgentAlarmWorkflowState;
  messages: BaseMessage[];
  taskWorkflow: AgentTaskWorkflowState;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
};

const cloneAlarmRecord = (
  alarm?: NormalizedAlarmRecord,
): NormalizedAlarmRecord | undefined => {
  if (!alarm) {
    return undefined;
  }

  return {
    ...alarm,
    raw: { ...alarm.raw },
  };
};

const cloneAlarmWorkflow = (
  workflow?: AgentAlarmWorkflowState,
): AgentAlarmWorkflowState => {
  return {
    alarmSessionId: workflow?.alarmSessionId,
    alarmList: (workflow?.alarmList ?? []).map((alarm) => ({
      ...alarm,
      raw: { ...alarm.raw },
    })),
    selectedAlarm: cloneAlarmRecord(workflow?.selectedAlarm),
    lastAnalysisMarkdown: workflow?.lastAnalysisMarkdown,
    pendingConfirmation: workflow?.pendingConfirmation,
    lastWorkOrderResult: workflow?.lastWorkOrderResult
      ? { ...workflow.lastWorkOrderResult }
      : undefined,
  };
};

const cloneTaskWorkflow = (
  workflow?: AgentTaskWorkflowState,
): AgentTaskWorkflowState => {
  return {
    pendingCreateDraft: workflow?.pendingCreateDraft
      ? { ...workflow.pendingCreateDraft }
      : undefined,
  };
};

const createEmptyAlarmWorkflow = (): AgentAlarmWorkflowState => {
  return {
    alarmList: [],
  };
};

const createEmptyTaskWorkflow = (): AgentTaskWorkflowState => {
  return {};
};

const createEmptySessionContext = (): StoredAgentSessionContext => {
  return {
    messages: [],
    alarmWorkflow: createEmptyAlarmWorkflow(),
    taskWorkflow: createEmptyTaskWorkflow(),
  };
};

const normalizeIntentText = (message: string): string => {
  return message.trim().replace(/[，。！？、,.!?；;：:\s]/gu, "");
};

const parseChineseOrdinal = (token: string): number | null => {
  if (/^\d+$/u.test(token)) {
    const numericValue = Number(token);
    return Number.isInteger(numericValue) && numericValue > 0
      ? numericValue
      : null;
  }

  const digitMap: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (token === "十") {
    return 10;
  }

  const tenIndex = token.indexOf("十");

  if (tenIndex >= 0) {
    const tensPart = token.slice(0, tenIndex);
    const onesPart = token.slice(tenIndex + 1);
    const tens = tensPart.length === 0 ? 1 : (digitMap[tensPart] ?? Number.NaN);
    const ones = onesPart.length === 0 ? 0 : (digitMap[onesPart] ?? Number.NaN);

    if (Number.isNaN(tens) || Number.isNaN(ones)) {
      return null;
    }

    const parsedValue = tens * 10 + ones;
    return parsedValue > 0 ? parsedValue : null;
  }

  const parsedValue = digitMap[token];
  return parsedValue > 0 ? parsedValue : null;
};

const parseAlarmListIntent = (message: string): AlarmListIntent | null => {
  const trimmedMessage = message.trim();

  if (!ALARM_LIST_PATTERNS.some((pattern) => pattern.test(trimmedMessage))) {
    return null;
  }

  return {
    status: /未处理/u.test(trimmedMessage) ? UNTREATED_ALARM_STATUS : "",
  };
};

const parseAlarmAnalyzeIntent = (
  message: string,
): AlarmAnalyzeIntent | null => {
  const trimmedMessage = message.trim();

  if (!ALARM_ANALYZE_PREFIX_PATTERN.test(trimmedMessage)) {
    return null;
  }

  const indexMatch = trimmedMessage.match(ALARM_INDEX_PATTERN);

  if (indexMatch) {
    const parsedIndex = parseChineseOrdinal(indexMatch[1] ?? "");

    if (parsedIndex) {
      return {
        type: "index",
        index: parsedIndex,
      };
    }
  }

  if (
    CURRENT_ALARM_PATTERN.test(trimmedMessage) ||
    /告警/u.test(trimmedMessage)
  ) {
    return {
      type: "current",
    };
  }

  return null;
};

const buildDailyCronExpression = (
  hours: number,
  minutes: number,
): string | null => {
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return `0 ${minutes} ${hours} * * *`;
};

const extractCronFromMessage = (message: string): string | undefined => {
  const directTimeMatch = message.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u);

  if (directTimeMatch) {
    const hours = Number(directTimeMatch[1]);
    const minutes = Number(directTimeMatch[2]);
    return buildDailyCronExpression(hours, minutes) ?? undefined;
  }

  const chineseTimeMatch = message.match(
    /(凌晨|早上|上午|中午|下午|晚上)?\s*([0-9]{1,2})\s*点(?:\s*([0-9]{1,2})\s*分?)?/u,
  );

  if (!chineseTimeMatch) {
    return undefined;
  }

  const period = chineseTimeMatch[1] ?? "";
  let hours = Number(chineseTimeMatch[2] ?? "0");
  const minutes = Number(chineseTimeMatch[3] ?? "0");

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return undefined;
  }

  if (period === "凌晨") {
    if (hours === 12) {
      hours = 0;
    }
  } else if (period === "中午") {
    if (hours >= 1 && hours <= 10) {
      hours += 12;
    }
  } else if (period === "下午" || period === "晚上") {
    if (hours >= 1 && hours <= 11) {
      hours += 12;
    }
  } else if ((period === "早上" || period === "上午") && hours === 12) {
    hours = 0;
  }

  return buildDailyCronExpression(hours, minutes) ?? undefined;
};

const extractTaskAlertScope = (message: string): string | undefined => {
  if (/未处理/u.test(message)) {
    return "Current Untreated Alarms";
  }

  if (/(全部|所有).{0,3}告警/u.test(message)) {
    return "Current Alarms";
  }

  if (
    /告警/u.test(message) &&
    /(任务|定时|提醒|获取|拉取|查询|查看)/u.test(message)
  ) {
    return "Current Alarms";
  }

  return undefined;
};

const isTaskCreateMessage = (message: string): boolean => {
  if (!/告警/u.test(message)) {
    return false;
  }

  return /(每天|每日|定时|提醒|创建|新建|增加|设一个|设置|获取|拉取|推送)/u.test(
    message,
  );
};

const parseTaskListIntent = (message: string): TaskListIntent | null => {
  const trimmedMessage = message.trim();

  if (!/告警/u.test(trimmedMessage)) {
    return null;
  }

  if (!/(任务|定时|提醒)/u.test(trimmedMessage)) {
    return null;
  }

  if (
    !/(哪些|列表|查看|查询|列出|展示|看看|看下|有什么)/u.test(trimmedMessage)
  ) {
    return null;
  }

  return {
    type: "list",
  };
};

const parseTaskCreateIntent = (message: string): TaskCreateIntent | null => {
  if (!isTaskCreateMessage(message)) {
    return null;
  }

  return {
    type: "create",
    alertScope: extractTaskAlertScope(message),
    cron: extractCronFromMessage(message),
  };
};

const mergeTaskCreateDraft = (
  draft: TaskCreateDraft | undefined,
  message: string,
): TaskCreateDraft => {
  return {
    alertScope: draft?.alertScope ?? extractTaskAlertScope(message),
    cron: draft?.cron ?? extractCronFromMessage(message),
  };
};

const buildTaskCreateMissingReply = (draft: TaskCreateDraft): string => {
  if (!draft.alertScope && !draft.cron) {
    return TASK_CREATE_REPLY_MISSING_BOTH;
  }

  if (!draft.alertScope) {
    return TASK_CREATE_REPLY_MISSING_SCOPE;
  }

  return TASK_CREATE_REPLY_MISSING_TIME;
};

const resolvePendingConfirmationReply = (
  message: string,
): PendingConfirmationResolution => {
  const normalizedMessage = normalizeIntentText(message);

  if (CONFIRM_PATTERNS.some((pattern) => pattern.test(normalizedMessage))) {
    return "confirm";
  }

  if (CANCEL_PATTERNS.some((pattern) => pattern.test(normalizedMessage))) {
    return "cancel";
  }

  return null;
};

const buildAlarmListReply = (result: ListAlarmsSuccess): string => {
  if (result.alarms.length === 0) {
    return result.alarm_summary_markdown;
  }

  return [result.alarm_summary_markdown, DEFAULT_ALARM_ANALYZE_PROMPT].join(
    "\n\n",
  );
};

const buildAlarmSelectionOutOfRangeReply = (
  index: number,
  total: number,
): string => {
  if (total <= 0) {
    return MISSING_ALARM_LIST_REPLY;
  }

  return `当前列表共有 ${total} 条告警，暂时无法分析第 ${index} 条。请重新指定有效编号。`;
};

const buildAnalysisFailureReply = (failure: AlarmToolFailure): string => {
  if (failure.partial_analysis) {
    return [
      failure.partial_analysis,
      "当前分析过程已中断，暂未进入建单确认。你可以稍后重新分析这条告警。",
    ].join("\n\n");
  }

  return `当前无法完成告警分析：${failure.message}`;
};

const buildAnalysisReply = (
  analysisMarkdown: string,
  shouldOfferDispatch: boolean | null,
): string => {
  const confirmationPrompt =
    shouldOfferDispatch === false
      ? "分析结果暂未明确建议立即建单。如果你仍要创建工单，请回复“确认建单”或“是，创建工单”；如果先不建单，请回复“先不建单”或“继续观察”。"
      : "是否需要为这条告警创建工单？如需继续，请回复“确认建单”或“是，创建工单”；如果先不建单，请回复“先不建单”或“继续观察”。";

  return [analysisMarkdown, confirmationPrompt].join("\n\n");
};

const extractTextFromContentPart = (part: unknown): string => {
  if (typeof part === "string") {
    return part;
  }

  if (!part || typeof part !== "object") {
    return "";
  }

  if ("text" in part && typeof part.text === "string") {
    return part.text;
  }

  return "";
};

const normalizeResponseText = (content: unknown): string => {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content.map(extractTextFromContentPart).join("").trim();
  }

  return "";
};

const extractReplyFromMessages = (messages: BaseMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (!AIMessage.isInstance(message)) {
      continue;
    }

    const reply = normalizeResponseText(message.content);

    if (reply) {
      return reply;
    }
  }

  return INVALID_AGENT_REPLY_TEXT;
};

const extractUsedTools = (messages: BaseMessage[]): string[] => {
  const usedTools = new Set<string>();

  messages.forEach((message) => {
    if (!AIMessage.isInstance(message) || !Array.isArray(message.tool_calls)) {
      return;
    }

    message.tool_calls.forEach((toolCall) => {
      if (toolCall.name) {
        usedTools.add(toolCall.name);
      }
    });
  });

  return [...usedTools];
};

const createChatModel = (): LanguageModelLike => {
  if (!config.llmApiKey) {
    throw new AgentServiceError("MISSING_API_KEY", "LLM_API_KEY is missing.");
  }

  return new ChatOpenAI({
    model: config.llmModel,
    temperature: 0.2,
    apiKey: config.llmApiKey,
    timeout: DEFAULT_AGENT_TIMEOUT_MS,
    configuration: config.llmBaseUrl
      ? {
          baseURL: config.llmBaseUrl,
        }
      : undefined,
  });
};

const createRuntimeAgent = (tools: AgentTools): AgentRuntime => {
  try {
    const createRuntime = createAgent as unknown as (params: {
      model: LanguageModelLike;
      systemPrompt: string;
      tools: AgentTools;
    }) => AgentRuntime;

    return createRuntime({
      model: createChatModel(),
      tools,
      systemPrompt: AGENT_SYSTEM_PROMPT,
    });
  } catch (error) {
    if (error instanceof AgentServiceError) {
      throw error;
    }

    throw new AgentServiceError(
      "AGENT_INIT_FAILED",
      "Failed to initialize Agent runtime.",
      error,
    );
  }
};

const isInvokableTool = (value: unknown): value is InvokableTool => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    "invoke" in record &&
    typeof record.invoke === "function" &&
    "name" in record &&
    typeof record.name === "string"
  );
};

const isAlarmToolFailure = (value: unknown): value is AlarmToolFailure => {
  return (
    isRecord(value) &&
    value.success === false &&
    typeof value.message === "string" &&
    typeof value.error_type === "string"
  );
};

const isWorkOrderToolFailure = (
  value: unknown,
): value is WorkOrderToolFailure => {
  return (
    isRecord(value) &&
    value.success === false &&
    typeof value.message === "string" &&
    typeof value.error_type === "string"
  );
};

const isCreateAlarmSessionSuccess = (
  value: unknown,
): value is CreateAlarmSessionSuccess => {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.session_id === "string"
  );
};

const isListAlarmsSuccess = (value: unknown): value is ListAlarmsSuccess => {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.alarm_summary_markdown === "string" &&
    Array.isArray(value.alarms)
  );
};

const isAnalyzeAlarmSuccess = (
  value: unknown,
): value is AnalyzeAlarmSuccess => {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.analysis_markdown === "string" &&
    typeof value.session_id === "string" &&
    Array.isArray(value.raw_events)
  );
};

const isCreateWorkOrderSuccess = (
  value: unknown,
): value is CreateWorkOrderSuccess => {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.workflow_run_id === "string" &&
    typeof value.mock === "boolean"
  );
};

export const normalizeUserMessageInput = (
  input: ProcessUserMessageInput,
): NormalizedUserMessageInput => {
  const userId = input.userId.trim();
  const rawMessage = input.message.trim();

  if (!userId) {
    throw new AgentServiceError(
      "INVALID_ARGUMENT",
      "userId must be a non-empty string.",
    );
  }

  if (!rawMessage) {
    throw new AgentServiceError(
      "INVALID_ARGUMENT",
      "message must be a non-empty string.",
    );
  }

  return {
    channel: input.channel,
    userId,
    message: rawMessage,
    rawMessage,
    webhookEventId: input.webhookEventId,
    messageId: input.messageId,
  };
};

export const trimConversationMessages = (
  messages: BaseMessage[],
): BaseMessage[] => {
  if (messages.length <= MAX_CONTEXT_MESSAGES) {
    return messages;
  }

  return messages.slice(-MAX_CONTEXT_MESSAGES);
};

export const getWorkOrderGlobalContext = (): WorkOrderGlobalContext => {
  return {
    tenantId: config.workorderTenantId,
    pmmsAuthorization: config.workorderPmmsAuthorization,
    user: config.workorderUser,
  };
};

export const getWorkOrderGlobalContextAvailability = (
  workOrderContext: WorkOrderGlobalContext,
): WorkOrderGlobalContextAvailability => {
  const missingKeys = WORKORDER_CONTEXT_KEYS.filter((key) => {
    if (key === "WORKORDER_TENANT_ID") {
      return !workOrderContext.tenantId;
    }

    if (key === "WORKORDER_PMMS_AUTHORIZATION") {
      return !workOrderContext.pmmsAuthorization;
    }

    return !workOrderContext.user;
  });

  return {
    available: missingKeys.length === 0,
    missingKeys,
  };
};

const formatWorkOrderField = (value: string | null | undefined): string => {
  if (!value) {
    return "未知";
  }

  return value;
};

const buildWorkOrderFailureReply = (failure: WorkOrderToolFailure): string => {
  if (failure.error_type === "missing_business_context") {
    return WORKORDER_CONTEXT_MISSING_REPLY;
  }

  if (failure.error_type === "workflow_not_configured") {
    return WORKORDER_WORKFLOW_NOT_CONFIGURED_REPLY;
  }

  return `当前无法创建工单：${failure.message}`;
};

const buildWorkOrderSuccessReply = (result: CreateWorkOrderSuccess): string => {
  const header = result.mock
    ? "已生成 mock 工单结果（非真实业务建单）。"
    : "已为这条告警创建工单。";

  return [
    header,
    `工单编号: ${formatWorkOrderField(result.work_order_no)}`,
    `工单ID: ${formatWorkOrderField(result.work_order_id)}`,
    `标题: ${formatWorkOrderField(result.title)}`,
    `等级: ${formatWorkOrderField(result.level)}`,
    `状态: ${formatWorkOrderField(result.status)}`,
    `负责人: ${formatWorkOrderField(result.assignee)}`,
    `接单人: ${formatWorkOrderField(result.acceptor)}`,
    `开始时间: ${formatWorkOrderField(result.start_time)}`,
    `结束时间: ${formatWorkOrderField(result.end_time)}`,
  ].join("\n");
};

export class AgentConversationMemory {
  private readonly userSessions = new Map<string, StoredAgentSessionContext>();

  private getOrCreateSession(userId: string): StoredAgentSessionContext {
    const existingSession = this.userSessions.get(userId);

    if (existingSession) {
      return existingSession;
    }

    const nextSession = createEmptySessionContext();
    this.userSessions.set(userId, nextSession);
    return nextSession;
  }

  getUserContext(userId: string): BaseMessage[] {
    return [...this.getOrCreateSession(userId).messages];
  }

  getSessionContext(userId: string): AgentSessionContext {
    const session = this.getOrCreateSession(userId);
    return {
      messages: [...session.messages],
      alarmWorkflow: cloneAlarmWorkflow(session.alarmWorkflow),
      taskWorkflow: cloneTaskWorkflow(session.taskWorkflow),
    };
  }

  getAlarmWorkflow(userId: string): AgentAlarmWorkflowState {
    return this.getSessionContext(userId).alarmWorkflow;
  }

  getTaskWorkflow(userId: string): AgentTaskWorkflowState {
    return this.getSessionContext(userId).taskWorkflow;
  }

  updateAlarmWorkflow(
    userId: string,
    updater: (workflow: AgentAlarmWorkflowState) => AgentAlarmWorkflowState,
  ): AgentAlarmWorkflowState {
    const session = this.getOrCreateSession(userId);
    const nextWorkflow = updater(cloneAlarmWorkflow(session.alarmWorkflow));

    session.alarmWorkflow = cloneAlarmWorkflow(nextWorkflow);
    return cloneAlarmWorkflow(session.alarmWorkflow);
  }

  updateTaskWorkflow(
    userId: string,
    updater: (workflow: AgentTaskWorkflowState) => AgentTaskWorkflowState,
  ): AgentTaskWorkflowState {
    const session = this.getOrCreateSession(userId);
    const nextWorkflow = updater(cloneTaskWorkflow(session.taskWorkflow));

    session.taskWorkflow = cloneTaskWorkflow(nextWorkflow);
    return cloneTaskWorkflow(session.taskWorkflow);
  }

  saveConversationTurn(
    userId: string,
    message: string,
    reply: string,
  ): BaseMessage[] {
    const session = this.getOrCreateSession(userId);
    session.messages = trimConversationMessages([
      ...session.messages,
      new HumanMessage(message),
      new AIMessage(reply),
    ]);

    return [...session.messages];
  }
}

export const mapAgentErrorToAppError = (error: unknown): AppError => {
  if (!(error instanceof AgentServiceError)) {
    return new AppError(500, "INTERNAL_ERROR", "Internal server error.");
  }

  if (error.type === "INVALID_ARGUMENT") {
    return new AppError(400, "INVALID_ARGUMENT", error.message);
  }

  if (
    error.type === "MISSING_API_KEY" ||
    error.type === "AGENT_INIT_FAILED" ||
    error.type === "AGENT_INVOCATION_FAILED"
  ) {
    return new AppError(502, "EXTERNAL_SERVICE_ERROR", error.message);
  }

  return new AppError(500, "INTERNAL_ERROR", "Internal server error.");
};

export class AgentService {
  private runtimeAgent?: AgentRuntime;

  private readonly createRuntimeAgent: (tools: AgentTools) => AgentRuntime;

  private readonly memoryStore: AgentConversationMemory;

  private readonly taskRepository: TaskRepository;

  private readonly toolRegistry: ToolRegistry<AgentTool>;

  constructor(options: AgentServiceOptions = {}) {
    this.memoryStore = options.memoryStore ?? new AgentConversationMemory();
    this.taskRepository = options.taskRepository ?? defaultTaskRepository;
    this.toolRegistry = options.toolRegistry ?? createToolRegistry();
    this.createRuntimeAgent = options.createRuntimeAgent ?? createRuntimeAgent;
  }

  getSessionContext(userId: string): AgentSessionContext {
    return this.memoryStore.getSessionContext(userId);
  }

  getUserContext(userId: string): BaseMessage[] {
    return this.memoryStore.getUserContext(userId);
  }

  getRegisteredToolNames(): string[] {
    return this.toolRegistry.getNames();
  }

  private getOrCreateRuntimeAgent(): AgentRuntime {
    if (!this.runtimeAgent) {
      this.runtimeAgent = this.createRuntimeAgent(this.toolRegistry.getAll());
    }

    return this.runtimeAgent;
  }

  private getRequiredTool(name: AgentToolName): InvokableTool {
    const targetTool = this.toolRegistry.get(name);

    if (isInvokableTool(targetTool)) {
      return targetTool;
    }

    throw new AgentServiceError(
      "AGENT_INIT_FAILED",
      `Required tool is not registered or invokable: ${name}`,
    );
  }

  private async invokeTool(
    name: AgentToolName,
    input: unknown,
  ): Promise<unknown> {
    return this.getRequiredTool(name).invoke(input, {
      configurable: { isInternalBackend: true },
    });
  }

  private handleTaskListIntent(userId: string): ProcessUserMessageResult {
    const tasks = this.taskRepository.listTasksByOwner(userId);

    this.memoryStore.updateTaskWorkflow(userId, () => ({
      pendingCreateDraft: undefined,
    }));

    return {
      reply: buildTaskListReply(tasks),
      usedTools: [TASK_LIST_TOOL_NAME],
    };
  }

  private handleTaskCreateDraft(
    userId: string,
    draft: TaskCreateDraft,
  ): ProcessUserMessageResult {
    if (!draft.alertScope || !draft.cron) {
      this.memoryStore.updateTaskWorkflow(userId, () => ({
        pendingCreateDraft: { ...draft },
      }));

      return {
        reply: buildTaskCreateMissingReply(draft),
        usedTools: [],
      };
    }

    try {
      const task = this.taskRepository.createTask({
        userId,
        alertScope: draft.alertScope,
        cron: draft.cron,
        source: "natural_language",
      });

      this.memoryStore.updateTaskWorkflow(userId, () => ({
        pendingCreateDraft: undefined,
      }));

      return {
        reply: buildTaskCreatedReply(task),
        usedTools: [TASK_CREATE_TOOL_NAME],
      };
    } catch (error) {
      if (error instanceof AppError) {
        return {
          reply: error.message,
          usedTools: [TASK_CREATE_TOOL_NAME],
        };
      }

      throw error;
    }
  }

  private tryProcessTaskWorkflow(
    input: NormalizedUserMessageInput,
  ): ProcessUserMessageResult | null {
    const commandResult = tryHandleTaskCommand(
      {
        userId: input.userId,
        message: input.message,
      },
      {
        taskRepository: this.taskRepository,
      },
    );

    if (commandResult) {
      agentLogger.info("task workflow command matched", {
        channel: input.channel,
        userId: maskUserId(input.userId),
      });
      this.memoryStore.updateTaskWorkflow(input.userId, () => ({
        pendingCreateDraft: undefined,
      }));
      return commandResult;
    }

    const currentTaskWorkflow = this.memoryStore.getTaskWorkflow(input.userId);

    if (currentTaskWorkflow.pendingCreateDraft) {
      agentLogger.info("task workflow pending draft continued", {
        channel: input.channel,
        userId: maskUserId(input.userId),
      });
      return this.handleTaskCreateDraft(
        input.userId,
        mergeTaskCreateDraft(
          currentTaskWorkflow.pendingCreateDraft,
          input.message,
        ),
      );
    }

    const taskListIntent = parseTaskListIntent(input.message);

    if (taskListIntent) {
      agentLogger.info("task workflow list intent matched", {
        channel: input.channel,
        userId: maskUserId(input.userId),
      });
      return this.handleTaskListIntent(input.userId);
    }

    const taskCreateIntent = parseTaskCreateIntent(input.message);

    if (taskCreateIntent) {
      agentLogger.info("task workflow create intent matched", {
        channel: input.channel,
        userId: maskUserId(input.userId),
        hasAlertScope: Boolean(taskCreateIntent.alertScope),
        hasCron: Boolean(taskCreateIntent.cron),
      });
      return this.handleTaskCreateDraft(input.userId, taskCreateIntent);
    }

    return null;
  }

  private async ensureAlarmSessionId(userId: string): Promise<{
    failure?: AlarmToolFailure;
    sessionId?: string;
    usedTools: string[];
  }> {
    const currentWorkflow = this.memoryStore.getAlarmWorkflow(userId);

    if (currentWorkflow.alarmSessionId) {
      return {
        sessionId: currentWorkflow.alarmSessionId,
        usedTools: [],
      };
    }

    const toolResult = await this.invokeTool(
      CREATE_ALARM_SESSION_TOOL_NAME,
      {},
    );

    if (isAlarmToolFailure(toolResult)) {
      return {
        failure: toolResult,
        usedTools: [CREATE_ALARM_SESSION_TOOL_NAME],
      };
    }

    if (!isCreateAlarmSessionSuccess(toolResult)) {
      throw new AgentServiceError(
        "AGENT_INVOCATION_FAILED",
        "create_alarm_session returned an invalid response.",
      );
    }

    this.memoryStore.updateAlarmWorkflow(userId, (workflow) => ({
      ...workflow,
      alarmSessionId: toolResult.session_id,
    }));

    return {
      sessionId: toolResult.session_id,
      usedTools: [CREATE_ALARM_SESSION_TOOL_NAME],
    };
  }

  private resolveAlarmForAnalysis(
    workflow: AgentAlarmWorkflowState,
    intent: AlarmAnalyzeIntent,
  ): {
    alarm?: NormalizedAlarmRecord;
    reply?: string;
  } {
    if (intent.type === "index") {
      if (workflow.alarmList.length === 0) {
        return {
          reply: MISSING_ALARM_LIST_REPLY,
        };
      }

      const targetAlarm = workflow.alarmList[intent.index - 1];

      if (!targetAlarm) {
        return {
          reply: buildAlarmSelectionOutOfRangeReply(
            intent.index,
            workflow.alarmList.length,
          ),
        };
      }

      return {
        alarm: targetAlarm,
      };
    }

    if (workflow.selectedAlarm) {
      return {
        alarm: workflow.selectedAlarm,
      };
    }

    if (workflow.alarmList.length === 1) {
      return {
        alarm: workflow.alarmList[0],
      };
    }

    if (workflow.alarmList.length > 1) {
      return {
        reply: AMBIGUOUS_ALARM_SELECTION_REPLY,
      };
    }

    return {
      reply: MISSING_ALARM_LIST_REPLY,
    };
  }

  private async handleAlarmListIntent(
    userId: string,
    intent: AlarmListIntent,
  ): Promise<ProcessUserMessageResult> {
    const toolResult = await this.invokeTool(LIST_ALARMS_TOOL_NAME, {
      status: intent.status,
    });

    if (isAlarmToolFailure(toolResult)) {
      return {
        reply: `当前无法查询告警：${toolResult.message}`,
        usedTools: [LIST_ALARMS_TOOL_NAME],
      };
    }

    if (!isListAlarmsSuccess(toolResult)) {
      throw new AgentServiceError(
        "AGENT_INVOCATION_FAILED",
        "list_alarms returned an invalid response.",
      );
    }

    this.memoryStore.updateAlarmWorkflow(userId, (workflow) => ({
      ...workflow,
      alarmList: toolResult.alarms.map((alarm) => ({
        ...alarm,
        raw: { ...alarm.raw },
      })),
      selectedAlarm: undefined,
      lastAnalysisMarkdown: undefined,
      pendingConfirmation: undefined,
    }));

    return {
      reply: buildAlarmListReply(toolResult),
      usedTools: [LIST_ALARMS_TOOL_NAME],
    };
  }

  private async handleAlarmAnalyzeIntent(
    userId: string,
    intent: AlarmAnalyzeIntent,
  ): Promise<ProcessUserMessageResult> {
    const currentWorkflow = this.memoryStore.getAlarmWorkflow(userId);
    const resolvedAlarm = this.resolveAlarmForAnalysis(currentWorkflow, intent);

    if (!resolvedAlarm.alarm) {
      return {
        reply: resolvedAlarm.reply ?? MISSING_ALARM_LIST_REPLY,
        usedTools: [],
      };
    }

    this.memoryStore.updateAlarmWorkflow(userId, (workflow) => ({
      ...workflow,
      selectedAlarm: cloneAlarmRecord(resolvedAlarm.alarm),
      pendingConfirmation: undefined,
    }));

    const ensuredSession = await this.ensureAlarmSessionId(userId);

    if (!ensuredSession.sessionId) {
      return {
        reply: `当前无法初始化告警分析会话：${ensuredSession.failure?.message ?? "unknown error"}`,
        usedTools: ensuredSession.usedTools,
      };
    }

    const analyzeResult = await this.invokeTool(ANALYZE_ALARM_TOOL_NAME, {
      session_id: ensuredSession.sessionId,
      alarm: { ...resolvedAlarm.alarm.raw },
    });

    if (isAlarmToolFailure(analyzeResult)) {
      this.memoryStore.updateAlarmWorkflow(userId, (workflow) => ({
        ...workflow,
        lastAnalysisMarkdown:
          analyzeResult.partial_analysis ?? workflow.lastAnalysisMarkdown,
        pendingConfirmation: undefined,
      }));

      return {
        reply: buildAnalysisFailureReply(analyzeResult),
        usedTools: [...ensuredSession.usedTools, ANALYZE_ALARM_TOOL_NAME],
      };
    }

    if (!isAnalyzeAlarmSuccess(analyzeResult)) {
      throw new AgentServiceError(
        "AGENT_INVOCATION_FAILED",
        "analyze_alarm returned an invalid response.",
      );
    }

    this.memoryStore.updateAlarmWorkflow(userId, (workflow) => ({
      ...workflow,
      alarmSessionId: analyzeResult.session_id,
      selectedAlarm: cloneAlarmRecord(resolvedAlarm.alarm),
      lastAnalysisMarkdown: analyzeResult.analysis_markdown,
      pendingConfirmation: "create_work_order",
    }));

    return {
      reply: buildAnalysisReply(
        analyzeResult.analysis_markdown,
        analyzeResult.should_offer_dispatch,
      ),
      usedTools: [...ensuredSession.usedTools, ANALYZE_ALARM_TOOL_NAME],
    };
  }

  private handleConfirmationCancel(userId: string): ProcessUserMessageResult {
    this.memoryStore.updateAlarmWorkflow(userId, (workflow) => ({
      ...workflow,
      pendingConfirmation: undefined,
    }));

    return {
      reply: CANCEL_CONFIRMATION_REPLY,
      usedTools: [],
    };
  }

  private async handleConfirmationApprove(
    userId: string,
  ): Promise<ProcessUserMessageResult> {
    const availability = getWorkOrderGlobalContextAvailability(
      getWorkOrderGlobalContext(),
    );

    if (!availability.available) {
      this.memoryStore.updateAlarmWorkflow(userId, (workflow) => ({
        ...workflow,
        pendingConfirmation: undefined,
        lastWorkOrderResult: {
          success: false,
          error_type: "missing_business_context",
          message: WORKORDER_CONTEXT_MISSING_REPLY,
        },
      }));

      return {
        reply: WORKORDER_CONTEXT_MISSING_REPLY,
        usedTools: [],
      };
    }

    const workflow = this.memoryStore.getAlarmWorkflow(userId);

    if (!workflow.selectedAlarm || !workflow.lastAnalysisMarkdown) {
      this.memoryStore.updateAlarmWorkflow(userId, (currentWorkflow) => ({
        ...currentWorkflow,
        pendingConfirmation: undefined,
        lastWorkOrderResult: {
          success: false,
          error_type: "invalid_workflow_state",
          message: WORKORDER_CONTEXT_INVALID_REPLY,
        },
      }));

      return {
        reply: WORKORDER_CONTEXT_INVALID_REPLY,
        usedTools: [],
      };
    }

    const toolResult = await this.invokeTool(CREATE_WORK_ORDER_TOOL_NAME, {
      alarm: { ...workflow.selectedAlarm.raw },
      analysis_markdown: workflow.lastAnalysisMarkdown,
    });

    if (isWorkOrderToolFailure(toolResult)) {
      this.memoryStore.updateAlarmWorkflow(userId, (currentWorkflow) => ({
        ...currentWorkflow,
        pendingConfirmation: undefined,
        lastWorkOrderResult: {
          ...toolResult,
        },
      }));

      return {
        reply: buildWorkOrderFailureReply(toolResult),
        usedTools: [CREATE_WORK_ORDER_TOOL_NAME],
      };
    }

    if (!isCreateWorkOrderSuccess(toolResult)) {
      throw new AgentServiceError(
        "AGENT_INVOCATION_FAILED",
        "create_work_order returned an invalid response.",
      );
    }

    this.memoryStore.updateAlarmWorkflow(userId, (workflow) => ({
      ...workflow,
      pendingConfirmation: undefined,
      lastWorkOrderResult: {
        ...toolResult,
      },
    }));

    return {
      reply: buildWorkOrderSuccessReply(toolResult),
      usedTools: [CREATE_WORK_ORDER_TOOL_NAME],
    };
  }

  private async tryProcessAlarmWorkflow(
    input: NormalizedUserMessageInput,
  ): Promise<ProcessUserMessageResult | null> {
    const listIntent = parseAlarmListIntent(input.message);

    if (listIntent) {
      agentLogger.info("alarm workflow list intent matched", {
        channel: input.channel,
        userId: maskUserId(input.userId),
        alarmStatus: listIntent.status || "all",
      });

      return this.handleAlarmListIntent(input.userId, listIntent);
    }

    const analyzeIntent = parseAlarmAnalyzeIntent(input.message);

    if (analyzeIntent) {
      agentLogger.info("alarm workflow analyze intent matched", {
        channel: input.channel,
        userId: maskUserId(input.userId),
        analyzeIntent: analyzeIntent.type,
        analyzeIndex:
          analyzeIntent.type === "index" ? analyzeIntent.index : undefined,
      });

      return this.handleAlarmAnalyzeIntent(input.userId, analyzeIntent);
    }

    const workflow = this.memoryStore.getAlarmWorkflow(input.userId);

    if (workflow.pendingConfirmation !== "create_work_order") {
      return null;
    }

    const confirmationResolution = resolvePendingConfirmationReply(
      input.message,
    );

    if (confirmationResolution === "confirm") {
      agentLogger.info("alarm workflow confirmation approved", {
        channel: input.channel,
        userId: maskUserId(input.userId),
      });

      return this.handleConfirmationApprove(input.userId);
    }

    if (confirmationResolution === "cancel") {
      agentLogger.info("alarm workflow confirmation cancelled", {
        channel: input.channel,
        userId: maskUserId(input.userId),
      });

      return this.handleConfirmationCancel(input.userId);
    }

    return {
      reply: CONFIRMATION_PENDING_REPLY,
      usedTools: [],
    };
  }

  private async processWithRuntimeAgent(
    normalizedInput: NormalizedUserMessageInput,
  ): Promise<ProcessUserMessageResult> {
    const history = this.memoryStore.getUserContext(normalizedInput.userId);
    const requestMessages = [
      new SystemMessage(
        `当前用户的 ID 是 "${normalizedInput.userId}"。如果调用任何需要 userId 参数的工具（如创建定时任务等），请严格使用此 ID，不要编造。`,
      ),
      ...(normalizedInput.channel === "line_webhook"
        ? [new SystemMessage(LINE_CHANNEL_RESPONSE_PROMPT)]
        : []),
      ...history,
      new HumanMessage(normalizedInput.message),
    ];
    const result = await this.getOrCreateRuntimeAgent().invoke({
      messages: requestMessages,
    });
    const resultMessages = Array.isArray(result.messages)
      ? result.messages
      : [];

    return {
      reply: extractReplyFromMessages(resultMessages),
      usedTools: extractUsedTools(resultMessages),
    };
  }

  async processUserMessage(
    input: ProcessUserMessageInput,
  ): Promise<ProcessUserMessageResult> {
    const normalizedInput = normalizeUserMessageInput(input);
    const history = this.memoryStore.getUserContext(normalizedInput.userId);

    agentLogger.info("agent request received", {
      channel: normalizedInput.channel,
      userId: maskUserId(normalizedInput.userId),
      webhookEventId: normalizedInput.webhookEventId,
      messageId: normalizedInput.messageId,
      historyMessageCount: history.length,
      requestMessageCount: history.length + 1,
      registeredToolCount: this.toolRegistry.getNames().length,
    });

    try {
      const taskWorkflowResult = this.tryProcessTaskWorkflow(normalizedInput);
      const workflowResult =
        taskWorkflowResult ??
        (await this.tryProcessAlarmWorkflow(normalizedInput));
      const agentResult =
        workflowResult ?? (await this.processWithRuntimeAgent(normalizedInput));
      const nextContext = this.memoryStore.saveConversationTurn(
        normalizedInput.userId,
        normalizedInput.rawMessage,
        agentResult.reply,
      );

      agentLogger.info("agent response generated", {
        channel: normalizedInput.channel,
        userId: maskUserId(normalizedInput.userId),
        webhookEventId: normalizedInput.webhookEventId,
        messageId: normalizedInput.messageId,
        usedToolCount: agentResult.usedTools.length,
        contextMessageCount: nextContext.length,
        replyLength: agentResult.reply.length,
        workflowHandled: Boolean(workflowResult),
        taskWorkflowHandled: Boolean(taskWorkflowResult),
      });

      return agentResult;
    } catch (error) {
      const wrappedError =
        error instanceof AgentServiceError
          ? error
          : new AgentServiceError(
              "AGENT_INVOCATION_FAILED",
              "Failed to generate agent response.",
              error,
            );

      agentLogger.error(
        "agent request failed",
        {
          channel: normalizedInput.channel,
          userId: maskUserId(normalizedInput.userId),
          webhookEventId: normalizedInput.webhookEventId,
          messageId: normalizedInput.messageId,
          errorType: wrappedError.type,
        },
        wrappedError,
      );

      throw wrappedError;
    }
  }
}

export const agentService = new AgentService();
