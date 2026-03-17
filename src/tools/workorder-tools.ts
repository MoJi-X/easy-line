import { tool } from "langchain";

import {
  WorkOrderClient,
  WorkOrderClientError,
  type WorkOrderClientOptions,
  type WorkOrderWorkflowResponse,
} from "../clients/workorder-client";
import { config } from "../config";
import { createAppLogger } from "../utils/app-logger";

const CREATE_WORK_ORDER_TOOL_NAME = "create_work_order";
const DEFAULT_DEVICE_TYPE = "inverter";
const DEFAULT_ALARM_CATEGORY = "AlarmWorkOrder";
const DEFAULT_WORKORDER_LEVEL = "MEDIUM";
const DEFAULT_WORKORDER_STATUS = "created";
const MAX_FAULT_DESCRIPTION_LENGTH = 400;
const MIN_FAULT_DESCRIPTION_LENGTH = 100;
const workorderToolLogger = createAppLogger("workorder-tools");

type WorkOrderToolFailureType =
  | "invalid_tool_input"
  | "missing_business_context"
  | "workflow_not_configured"
  | "workorder_request_failed"
  | "workorder_response_invalid";

export interface WorkOrderToolRuntimeConfig {
  mockCreateWorkOrder: boolean;
  workorderPmmsAuthorization?: string;
  workorderTenantId?: string;
  workorderUser?: string;
}

export interface WorkOrderToolsOptions {
  client?: WorkOrderClient;
  clientOptions?: WorkOrderClientOptions;
  runtimeConfig?: Partial<WorkOrderToolRuntimeConfig>;
}

export interface CreateWorkOrderSuccess {
  acceptor: string | null;
  assignee: string | null;
  description: string | null;
  end_time: string | null;
  level: string | null;
  mock: boolean;
  raw: unknown;
  request_id?: string;
  start_time: string | null;
  status: string | null;
  success: true;
  title: string | null;
  work_order_id: string | null;
  work_order_no: string | null;
  workflow_run_id: string;
}

export interface WorkOrderToolFailure {
  error_type: WorkOrderToolFailureType;
  message: string;
  parse_error?: string;
  raw?: unknown;
  request_id?: string;
  status_code?: number;
  success: false;
}

type WorkOrderTool = ReturnType<typeof createCreateWorkOrderTool>;

interface CreateWorkOrderInput {
  alarm: Record<string, unknown>;
  analysis_markdown: string;
}

type WorkOrderWorkflowInputs = Record<string, string | number>;

const CREATE_WORK_ORDER_SCHEMA = {
  type: "object",
  properties: {
    alarm: {
      type: "object",
    },
    analysis_markdown: {
      type: "string",
    },
  },
  required: ["alarm", "analysis_markdown"],
  additionalProperties: false,
} as const;

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

const toRecord = (value: unknown): Record<string, unknown> => {
  return isRecord(value) ? value : {};
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
): string | undefined => {
  return normalizeString(pickFirstValue(value, paths));
};

const pickStringOrNumber = (
  value: unknown,
  paths: readonly (readonly string[])[],
): string | number | undefined => {
  return normalizeStringOrNumber(pickFirstValue(value, paths));
};

const parseJsonRecord = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return {};
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return {};
  }

  try {
    return toRecord(JSON.parse(normalizedValue) as unknown);
  } catch {
    return {};
  }
};

const getRawAlarmRecord = (alarm: Record<string, unknown>): Record<string, unknown> => {
  return parseJsonRecord(pickFirstValue(alarm, [["raw_data"], ["rawData"]]));
};

const resolveAlarmDeviceSn = (
  alarm: Record<string, unknown>,
): string | number | undefined => {
  const rawAlarm = getRawAlarmRecord(alarm);

  return (
    pickStringOrNumber(rawAlarm, [["externalId"], ["external_id"]]) ??
    pickStringOrNumber(alarm, [
      ["device_sn"],
      ["deviceSn"],
      ["deviceSN"],
      ["externalId"],
      ["external_id"],
    ]) ??
    pickStringOrNumber(rawAlarm, [["device_sn"], ["deviceSn"], ["deviceSN"]])
  );
};

const resolveAlarmSiteName = (
  alarm: Record<string, unknown>,
): string | undefined => {
  const rawAlarm = getRawAlarmRecord(alarm);

  return (
    pickString(rawAlarm, [["site_name"], ["siteName"]]) ??
    pickString(alarm, [
      ["site_name"],
      ["siteName"],
      ["station_name"],
      ["stationName"],
    ])
  );
};

