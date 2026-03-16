import { tool } from "langchain";

import {
  AlarmAgentClient,
  AlarmAgentClientError,
  type AlarmAgentClientOptions,
  type AlarmProcessAlarmsRequest,
  type AlarmSseEvent,
} from "../clients/alarm-agent-client";
import { config } from "../config";
import {
  buildAlarmAnalysisFlexMessage,
  buildAlarmAnalysisFlexMessageWithFallback,
  type FlexMessage,
} from "../services/flex-message-builder";
import { createAppLogger } from "../utils/app-logger";

const DEFAULT_ALARM_LIST_PAGE = 1;
const DEFAULT_ALARM_LIST_PAGE_SIZE = 20;
const DEFAULT_ALARM_LIST_STATUS = "";
const DEFAULT_ANALYZE_MODE = "standard";
const DEFAULT_ANALYZE_BUSINESS_TYPE = "device_alarm";
const DEFAULT_ANALYZE_LANGUAGE = "zh";
const MAX_ANALYSIS_DEPTH = 5;
const alarmToolLogger = createAppLogger("alarm-tools");

const CREATE_ALARM_SESSION_TOOL_NAME = "create_alarm_session";
const LIST_ALARMS_TOOL_NAME = "list_alarms";
const ANALYZE_ALARM_TOOL_NAME = "analyze_alarm";

type AlarmToolFailureType =
  | "invalid_tool_input"
  | "alarm_session_failed"
  | "alarm_list_failed"
  | "alarm_analysis_failed";

export interface AlarmToolsOptions {
  client?: AlarmAgentClient;
  clientOptions?: AlarmAgentClientOptions;
}

export interface NormalizedAlarmRecord {
  alarm_code: string | null;
  created_at: string | null;
  device_sn: string | null;
  id: string | number | null;
  processing_status: string | null;
  raw: Record<string, unknown>;
  site_name: string | null;
}

export interface AlarmToolFailure {
  error_type: AlarmToolFailureType;
  message: string;
  partial_analysis?: string;
  raw?: unknown;
  raw_events?: AlarmSseEvent[];
  status_code?: number;
  success: false;
}

export interface CreateAlarmSessionSuccess {
  raw: unknown;
  session_id: string;
  success: true;
}

export interface ListAlarmsSuccess {
  alarm_summary_markdown: string;
  alarms: NormalizedAlarmRecord[];
  page: number;
  page_size: number;
  raw: unknown;
  success: true;
  total: number;
}

export interface AnalyzeAlarmSuccess {
  analysis_markdown: string;
  flex_message: FlexMessage;
  raw_events: AlarmSseEvent[];
  recommended_action_hint: "create_work_order" | null;
  session_id: string;
  should_offer_dispatch: boolean | null;
  success: true;
}

type AlarmTool =
  | ReturnType<typeof createCreateAlarmSessionTool>
  | ReturnType<typeof createListAlarmsTool>
  | ReturnType<typeof createAnalyzeAlarmTool>;

type AlarmListAlarmsInput = {
  page: number;
  page_size: number;
  status: string;
};

type AnalyzeAlarmToolInput = {
  alarm: Record<string, unknown>;
  business_type?: string;
  force_reanalyze?: boolean;
  language?: string;
  mode?: string;
  session_id: string;
};

type AnalyzeAlarmInput = AlarmProcessAlarmsRequest;

const CREATE_ALARM_SESSION_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const LIST_ALARMS_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", default: DEFAULT_ALARM_LIST_STATUS },
    page: { type: "integer", minimum: 1, default: DEFAULT_ALARM_LIST_PAGE },
    page_size: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: DEFAULT_ALARM_LIST_PAGE_SIZE,
    },
  },
  additionalProperties: false,
} as const;

const ANALYZE_ALARM_SCHEMA = {
  type: "object",
  properties: {
    session_id: { type: "string" },
    alarm: { type: "object" },
    mode: { type: "string", default: DEFAULT_ANALYZE_MODE },
    business_type: {
      type: "string",
      default: DEFAULT_ANALYZE_BUSINESS_TYPE,
    },
    force_reanalyze: { type: "boolean", default: false },
    language: { type: "string", default: DEFAULT_ANALYZE_LANGUAGE },
  },
  required: ["session_id", "alarm"],
  additionalProperties: false,
} as const;

