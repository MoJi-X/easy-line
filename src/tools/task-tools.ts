import { tool } from "langchain";

import { AppError, type AppErrorDetail } from "../errors/app-error";
import { createAppLogger } from "../utils/app-logger";
import {
  taskRepository as defaultTaskRepository,
  normalizeAlertScope,
  type AlarmFetchTask,
  type TaskRepository,
} from "../services/task-repository";

const taskToolLogger = createAppLogger("task-tools");

export const TASK_CREATE_TOOL_NAME = "task.create";
export const TASK_DELETE_TOOL_NAME = "task.delete";
export const TASK_LIST_TOOL_NAME = "task.list";
export const TASK_UPDATE_TOOL_NAME = "task.update";

interface TaskToolDependencies {
  taskRepository?: TaskRepository;
}

export interface TaskToolsOptions {
  taskRepository?: TaskRepository;
}

export interface TaskCommandInput {
  userId: string;
  message: string;
}

export interface TaskCommandResult {
  reply: string;
  usedTools: string[];
}

export interface TaskToolFailure {
  code?: string;
  details?: AppErrorDetail[];
  error_type: "invalid_tool_input" | "task_operation_failed";
  message: string;
  status_code?: number;
  success: false;
}

export interface TaskCreateSuccess {
  reply: string;
  success: true;
  task: AlarmFetchTask;
}

export interface TaskDeleteSuccess {
  deleted: true;
  reply: string;
  success: true;
  taskId: string;
}

export interface TaskListSuccess {
  reply: string;
  success: true;
  tasks: AlarmFetchTask[];
}

export interface TaskUpdateSuccess {
  reply: string;
  success: true;
  task: AlarmFetchTask;
}

type TaskCommandAction = "create" | "delete" | "list" | "update";

interface ParsedTaskCommand {
  action: TaskCommandAction;
  args: Record<string, string>;
}

type CreateTaskToolInput = {
  alertScope: string;
  cron: string;
  enabled?: boolean;
  userId: string;
};

type ListTaskToolInput = {
  userId: string;
};

type UpdateTaskToolInput = {
  alertScope?: string;
  cron?: string;
  enabled?: boolean;
  taskId: string;
  userId: string;
};

type DeleteTaskToolInput = {
  taskId: string;
  userId: string;
};

const TASK_COMMAND_USAGE = [
  "可用命令：",
  "/task list",
  '/task create alertScope=当前告警信息 cron="0 0 8 * * *" enabled=true',
  '/task update taskId=alarm-task-001 cron="0 0 9 * * *"',
  "/task delete taskId=alarm-task-001",
].join("\n");

const CREATE_TASK_SCHEMA = {
  type: "object",
  properties: {
    userId: { type: "string" },
    alertScope: { type: "string" },
    cron: { type: "string" },
    enabled: { type: "boolean", default: true },
  },
  required: ["userId", "alertScope", "cron"],
  additionalProperties: false,
} as const;

const LIST_TASK_SCHEMA = {
  type: "object",
  properties: {
    userId: { type: "string" },
  },
  required: ["userId"],
  additionalProperties: false,
} as const;

const UPDATE_TASK_SCHEMA = {
  type: "object",
  properties: {
    userId: { type: "string" },
    taskId: { type: "string" },
    alertScope: { type: "string" },
    cron: { type: "string" },
    enabled: { type: "boolean" },
  },
  required: ["userId", "taskId"],
  additionalProperties: false,
} as const;

const DELETE_TASK_SCHEMA = {
  type: "object",
  properties: {
    userId: { type: "string" },
    taskId: { type: "string" },
  },
  required: ["userId", "taskId"],
  additionalProperties: false,
} as const;

const formatTaskSummary = (task: AlarmFetchTask): string => {
  return `[${task.id}] ${task.name} 范围=${task.alertScope} Cron=${task.cron} 状态=${task.enabled ? "启用" : "停用"} 来源=${task.source}`;
};

const getRequiredText = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw new AppError(
      400,
      "INVALID_ARGUMENT",
      `${field} must be a non-empty string.`,
      [
        {
          field,
          message: "Expected a non-empty string.",
        },
      ],
    );
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw new AppError(
      400,
      "INVALID_ARGUMENT",
      `${field} must be a non-empty string.`,
      [
        {
          field,
          message: "Expected a non-empty string.",
        },
      ],
    );
  }

  return normalizedValue;
};

const getOptionalText = (value: unknown, field: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return getRequiredText(value, field);
};

const getOptionalBoolean = (
  value: unknown,
  field: string,
): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new AppError(
      400,
      "INVALID_ARGUMENT",
      `${field} must be a boolean value.`,
      [
        {
          field,
          message: "Expected a boolean value.",
        },
      ],
    );
  }

  return value;
};