const resolveAlarmType = (alarm: Record<string, unknown>): string | undefined => {
  const rawAlarm = getRawAlarmRecord(alarm);

  return (
    pickString(rawAlarm, [["alarm_type"], ["alarmType"]]) ??
    pickString(alarm, [["alarm_type"], ["alarmType"]])
  );
};

const resolveAlarmTypeName = (
  alarm: Record<string, unknown>,
): string | undefined => {
  const rawAlarm = getRawAlarmRecord(alarm);

  return (
    pickString(rawAlarm, [
      ["alarm_type_name"],
      ["alarmTypeName"],
      ["alarm_name"],
      ["alarmName"],
      ["alarm_type"],
      ["alarmType"],
    ]) ??
    pickString(alarm, [
      ["alarm_type_name"],
      ["alarmTypeName"],
      ["alarm_name"],
      ["alarmName"],
      ["alarm_type"],
      ["alarmType"],
    ])
  );
};

const buildToolFailure = (
  errorType: WorkOrderToolFailureType,
  message: string,
  extra: Omit<WorkOrderToolFailure, "error_type" | "message" | "success"> = {},
): WorkOrderToolFailure => {
  return {
    success: false,
    error_type: errorType,
    message,
    ...extra,
  };
};

const isCreateWorkOrderInputFailure = (
  value: CreateWorkOrderInput | WorkOrderToolFailure,
): value is WorkOrderToolFailure => {
  return "success" in value && value.success === false;
};

const normalizeCreateWorkOrderInput = (
  input: Record<string, unknown>,
): CreateWorkOrderInput | WorkOrderToolFailure => {
  const alarm = toRecord(input.alarm);
  const analysisMarkdown = normalizeString(input.analysis_markdown);

  if (Object.keys(alarm).length === 0) {
    return buildToolFailure(
      "invalid_tool_input",
      "alarm must be a non-empty object.",
    );
  }

  if (!analysisMarkdown) {
    return buildToolFailure(
      "invalid_tool_input",
      "analysis_markdown must be a non-empty string.",
    );
  }

  return {
    alarm,
    analysis_markdown: analysisMarkdown,
  };
};

const resolveRuntimeConfig = (
  runtimeConfig?: Partial<WorkOrderToolRuntimeConfig>,
): WorkOrderToolRuntimeConfig => {
  return {
    mockCreateWorkOrder:
      runtimeConfig?.mockCreateWorkOrder ?? config.mockCreateWorkOrder,
    workorderPmmsAuthorization:
      runtimeConfig?.workorderPmmsAuthorization ??
      config.workorderPmmsAuthorization,
    workorderTenantId:
      runtimeConfig?.workorderTenantId ?? config.workorderTenantId,
    workorderUser: runtimeConfig?.workorderUser ?? config.workorderUser,
  };
};

const stripMarkdown = (value: string): string => {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const ensureSentence = (value: string): string => {
  if (!value) {
    return value;
  }

  if (/[。！？.!?]$/u.test(value)) {
    return value;
  }

  return `${value}。`;
};

const normalizePunctuation = (value: string): string => {
  return value
    .replace(/[，,]{2,}/g, "，")
    .replace(/[。.]{2,}/g, "。")
    .replace(/[；;]{2,}/g, "；")
    .replace(/\s+/g, " ")
    .trim();
};

const truncateText = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
};