const ALARM_ID_PATHS = [["id"], ["alarm_id"], ["alarmId"]] as const;
const ALARM_DEVICE_SN_PATHS = [
  ["device_sn"],
  ["deviceSn"],
  ["externalId"],
  ["external_id"],
  ["deviceSN"],
  ["deviceId"],
  ["device_id"],
] as const;
const ALARM_SITE_NAME_PATHS = [
  ["site_name"],
  ["siteName"],
  ["station_name"],
  ["stationName"],
] as const;
const ALARM_CODE_PATHS = [
  ["alarm_code"],
  ["alarmCode"],
  ["fault_code"],
  ["faultCode"],
  ["alarm_fault_code"],
] as const;
const ALARM_PROCESSING_STATUS_PATHS = [
  ["processing_status"],
  ["processingStatus"],
  ["currentStatus"],
  ["current_status"],
  ["status"],
] as const;
const ALARM_CREATED_AT_PATHS = [
  ["created_at"],
  ["createdAt"],
  ["alarm_time"],
  ["alarmTime"],
  ["occur_time"],
  ["occurTime"],
  ["createTime"],
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
};

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? normalizedValue : undefined;
};

const normalizeStringOrNumber = (
  value: unknown,
): string | number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalizedValue = value.trim();
    return normalizedValue.length > 0 ? normalizedValue : undefined;
  }

  return undefined;
};

const normalizePositiveInteger = (
  value: unknown,
  defaultValue: number,
): number => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsedValue = Number(value);

    if (Number.isInteger(parsedValue) && parsedValue > 0) {
      return parsedValue;
    }
  }

  return defaultValue;
};

const normalizeBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (typeof value === "boolean") {
    return value;
  }

  return defaultValue;
};

const toRecord = (value: unknown): Record<string, unknown> => {
  return isRecord(value) ? value : {};
};

const parseJsonRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (isRecord(value)) {
    return { ...value };
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return undefined;
  }

  try {
    const parsedValue = JSON.parse(normalizedValue) as unknown;
    return isRecord(parsedValue) ? { ...parsedValue } : undefined;
  } catch {
    return undefined;
  }
};

const extractRawAlarmData = (
  alarm: Record<string, unknown>,
): {
  alarm?: Record<string, unknown>;
  parseError?: string;
} => {
  const rawDataValue = pickFirstValue(alarm, [["raw_data"], ["rawData"]]);

  if (rawDataValue === undefined || rawDataValue === null) {
    return {};
  }

  if (isRecord(rawDataValue)) {
    return {
      alarm: { ...rawDataValue },
    };
  }

  if (typeof rawDataValue === "string") {
    const normalizedValue = rawDataValue.trim();

    if (!normalizedValue) {
      return {
        parseError: "alarm.raw_data must not be empty when provided.",
      };
    }

    const parsedRecord = parseJsonRecord(normalizedValue);

    if (parsedRecord) {
      return {
        alarm: parsedRecord,
      };
    }

    return {
      parseError: "alarm.raw_data must be a valid JSON object string.",
    };
  }

  return {
    parseError: "alarm.raw_data must be a JSON object or JSON string.",
  };
};

const sanitizeAlarmEnvelope = (
  alarm: Record<string, unknown>,
): Record<string, unknown> => {
  const sanitizedAlarm = { ...alarm };

  delete sanitizedAlarm.raw;
  delete sanitizedAlarm.raw_data;
  delete sanitizedAlarm.rawData;

  return sanitizedAlarm;
};

const buildProcessAlarmRecord = (
  alarm: Record<string, unknown>,
):
  | {
      alarm: Record<string, unknown>;
    }
  | {
      error: string;
    } => {
  const rawAlarmData = extractRawAlarmData(alarm);

  if (rawAlarmData.parseError) {
    return {
      error: rawAlarmData.parseError,
    };
  }

  const mergedAlarm = rawAlarmData.alarm ?? sanitizeAlarmEnvelope(alarm);
  const alarmId =
    pickStringOrNumber(mergedAlarm, ALARM_ID_PATHS) ??
    pickStringOrNumber(alarm, ALARM_ID_PATHS);

  if (alarmId === null) {
    return {
      error: "alarm id must not be empty.",
    };
  }

  return {
    alarm: {
      ...mergedAlarm,
      id: alarmId,
    },
  };
};