const parseBooleanFlag = (value: string): boolean | null => {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return null;
};

const tokenizeTaskCommand = (message: string): string[] | null => {
  const tokens: string[] = [];
  let currentToken = "";
  let inQuotes = false;

  for (const character of message.trim()) {
    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (/\s/u.test(character) && !inQuotes) {
      if (currentToken) {
        tokens.push(currentToken);
        currentToken = "";
      }
      continue;
    }

    currentToken += character;
  }

  if (inQuotes) {
    return null;
  }

  if (currentToken) {
    tokens.push(currentToken);
  }

  return tokens;
};

const parseTaskCommand = (message: string): ParsedTaskCommand | null => {
  const trimmedMessage = message.trim();

  if (!trimmedMessage.startsWith("/task")) {
    return null;
  }

  const tokens = tokenizeTaskCommand(trimmedMessage);

  if (!tokens) {
    return {
      action: "list",
      args: {
        __invalid__: "unterminated_quote",
      },
    };
  }

  const action = tokens[1] as TaskCommandAction | undefined;

  if (!action || !["create", "delete", "list", "update"].includes(action)) {
    return {
      action: "list",
      args: {
        __invalid__: "true",
      },
    };
  }

  const args = tokens.slice(2).reduce<Record<string, string>>((acc, token) => {
    const separatorIndex = token.indexOf("=");

    if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
      acc.__invalid__ = token;
      return acc;
    }

    const key = token.slice(0, separatorIndex);
    const value = token.slice(separatorIndex + 1);

    acc[key] = value;
    return acc;
  }, {});

  return {
    action,
    args,
  };
};

const buildUsageReply = (message: string): TaskCommandResult => {
  return {
    reply: `${message}\n${TASK_COMMAND_USAGE}`,
    usedTools: [],
  };
};

export const buildTaskCreatedReply = (task: AlarmFetchTask): string => {
  return `已创建任务 ${formatTaskSummary(task)}`;
};

export const buildTaskUpdatedReply = (task: AlarmFetchTask): string => {
  return `已更新任务 ${formatTaskSummary(task)}`;
};

export const buildTaskDeletedReply = (taskId: string): string => {
  return `已删除任务 [${taskId}]。`;
};

export const buildTaskListReply = (tasks: AlarmFetchTask[]): string => {
  if (tasks.length === 0) {
    return `你当前还没有告警定时任务。\n${TASK_COMMAND_USAGE}`;
  }

  return [
    "当前任务列表：",
    ...tasks.map((task) => formatTaskSummary(task)),
  ].join("\n");
};

const mapTaskToolError = (error: unknown): TaskToolFailure => {
  if (error instanceof AppError) {
    return {
      success: false,
      error_type: "task_operation_failed",
      message: error.message,
      code: error.code,
      details: error.details,
      status_code: error.statusCode,
    };
  }

  return {
    success: false,
    error_type: "task_operation_failed",
    message:
      error instanceof Error ? error.message : "Unknown task tool error.",
  };
};

const handleAppError = (
  error: AppError,
  usedToolName: string,
): TaskCommandResult => {
  if (error.statusCode >= 500) {
    throw error;
  }

  return {
    reply: error.message,
    usedTools: [usedToolName],
  };
};

const createTaskCreateTool = (taskRepository: TaskRepository) => {
  return tool(
    async (
      input: Record<string, unknown>,
    ): Promise<TaskCreateSuccess | TaskToolFailure> => {
      const startedAt = Date.now();

      try {
        const task = taskRepository.createTask({
          userId: getRequiredText(input.userId, "userId"),
          alertScope: normalizeAlertScope(input.alertScope),
          cron: getRequiredText(input.cron, "cron"),
          enabled: getOptionalBoolean(input.enabled, "enabled"),
          source: "natural_language",
        });

        taskToolLogger.debug("task.create output", {
          taskId: task.id,
          durationMs: Date.now() - startedAt,
        });

        return {
          success: true,
          task,
          reply: buildTaskCreatedReply(task),
        };
      } catch (error) {
        taskToolLogger.warn("task.create failed", {
          durationMs: Date.now() - startedAt,
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        });
        return mapTaskToolError(error);
      }
    },
    {
      name: TASK_CREATE_TOOL_NAME,
      description:
        "为当前用户创建一个告警信息定时任务，必须传入当前会话 userId、告警范围 alertScope 和 6 字段 cron 表达式；不要编造 userId、alertScope 或 cron。",
      schema: CREATE_TASK_SCHEMA,
    },
  );
};