const buildFaultDescription = (
  alarm: Record<string, unknown>,
  analysisMarkdown: string,
): string => {
  const deviceSn = String(resolveAlarmDeviceSn(alarm) ?? "未知设备");
  const siteName = resolveAlarmSiteName(alarm) ?? "未知站点";
  const alarmTypeName = resolveAlarmTypeName(alarm) ?? "告警";
  const alarmTime =
    pickString(alarm, [
      ["created_at"],
      ["createdAt"],
      ["alarm_time"],
      ["alarmTime"],
      ["occur_time"],
      ["occurTime"],
    ]) ?? "当前";
  const faultCode = pickStringOrNumber(alarm, [
    ["fault_code"],
    ["faultCode"],
    ["alarm_code"],
    ["alarmCode"],
  ]);
  const cleanedAnalysis = stripMarkdown(analysisMarkdown);
  const faultCodeText =
    faultCode !== undefined ? `故障码 ${String(faultCode)}，` : "";
  const baseSegments = [
    `设备 ${deviceSn} 于 ${alarmTime} 在 ${siteName} 触发 ${alarmTypeName}，${faultCodeText}需结合告警分析进一步处理。`,
    cleanedAnalysis,
  ]
    .map((segment) => normalizePunctuation(ensureSentence(segment)))
    .filter((segment) => segment.length > 0);

  const fallbackSegments = [
    "建议优先核查现场设备状态、通信链路、电源情况和相关运行数据，并同步记录排查结论。",
    "如告警仍持续存在，请尽快安排人员到场复核并执行必要的工单跟进。",
  ];
  let faultDescription = normalizePunctuation(baseSegments.join(" "));
  let fallbackIndex = 0;

  while (
    faultDescription.length < MIN_FAULT_DESCRIPTION_LENGTH &&
    fallbackIndex < fallbackSegments.length
  ) {
    faultDescription = normalizePunctuation(
      `${faultDescription} ${fallbackSegments[fallbackIndex]}`,
    );
    fallbackIndex += 1;
  }

  return truncateText(faultDescription, MAX_FAULT_DESCRIPTION_LENGTH);
};

const createDateTimeString = (value: Date): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hour = String(value.getHours()).padStart(2, "0");
  const minute = String(value.getMinutes()).padStart(2, "0");
  const second = String(value.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
};

const sanitizeIdentifier = (value: string): string => {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-");
};

const buildMockWorkOrderSuccess = (
  input: CreateWorkOrderInput,
): CreateWorkOrderSuccess => {
  const alarmId = String(
    pickStringOrNumber(input.alarm, [["id"], ["alarm_id"], ["alarmId"]]) ??
      "unknown-alarm",
  );
  const siteName = resolveAlarmSiteName(input.alarm) ?? "未知站点";
  const deviceSn = String(resolveAlarmDeviceSn(input.alarm) ?? "未知设备");
  const alarmTypeName = resolveAlarmTypeName(input.alarm) ?? "告警处理";
  const now = new Date();
  const endAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const safeAlarmId = sanitizeIdentifier(alarmId);

  return {
    success: true,
    mock: true,
    workflow_run_id: `mock-run-${safeAlarmId}`,
    work_order_id: `mock-workorder-${safeAlarmId}`,
    work_order_no: `MOCK-${safeAlarmId.toUpperCase()}`,
    title: `${siteName}${deviceSn}${alarmTypeName}处理`,
    level: DEFAULT_WORKORDER_LEVEL,
    status: DEFAULT_WORKORDER_STATUS,
    assignee: "mock-assignee",
    acceptor: "mock-acceptor",
    description: "当前结果来自 mock，用于 Demo 验证，非真实业务建单。",
    start_time: createDateTimeString(now),
    end_time: createDateTimeString(endAt),
    raw: {
      mock: true,
      alarm_id: alarmId,
      analysis_markdown: input.analysis_markdown,
    },
  };
};

const buildWorkflowInputs = (
  input: CreateWorkOrderInput,
  runtimeConfig: WorkOrderToolRuntimeConfig,
): WorkOrderWorkflowInputs => {
  return {
    tenant_id: runtimeConfig.workorderTenantId as string,
    device_type:
      pickString(input.alarm, [["device_type"], ["deviceType"]]) ??
      DEFAULT_DEVICE_TYPE,
    device_sn: String(resolveAlarmDeviceSn(input.alarm) ?? "UNKNOWN_DEVICE"),
    alarm_id: String(
      pickStringOrNumber(input.alarm, [["id"], ["alarm_id"], ["alarmId"]]) ??
        "UNKNOWN_ALARM",
    ),
    alarm_category:
      pickString(input.alarm, [["alarm_category"], ["alarmCategory"]]) ??
      DEFAULT_ALARM_CATEGORY,
    alarm_type: resolveAlarmType(input.alarm) ?? "unknown_alarm",
    alarm_type_name: resolveAlarmTypeName(input.alarm) ?? "未知告警",
    fault_code:
      pickStringOrNumber(input.alarm, [
        ["fault_code"],
        ["faultCode"],
        ["alarm_code"],
        ["alarmCode"],
      ]) ?? "",
    fault_desc: buildFaultDescription(input.alarm, input.analysis_markdown),
    site_name: resolveAlarmSiteName(input.alarm) ?? "未知站点",
    pmms_authorization: runtimeConfig.workorderPmmsAuthorization as string,
  };
};