const getNestedValue = (value: unknown, path: readonly string[]): unknown => {
  let current: unknown = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
};

const pickFirstValue = (
  value: unknown,
  paths: readonly (readonly string[])[],
): unknown => {
  for (const path of paths) {
    const candidate = getNestedValue(value, path);

    if (candidate !== undefined && candidate !== null) {
      return candidate;
    }
  }

  return undefined;
};

const pickString = (
  value: unknown,
  paths: readonly (readonly string[])[],
): string | null => {
  const candidate = pickFirstValue(value, paths);
  return normalizeString(candidate) ?? null;
};

const pickStringOrNumber = (
  value: unknown,
  paths: readonly (readonly string[])[],
): string | number | null => {
  const candidate = pickFirstValue(value, paths);
  return normalizeStringOrNumber(candidate) ?? null;
};

const pickNumber = (
  value: unknown,
  paths: readonly (readonly string[])[],
): number | undefined => {
  const candidate = pickFirstValue(value, paths);

  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate;
  }

  if (typeof candidate === "string") {
    const parsedNumber = Number(candidate);

    if (Number.isFinite(parsedNumber)) {
      return parsedNumber;
    }
  }

  return undefined;
};

const extractSessionId = (payload: unknown): string | undefined => {
  const candidate = pickStringOrNumber(payload, [
    ["session_id"],
    ["sessionId"],
    ["data", "session_id"],
    ["data", "sessionId"],
    ["result", "session_id"],
    ["result", "sessionId"],
  ]);

  if (candidate === null) {
    return undefined;
  }

  return String(candidate);
};

const extractAlarmArray = (payload: unknown): Record<string, unknown>[] => {
  const candidates = [
    payload,
    getNestedValue(payload, ["data"]),
    getNestedValue(payload, ["data", "data"]),
    getNestedValue(payload, ["data", "items"]),
    getNestedValue(payload, ["data", "list"]),
    getNestedValue(payload, ["items"]),
    getNestedValue(payload, ["list"]),
    getNestedValue(payload, ["result"]),
    getNestedValue(payload, ["result", "data"]),
    getNestedValue(payload, ["result", "items"]),
    getNestedValue(payload, ["result", "list"]),
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    return candidate
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({ ...item }));
  }

  return [];
};

const normalizeAlarmRecord = (
  alarm: Record<string, unknown>,
): NormalizedAlarmRecord => {
  const rawAlarmData = extractRawAlarmData(alarm).alarm;

  return {
    id:
      pickStringOrNumber(alarm, ALARM_ID_PATHS) ??
      pickStringOrNumber(rawAlarmData, ALARM_ID_PATHS),
    device_sn:
      pickString(alarm, ALARM_DEVICE_SN_PATHS) ??
      pickString(rawAlarmData, ALARM_DEVICE_SN_PATHS),
    site_name:
      pickString(alarm, ALARM_SITE_NAME_PATHS) ??
      pickString(rawAlarmData, ALARM_SITE_NAME_PATHS),
    alarm_code:
      pickString(alarm, ALARM_CODE_PATHS) ??
      pickString(rawAlarmData, ALARM_CODE_PATHS),
    processing_status:
      pickString(alarm, ALARM_PROCESSING_STATUS_PATHS) ??
      pickString(rawAlarmData, ALARM_PROCESSING_STATUS_PATHS),
    created_at:
      pickString(alarm, ALARM_CREATED_AT_PATHS) ??
      pickString(rawAlarmData, ALARM_CREATED_AT_PATHS),
    raw: { ...alarm },
  };
};

const formatAlarmField = (value: string | number | null): string => {
  if (value === null || value === undefined || value === "") {
    return "未知";
  }

  return String(value);
};

const buildAlarmSummaryMarkdown = (alarms: NormalizedAlarmRecord[]): string => {
  if (alarms.length === 0) {
    return "### 告警列表\n\n当前没有查询到符合条件的告警。";
  }

  const alarmLines = alarms.map((alarm, index) => {
    return [
      `${index + 1}. 告警ID: ${formatAlarmField(alarm.id)}`,
      `设备SN: ${formatAlarmField(alarm.device_sn)}`,
      `站点: ${formatAlarmField(alarm.site_name)}`,
      `告警代码: ${formatAlarmField(alarm.alarm_code)}`,
      `处理状态: ${formatAlarmField(alarm.processing_status)}`,
      `发生时间: ${formatAlarmField(alarm.created_at)}`,
    ].join(" | ");
  });

  return `### 告警列表\n\n${alarmLines.join("\n")}`;
};