const createTaskListTool = (taskRepository: TaskRepository) => {
  return tool(
    async (
      input: Record<string, unknown>,
    ): Promise<TaskListSuccess | TaskToolFailure> => {
      const startedAt = Date.now();

      try {
        const tasks = taskRepository.listTasksByOwner(
          getRequiredText(input.userId, "userId"),
        );

        taskToolLogger.debug("task.list output", {
          taskCount: tasks.length,
          durationMs: Date.now() - startedAt,
        });

        return {
          success: true,
          tasks,
          reply: buildTaskListReply(tasks),
        };
      } catch (error) {
        taskToolLogger.warn("task.list failed", {
          durationMs: Date.now() - startedAt,
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        });
        return mapTaskToolError(error);
      }
    },
    {
      name: TASK_LIST_TOOL_NAME,
      description:
        "查询当前用户已有的告警信息定时任务列表，必须使用当前会话的 userId，不要编造其他用户。",
      schema: LIST_TASK_SCHEMA,
    },
  );
};

const createTaskUpdateTool = (taskRepository: TaskRepository) => {
  return tool(
    async (
      input: Record<string, unknown>,
    ): Promise<TaskUpdateSuccess | TaskToolFailure> => {
      const startedAt = Date.now();

      try {
        const task = taskRepository.updateTask({
          userId: getRequiredText(input.userId, "userId"),
          taskId: getRequiredText(input.taskId, "taskId"),
          alertScope: getOptionalText(input.alertScope, "alertScope"),
          cron: getOptionalText(input.cron, "cron"),
          enabled: getOptionalBoolean(input.enabled, "enabled"),
        });

        taskToolLogger.debug("task.update output", {
          taskId: task.id,
          durationMs: Date.now() - startedAt,
        });

        return {
          success: true,
          task,
          reply: buildTaskUpdatedReply(task),
        };
      } catch (error) {
        taskToolLogger.warn("task.update failed", {
          durationMs: Date.now() - startedAt,
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        });
        return mapTaskToolError(error);
      }
    },
    {
      name: TASK_UPDATE_TOOL_NAME,
      description:
        "更新当前用户的告警信息定时任务，可修改 alertScope、cron 或 enabled；必须使用当前会话 userId，不要编造 taskId、alertScope 或 cron。",
      schema: UPDATE_TASK_SCHEMA,
    },
  );
};

const createTaskDeleteTool = (taskRepository: TaskRepository) => {
  return tool(
    async (
      input: Record<string, unknown>,
    ): Promise<TaskDeleteSuccess | TaskToolFailure> => {
      const startedAt = Date.now();

      try {
        const result = taskRepository.deleteTask(
          getRequiredText(input.taskId, "taskId"),
          getRequiredText(input.userId, "userId"),
        );

        taskToolLogger.debug("task.delete output", {
          taskId: result.taskId,
          durationMs: Date.now() - startedAt,
        });

        return {
          success: true,
          taskId: result.taskId,
          deleted: true,
          reply: buildTaskDeletedReply(result.taskId),
        };
      } catch (error) {
        taskToolLogger.warn("task.delete failed", {
          durationMs: Date.now() - startedAt,
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        });
        return mapTaskToolError(error);
      }
    },
    {
      name: TASK_DELETE_TOOL_NAME,
      description:
        "删除当前用户自己的告警信息定时任务，必须使用当前会话 userId，不要编造其他用户或 taskId。",
      schema: DELETE_TASK_SCHEMA,
    },
  );
};

export const createTaskTools = (options: TaskToolsOptions = {}): TaskTool[] => {
  const taskRepository = options.taskRepository ?? defaultTaskRepository;

  return [
    createTaskCreateTool(taskRepository),
    createTaskListTool(taskRepository),
    createTaskUpdateTool(taskRepository),
    createTaskDeleteTool(taskRepository),
  ];
};