const extractOutputContainer = (payload: unknown): Record<string, unknown> => {
  const candidates = [
    getNestedValue(payload, ["data", "outputs"]),
    getNestedValue(payload, ["outputs"]),
    getNestedValue(payload, ["result", "outputs"]),
    getNestedValue(payload, ["data", "data", "outputs"]),
    getNestedValue(payload, ["data", "output"]),
    getNestedValue(payload, ["output"]),
  ];

  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      return candidate;
    }
  }

  return {};
};

const extractWorkflowRunId = (payload: unknown): string | undefined => {
  const candidate = pickStringOrNumber(payload, [
    ["workflow_run_id"],
    ["workflowRunId"],
    ["data", "workflow_run_id"],
    ["data", "workflowRunId"],
    ["data", "id"],
    ["result", "workflow_run_id"],
    ["result", "workflowRunId"],
  ]);

  return candidate !== undefined ? String(candidate) : undefined;
};

const extractWorkOrderField = (
  outputs: Record<string, unknown>,
  payload: unknown,
  paths: readonly (readonly string[])[],
): string | null => {
  const outputValue = pickStringOrNumber(outputs, paths);

  if (outputValue !== undefined) {
    return String(outputValue);
  }

  const payloadValue = pickStringOrNumber(payload, paths);
  return payloadValue !== undefined ? String(payloadValue) : null;
};

const normalizeCreateWorkOrderSuccess = (
  response: WorkOrderWorkflowResponse,
): CreateWorkOrderSuccess | WorkOrderToolFailure => {
  const workflowRunId = extractWorkflowRunId(response.data);

  if (!workflowRunId) {
    return buildToolFailure(
      "workorder_response_invalid",
      "Workorder workflow response did not include workflow_run_id.",
      {
        raw: response.data,
        request_id: response.requestId,
        status_code: response.statusCode,
      },
    );
  }

  const outputs = extractOutputContainer(response.data);

  return {
    success: true,
    mock: false,
    workflow_run_id: workflowRunId,
    work_order_id: extractWorkOrderField(outputs, response.data, [
      ["work_order_id"],
      ["workOrderId"],
      ["order_id"],
      ["orderId"],
    ]),
    work_order_no: extractWorkOrderField(outputs, response.data, [
      ["work_order_no"],
      ["workOrderNo"],
      ["order_no"],
      ["orderNo"],
      ["no"],
    ]),
    title: extractWorkOrderField(outputs, response.data, [
      ["title"],
      ["work_order_title"],
      ["workOrderTitle"],
      ["name"],
    ]),
    level: extractWorkOrderField(outputs, response.data, [
      ["level"],
      ["priority"],
      ["severity"],
    ]),
    status: extractWorkOrderField(outputs, response.data, [
      ["status"],
      ["workflow_status"],
      ["workflowStatus"],
      ["data", "status"],
    ]),
    assignee: extractWorkOrderField(outputs, response.data, [
      ["assignee"],
      ["owner"],
      ["handler"],
    ]),
    acceptor: extractWorkOrderField(outputs, response.data, [
      ["acceptor"],
      ["receiver"],
      ["accept_user"],
      ["acceptUser"],
    ]),
    description: extractWorkOrderField(outputs, response.data, [
      ["description"],
      ["summary"],
      ["remark"],
      ["remarks"],
    ]),
    start_time: extractWorkOrderField(outputs, response.data, [
      ["start_time"],
      ["startTime"],
      ["planned_start_time"],
      ["plannedStartTime"],
    ]),
    end_time: extractWorkOrderField(outputs, response.data, [
      ["end_time"],
      ["endTime"],
      ["planned_end_time"],
      ["plannedEndTime"],
      ["deadline"],
    ]),
    request_id: response.requestId,
    raw: response.data,
  };
};

const mapWorkOrderToolError = (error: unknown): WorkOrderToolFailure => {
  if (error instanceof WorkOrderClientError) {
    if (error.type === "NOT_CONFIGURED") {
      return buildToolFailure("workflow_not_configured", error.message, {
        request_id: error.requestId,
        raw: error.responseSummary,
        status_code: error.statusCode,
      });
    }

    return buildToolFailure("workorder_request_failed", error.message, {
      request_id: error.requestId,
      raw: error.responseSummary,
      status_code: error.statusCode,
    });
  }

  return buildToolFailure(
    "workorder_request_failed",
    error instanceof Error ? error.message : "Unknown workorder tool error.",
  );
};