const normalizeListAlarmsResponse = (
  payload: unknown,
  input: AlarmListAlarmsInput,
): ListAlarmsSuccess => {
  const alarms = extractAlarmArray(payload).map(normalizeAlarmRecord);

  return {
    success: true,
    total:
      pickNumber(payload, [
        ["total"],
        ["count"],
        ["total_count"],
        ["data", "total"],
        ["data", "count"],
        ["result", "total"],
        ["result", "count"],
      ]) ?? alarms.length,
    page:
      pickNumber(payload, [
        ["page"],
        ["current_page"],
        ["data", "page"],
        ["data", "current_page"],
        ["result", "page"],
      ]) ?? input.page,
    page_size:
      pickNumber(payload, [
        ["page_size"],
        ["pageSize"],
        ["data", "page_size"],
        ["data", "pageSize"],
        ["result", "page_size"],
        ["result", "pageSize"],
      ]) ?? input.page_size,
    alarms,
    alarm_summary_markdown: buildAlarmSummaryMarkdown(alarms),
    raw: payload,
  };
};

const buildToolFailure = (
  errorType: AlarmToolFailureType,
  message: string,
  extra: Omit<AlarmToolFailure, "error_type" | "message" | "success"> = {},
): AlarmToolFailure => {
  return {
    success: false,
    error_type: errorType,
    message,
    ...extra,
  };
};

const isAlarmToolFailure = (
  value: AnalyzeAlarmInput | AnalyzeAlarmToolInput | AlarmToolFailure,
): value is AlarmToolFailure => {
  return "success" in value && value.success === false;
};

const normalizeListAlarmsInput = (
  input: Record<string, unknown>,
): AlarmListAlarmsInput => {
  return {
    status: normalizeString(input.status) ?? DEFAULT_ALARM_LIST_STATUS,
    page: normalizePositiveInteger(input.page, DEFAULT_ALARM_LIST_PAGE),
    page_size: normalizePositiveInteger(
      input.page_size,
      DEFAULT_ALARM_LIST_PAGE_SIZE,
    ),
  };
};

const normalizeAnalyzeAlarmInput = (
  input: Record<string, unknown>,
): AnalyzeAlarmInput | AlarmToolFailure => {
  const sessionId = normalizeString(input.session_id);
  const alarm = toRecord(input.alarm);

  if (!sessionId) {
    return buildToolFailure(
      "invalid_tool_input",
      "session_id must be a non-empty string.",
    );
  }

  if (Object.keys(alarm).length === 0) {
    return buildToolFailure(
      "invalid_tool_input",
      "alarm must be a non-empty object.",
    );
  }

  const processAlarmRecord = buildProcessAlarmRecord(alarm);

  if ("error" in processAlarmRecord) {
    return buildToolFailure("invalid_tool_input", processAlarmRecord.error, {
      raw: {
        alarm: sanitizeAlarmEnvelope(alarm),
      },
    });
  }

  return {
    session_id: sessionId,
    alarms: [processAlarmRecord.alarm],
    mode: normalizeString(input.mode) ?? DEFAULT_ANALYZE_MODE,
    business_type:
      normalizeString(input.business_type) ?? DEFAULT_ANALYZE_BUSINESS_TYPE,
    force_reanalyze: normalizeBoolean(input.force_reanalyze, false),
    language: normalizeString(input.language) ?? DEFAULT_ANALYZE_LANGUAGE,
  };
};

const ANALYSIS_TEXT_KEYS = new Set([
  "analysis",
  "analysis_markdown",
  "analysismarkdown",
  "answer",
  "content",
  "final",
  "final_answer",
  "final_markdown",
  "markdown",
  "message",
  "output",
  "output_text",
  "summary",
  "text",
]);

const ANALYSIS_IGNORE_KEYS = new Set([
  "code",
  "event",
  "id",
  "index",
  "language",
  "mode",
  "processing_status",
  "retry",
  "session_id",
  "sessionid",
  "status",
  "success",
  "type",
]);

const normalizeAnalysisKey = (key: string): string => {
  return key.replace(/[A-Z]/g, (character) => character.toLowerCase());
};