export const tryHandleTaskCommand = (
  input: TaskCommandInput,
  dependencies: TaskToolDependencies = {},
): TaskCommandResult | null => {
  const startedAt = Date.now();
  const parsedCommand = parseTaskCommand(input.message);

  if (!parsedCommand) {
    return null;
  }

  taskToolLogger.debug("task command input", {
    action: parsedCommand.action,
    userId: input.userId,
    hasArgs: !parsedCommand.args.__invalid__,
  });

  if (parsedCommand.args.__invalid__) {
    taskToolLogger.warn("task command invalid", {
      action: parsedCommand.action,
      durationMs: Date.now() - startedAt,
    });
    return buildUsageReply("命令格式无效。");
  }

  const taskRepository = dependencies.taskRepository ?? defaultTaskRepository;

  switch (parsedCommand.action) {
    case "list": {
      if (Object.keys(parsedCommand.args).length > 0) {
        return buildUsageReply("/task list 不接受额外参数。");
      }

      const tasks = taskRepository.listTasksByOwner(input.userId);

      taskToolLogger.debug("task list output", {
        taskCount: tasks.length,
        durationMs: Date.now() - startedAt,
      });

      return {
        reply: buildTaskListReply(tasks),
        usedTools: [TASK_LIST_TOOL_NAME],
      };
    }

    case "create": {
      const alertScope =
        parsedCommand.args.alertScope ?? parsedCommand.args.scope;
      const taskCron = parsedCommand.args.cron;

      if (!alertScope || !taskCron) {
        return buildUsageReply("/task create 需要 alertScope 和 cron 参数。");
      }

      let enabled: boolean | undefined;

      if (parsedCommand.args.enabled !== undefined) {
        const parsedEnabled = parseBooleanFlag(parsedCommand.args.enabled);

        if (parsedEnabled === null) {
          return buildUsageReply("enabled 只能是 true 或 false。");
        }

        enabled = parsedEnabled;
      }

      try {
        const task = taskRepository.createTask({
          userId: input.userId,
          alertScope,
          cron: taskCron,
          enabled,
          source: "slash_command",
        });

        taskToolLogger.debug("task create output", {
          taskId: task.id,
          alertScope: task.alertScope,
          cron: task.cron,
          durationMs: Date.now() - startedAt,
        });

        return {
          reply: buildTaskCreatedReply(task),
          usedTools: [TASK_CREATE_TOOL_NAME],
        };
      } catch (error) {
        if (error instanceof AppError) {
          taskToolLogger.warn("task create failed", {
            alertScope,
            cron: taskCron,
            durationMs: Date.now() - startedAt,
            errorMessage: error.message,
          });
          return handleAppError(error, TASK_CREATE_TOOL_NAME);
        }

        throw error;
      }
    }

    case "update": {
      const taskId = parsedCommand.args.taskId;

      if (!taskId) {
        return buildUsageReply("/task update 需要 taskId 参数。");
      }

      let enabled: boolean | undefined;

      if (parsedCommand.args.enabled !== undefined) {
        const parsedEnabled = parseBooleanFlag(parsedCommand.args.enabled);

        if (parsedEnabled === null) {
          return buildUsageReply("enabled 只能是 true 或 false。");
        }

        enabled = parsedEnabled;
      }

      const alertScope =
        parsedCommand.args.alertScope ?? parsedCommand.args.scope;
      const taskCron = parsedCommand.args.cron;

      if (
        alertScope === undefined &&
        taskCron === undefined &&
        enabled === undefined
      ) {
        return buildUsageReply(
          "/task update 至少需要 alertScope、cron 或 enabled 中的一个参数。",
        );
      }

      try {
        const task = taskRepository.updateTask({
          userId: input.userId,
          taskId,
          alertScope,
          cron: taskCron,
          enabled,
        });

        taskToolLogger.debug("task update output", {
          taskId: task.id,
          durationMs: Date.now() - startedAt,
        });

        return {
          reply: buildTaskUpdatedReply(task),
          usedTools: [TASK_UPDATE_TOOL_NAME],
        };
      } catch (error) {
        if (error instanceof AppError) {
          taskToolLogger.warn("task update failed", {
            taskId,
            durationMs: Date.now() - startedAt,
            errorMessage: error.message,
          });
          return handleAppError(error, TASK_UPDATE_TOOL_NAME);
        }

        throw error;
      }
    }

    case "delete": {
      const taskId = parsedCommand.args.taskId;

      if (!taskId) {
        return buildUsageReply("/task delete 需要 taskId 参数。");
      }

      try {
        const result = taskRepository.deleteTask(taskId, input.userId);

        taskToolLogger.debug("task delete output", {
          taskId: result.taskId,
          durationMs: Date.now() - startedAt,
        });

        return {
          reply: buildTaskDeletedReply(result.taskId),
          usedTools: [TASK_DELETE_TOOL_NAME],
        };
      } catch (error) {
        if (error instanceof AppError) {
          taskToolLogger.warn("task delete failed", {
            taskId,
            durationMs: Date.now() - startedAt,
            errorMessage: error.message,
          });
          return handleAppError(error, TASK_DELETE_TOOL_NAME);
        }

        throw error;
      }
    }
  }
};

export const taskCommandUsage = TASK_COMMAND_USAGE;

export type TaskTool =
  | ReturnType<typeof createTaskCreateTool>
  | ReturnType<typeof createTaskDeleteTool>
  | ReturnType<typeof createTaskListTool>
  | ReturnType<typeof createTaskUpdateTool>;