const createCreateWorkOrderTool = (
  client: WorkOrderClient,
  runtimeConfig: WorkOrderToolRuntimeConfig,
) => {
  return tool(
    async (
      input: Record<string, unknown>,
    ): Promise<CreateWorkOrderSuccess | WorkOrderToolFailure> => {
      const startedAt = Date.now();
      const normalizedInput = normalizeCreateWorkOrderInput(input);

      workorderToolLogger.debug("create_work_order input", {
        alarmId: isCreateWorkOrderInputFailure(normalizedInput)
          ? undefined
          : pickStringOrNumber(normalizedInput.alarm, [
              ["id"],
              ["alarm_id"],
              ["alarmId"],
            ]),
        hasAnalysis: isCreateWorkOrderInputFailure(normalizedInput)
          ? undefined
          : normalizedInput.analysis_markdown.length > 0,
      });

      if (isCreateWorkOrderInputFailure(normalizedInput)) {
        workorderToolLogger.warn("create_work_order invalid input", {
          durationMs: Date.now() - startedAt,
          errorType: normalizedInput.error_type,
        });
        return normalizedInput;
      }

      if (
        !runtimeConfig.workorderTenantId ||
        !runtimeConfig.workorderPmmsAuthorization ||
        !runtimeConfig.workorderUser
      ) {
        workorderToolLogger.warn("create_work_order missing business context", {
          durationMs: Date.now() - startedAt,
          hasTenantId: Boolean(runtimeConfig.workorderTenantId),
          hasPmmsAuth: Boolean(runtimeConfig.workorderPmmsAuthorization),
          hasUser: Boolean(runtimeConfig.workorderUser),
        });
        return buildToolFailure(
          "missing_business_context",
          "缺少全局建单配置，无法创建工单。",
        );
      }

      if (runtimeConfig.mockCreateWorkOrder) {
        const result = buildMockWorkOrderSuccess(normalizedInput);
        workorderToolLogger.debug("create_work_order mock output", {
          mock: true,
          workOrderId: result.work_order_id,
          durationMs: Date.now() - startedAt,
        });
        return result;
      }

      try {
        const workflowInputs = buildWorkflowInputs(
          normalizedInput,
          runtimeConfig,
        );

        workorderToolLogger.debug("create_work_order workflow input", {
          alarmId: workflowInputs.alarm_id,
          deviceSn: workflowInputs.device_sn,
          siteName: workflowInputs.site_name,
        });

        const workflowResponse = await client.runWorkflow({
          inputs: workflowInputs,
          response_mode: "blocking",
          user: runtimeConfig.workorderUser,
        });

        const result = normalizeCreateWorkOrderSuccess(workflowResponse);

        if ("success" in result && result.success) {
          workorderToolLogger.debug("create_work_order output", {
            mock: false,
            workflowRunId: result.workflow_run_id,
            workOrderId: result.work_order_id,
            workOrderNo: result.work_order_no,
            durationMs: Date.now() - startedAt,
          });
        } else {
          workorderToolLogger.warn("create_work_order failed response", {
            errorType: (result as WorkOrderToolFailure).error_type,
            durationMs: Date.now() - startedAt,
          });
        }

        return result;
      } catch (error) {
        workorderToolLogger.warn("create_work_order failed", {
          durationMs: Date.now() - startedAt,
          errorType:
            error instanceof WorkOrderClientError ? error.type : "UNKNOWN",
        });

        return mapWorkOrderToolError(error);
      }
    },
    {
      name: CREATE_WORK_ORDER_TOOL_NAME,
      description: [
        "基于已选中的告警和 analysis_markdown 创建工单。",
        "tenant_id、pmms_authorization 和 Dify user 统一从全局配置读取，不能通过 Tool 入参覆盖。",
      ].join(" "),
      schema: CREATE_WORK_ORDER_SCHEMA,
    },
  );
};

export const createWorkOrderTools = (
  options: WorkOrderToolsOptions = {},
): WorkOrderTool[] => {
  const runtimeConfig = resolveRuntimeConfig(options.runtimeConfig);
  const client =
    options.client ??
    new WorkOrderClient({
      workflowUrl: config.workorderWorkflowUrl,
      apiKey: config.workorderWorkflowApiKey,
      timeoutMs: config.workorderWorkflowTimeoutMs,
      ...options.clientOptions,
    });

  return [createCreateWorkOrderTool(client, runtimeConfig)];
};

export type { WorkOrderTool };