const collectAnalysisTextPieces = (
  value: unknown,
  depth = 0,
  keyHint?: string,
): string[] => {
  if (depth > MAX_ANALYSIS_DEPTH || value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    const normalizedValue = value.trim();

    if (!normalizedValue || normalizedValue === "[DONE]") {
      return [];
    }

    if (!keyHint || ANALYSIS_TEXT_KEYS.has(keyHint)) {
      return [normalizedValue];
    }

    if (!ANALYSIS_IGNORE_KEYS.has(keyHint) && normalizedValue.length >= 12) {
      return [normalizedValue];
    }

    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      collectAnalysisTextPieces(item, depth + 1, keyHint),
    );
  }

  if (!isRecord(value)) {
    return [];
  }

  const preferredPieces = Object.entries(value).flatMap(([key, item]) => {
    const normalizedKey = normalizeAnalysisKey(key);

    if (!ANALYSIS_TEXT_KEYS.has(normalizedKey)) {
      return [];
    }

    return collectAnalysisTextPieces(item, depth + 1, normalizedKey);
  });

  if (preferredPieces.length > 0) {
    return preferredPieces;
  }

  return Object.entries(value).flatMap(([key, item]) =>
    collectAnalysisTextPieces(item, depth + 1, normalizeAnalysisKey(key)),
  );
};

const cleanAnalysisMarkdown = (value: string): string => {
  return value
    .replace(/\[DONE\]/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const normalizedLine = line.trim();

      if (!normalizedLine) {
        return true;
      }

      if (/^(开始|准备|正在).{0,12}(分析|处理)/u.test(normalizedLine)) {
        return false;
      }

      if (/^analysis (started|starting)$/iu.test(normalizedLine)) {
        return false;
      }

      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const ensureMarkdownHeading = (value: string): string => {
  if (!value) {
    return value;
  }

  if (/^#{1,6}\s/m.test(value)) {
    return value;
  }

  return `### 分析结论\n\n${value}`;
};

const dedupePieces = (pieces: string[]): string[] => {
  const normalizedPieces: string[] = [];

  pieces.forEach((piece) => {
    const normalizedPiece = piece.trim();

    if (!normalizedPiece) {
      return;
    }

    const alreadyIncluded = normalizedPieces.some(
      (existingPiece) =>
        existingPiece === normalizedPiece ||
        existingPiece.includes(normalizedPiece) ||
        normalizedPiece.includes(existingPiece),
    );

    if (!alreadyIncluded) {
      normalizedPieces.push(normalizedPiece);
    }
  });

  return normalizedPieces;
};

const buildAnalysisMarkdown = (events: AlarmSseEvent[]): string => {
  const pieces = dedupePieces(
    events.flatMap((event) => {
      if (typeof event.data === "string") {
        const normalizedData = event.data.trim();
        return normalizedData && normalizedData !== "[DONE]"
          ? [normalizedData]
          : [];
      }

      return collectAnalysisTextPieces(event.data);
    }),
  );

  if (pieces.length === 0) {
    return "";
  }

  const mergedText = pieces.join("\n\n");
  const lastPiece = pieces[pieces.length - 1] ?? "";
  const longestPiece = pieces.reduce((currentLongest, piece) => {
    return piece.length > currentLongest.length ? piece : currentLongest;
  }, "");

  const candidate =
    (lastPiece.length >= longestPiece.length && lastPiece.length >= 80
      ? lastPiece
      : longestPiece.length >= 80
        ? longestPiece
        : mergedText) || mergedText;

  return ensureMarkdownHeading(cleanAnalysisMarkdown(candidate));
};

const detectDispatchRecommendation = (
  analysisMarkdown: string,
): boolean | null => {
  const normalizedText = analysisMarkdown.toLowerCase();
  const positiveMatch =
    /派单|建单|工单|dispatch|work order|create work order/u.test(
      normalizedText,
    );
  const negativeMatch =
    /无需派单|暂不派单|无需建单|暂不建单|无需工单|不建议派单|no dispatch|no work order/u.test(
      normalizedText,
    );

  if (positiveMatch && !negativeMatch) {
    return true;
  }

  if (negativeMatch && !positiveMatch) {
    return false;
  }

  return null;
};

const mapAlarmToolError = (
  operation: "session" | "list" | "analysis",
  error: unknown,
): AlarmToolFailure => {
  const errorType =
    operation === "session"
      ? "alarm_session_failed"
      : operation === "list"
        ? "alarm_list_failed"
        : "alarm_analysis_failed";

  if (error instanceof AlarmAgentClientError) {
    const partialAnalysis =
      operation === "analysis" && Array.isArray(error.partialEvents)
        ? buildAnalysisMarkdown(error.partialEvents)
        : undefined;

    return buildToolFailure(errorType, error.message, {
      status_code: error.statusCode,
      raw: error.responseSummary,
      raw_events: error.partialEvents,
      partial_analysis:
        partialAnalysis && partialAnalysis.trim().length > 0
          ? partialAnalysis
          : undefined,
    });
  }

  return buildToolFailure(
    errorType,
    error instanceof Error ? error.message : "Unknown alarm tool error.",
  );
};

const createCreateAlarmSessionTool = (client: AlarmAgentClient) => {
  return tool(
    async (): Promise<CreateAlarmSessionSuccess | AlarmToolFailure> => {
      const startedAt = Date.now();
      alarmToolLogger.debug('create_alarm_session input', {});

      try {
        const payload = await client.createSession();
        const sessionId = extractSessionId(payload);

        if (!sessionId) {
          alarmToolLogger.warn('create_alarm_session failed: no session_id', {
            durationMs: Date.now() - startedAt,
          });
          return buildToolFailure(
            "alarm_session_failed",
            "Alarm backend returned no session_id.",
            { raw: payload },
          );
        }

        const result: CreateAlarmSessionSuccess = {
          success: true,
          session_id: sessionId,
          raw: payload,
        };

        alarmToolLogger.debug('create_alarm_session output', {
          sessionId,
          durationMs: Date.now() - startedAt,
        });

        return result;
      } catch (error) {
        alarmToolLogger.warn('create_alarm_session failed', {
          durationMs: Date.now() - startedAt,
          errorType:
            error instanceof AlarmAgentClientError ? error.type : 'UNKNOWN',
        });

        return mapAlarmToolError("session", error);
      }
    },
    {
      name: CREATE_ALARM_SESSION_TOOL_NAME,
      description:
        "创建一次告警分析会话。分析具体告警前，如果还没有 session_id，先调用这个工具。",
      schema: CREATE_ALARM_SESSION_SCHEMA,
    },
  );
};

const createListAlarmsTool = (client: AlarmAgentClient) => {
  return tool(
    async (
      input: Record<string, unknown>,
    ): Promise<ListAlarmsSuccess | AlarmToolFailure> => {
      const startedAt = Date.now();
      const normalizedInput = normalizeListAlarmsInput(input);

      alarmToolLogger.debug('list_alarms input', {
        status: normalizedInput.status || 'all',
        page: normalizedInput.page,
        pageSize: normalizedInput.page_size,
      });

      try {
        const payload = await client.listAlarms(normalizedInput);
        const result = normalizeListAlarmsResponse(payload, normalizedInput);

        alarmToolLogger.debug('list_alarms output', {
          total: result.total,
          alarmCount: result.alarms.length,
          durationMs: Date.now() - startedAt,
        });

        return result;
      } catch (error) {
        alarmToolLogger.warn('list_alarms failed', {
          durationMs: Date.now() - startedAt,
          errorType:
            error instanceof AlarmAgentClientError ? error.type : 'UNKNOWN',
        });

        return mapAlarmToolError('list', error);
      }
    },
    {
      name: LIST_ALARMS_TOOL_NAME,
      description: [
        '查询当前告警列表，默认 `status` 传空字符串，不做状态过滤。',
        '当用户明确要求查看未处理告警时，请显式传入 `status="Untreated"`。',
        '当用户明确要求查看处理中的告警时，请显式传入 `status="Processing"`。',
        '当用户想查看当前告警、未处理告警或候选告警列表时，使用这个工具。',
      ].join(' '),
      schema: LIST_ALARMS_SCHEMA,
    },
  );
};

const createAnalyzeAlarmTool = (client: AlarmAgentClient) => {
  return tool(
    async (
      input: Record<string, unknown>,
    ): Promise<AnalyzeAlarmSuccess | AlarmToolFailure> => {
      const startedAt = Date.now();
      const normalizedInput = normalizeAnalyzeAlarmInput(input);

      alarmToolLogger.debug('analyze_alarm input', {
        sessionId: isAlarmToolFailure(normalizedInput)
          ? undefined
          : normalizedInput.session_id,
        alarmId: isAlarmToolFailure(normalizedInput)
          ? undefined
          : String(normalizedInput.alarms[0]?.id ?? ''),
        mode: isAlarmToolFailure(normalizedInput)
          ? undefined
          : normalizedInput.mode,
      });

      if (isAlarmToolFailure(normalizedInput)) {
        alarmToolLogger.warn('analyze_alarm invalid input', {
          durationMs: Date.now() - startedAt,
          errorType: normalizedInput.error_type,
        });
        return normalizedInput;
      }

      try {
        const streamResult = await client.processAlarmsSse(normalizedInput);
        const analysisMarkdown = buildAnalysisMarkdown(streamResult.events);

        if (!analysisMarkdown) {
          alarmToolLogger.warn('analyze_alarm empty result', {
            sessionId: normalizedInput.session_id,
            eventCount: streamResult.events.length,
            durationMs: Date.now() - startedAt,
          });
          return buildToolFailure(
            'alarm_analysis_failed',
            'Alarm analysis stream completed without usable analysis content.',
            {
              raw_events: streamResult.events,
            },
          );
        }

        const shouldOfferDispatch =
          detectDispatchRecommendation(analysisMarkdown);
        const recommendedActionHint =
          shouldOfferDispatch === true ? 'create_work_order' : null;

        const alarmRecord = normalizeAlarmRecord(
          normalizedInput.alarms[0] as Record<string, unknown>,
        );

        let flexMessage;
        try {
          flexMessage = await buildAlarmAnalysisFlexMessageWithFallback(
            alarmRecord,
            analysisMarkdown,
            recommendedActionHint,
            shouldOfferDispatch,
            undefined,
          );
        } catch (flexError) {
          alarmToolLogger.warn('Flex Message build failed, using fallback', {
            error: flexError instanceof Error ? flexError.message : 'Unknown error',
          });
          flexMessage = buildAlarmAnalysisFlexMessage({
            alarm: alarmRecord,
            analysisMarkdown,
            recommendedAction: recommendedActionHint === 'create_work_order' ? 'dispatch' : null,
          });
        }

        alarmToolLogger.debug('analyze_alarm output', {
          sessionId: normalizedInput.session_id,
          eventCount: streamResult.events.length,
          analysisLength: analysisMarkdown.length,
          shouldOfferDispatch,
          flexMessageBuilt: true,
          durationMs: Date.now() - startedAt,
        });

        return {
          success: true,
          session_id: normalizedInput.session_id,
          analysis_markdown: analysisMarkdown,
          flex_message: flexMessage,
          raw_events: streamResult.events,
          should_offer_dispatch: shouldOfferDispatch,
          recommended_action_hint: recommendedActionHint,
        };
      } catch (error) {
        alarmToolLogger.warn('analyze_alarm failed', {
          durationMs: Date.now() - startedAt,
          errorType:
            error instanceof AlarmAgentClientError ? error.type : 'UNKNOWN',
        });

        return mapAlarmToolError('analysis', error);
      }
    },
    {
      name: ANALYZE_ALARM_TOOL_NAME,
      description: [
        '分析指定告警并返回结构化 analysis_markdown 和 flex_message。',
        '调用 /api/v1/process_alarms 时，会优先从告警对象里的 raw_data 解析原始告警并填入 alarms 数组，同时确保 id 不为空。',
        '这个工具会消费告警后端的 SSE 响应，不会把原始 SSE 文本直接暴露给 Agent。',
        '返回的 flex_message 可直接用于 LINE Bot 发送。',
      ].join(' '),
      schema: ANALYZE_ALARM_SCHEMA,
    },
  );
};

export const createAlarmTools = (
  options: AlarmToolsOptions = {},
): AlarmTool[] => {
  const client =
    options.client ??
    new AlarmAgentClient({
      baseUrl: config.alarmAgentBaseUrl,
      timeoutMs: config.alarmAgentTimeoutMs,
      ...options.clientOptions,
    });

  return [
    createCreateAlarmSessionTool(client),
    createListAlarmsTool(client),
    createAnalyzeAlarmTool(client),
  ];
};

export type { AlarmTool };
