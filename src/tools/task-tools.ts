import { AppError } from '../errors/app-error';
import {
  taskRepository as defaultTaskRepository,
  type DailyWeatherTask,
  type TaskRepository,
} from '../services/task-repository';

interface TaskToolDependencies {
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

type TaskCommandAction = 'create' | 'delete' | 'list' | 'update';

interface ParsedTaskCommand {
  action: TaskCommandAction;
  args: Record<string, string>;
}

const TASK_COMMAND_USAGE = [
  '可用命令：',
  '/task list',
  '/task create city=北京 time=08:00 enabled=true',
  '/task update taskId=weather-001 time=09:00',
  '/task delete taskId=weather-001',
].join('\n');

const formatTaskSummary = (task: DailyWeatherTask): string => {
  return `[${task.id}] ${task.name} 城市=${task.city} 时间=${task.dailyTime} 状态=${task.enabled ? '启用' : '停用'} 来源=${task.source}`;
};

const parseBooleanFlag = (value: string): boolean | null => {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return null;
};

const parseTaskCommand = (message: string): ParsedTaskCommand | null => {
  const trimmedMessage = message.trim();

  if (!trimmedMessage.startsWith('/task')) {
    return null;
  }

  const tokens = trimmedMessage.split(/\s+/);
  const action = tokens[1] as TaskCommandAction | undefined;

  if (!action || !['create', 'delete', 'list', 'update'].includes(action)) {
    return {
      action: 'list',
      args: {
        __invalid__: 'true',
      },
    };
  }

  const args = tokens.slice(2).reduce<Record<string, string>>((acc, token) => {
    const separatorIndex = token.indexOf('=');

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

const buildTaskCreatedReply = (task: DailyWeatherTask): string => {
  return `已创建任务 ${formatTaskSummary(task)}`;
};

const buildTaskUpdatedReply = (task: DailyWeatherTask): string => {
  return `已更新任务 ${formatTaskSummary(task)}`;
};

const buildTaskDeletedReply = (taskId: string): string => {
  return `已删除任务 [${taskId}]。`;
};

const buildTaskListReply = (tasks: DailyWeatherTask[]): string => {
  if (tasks.length === 0) {
    return `你当前还没有天气任务。\n${TASK_COMMAND_USAGE}`;
  }

  return ['当前任务列表：', ...tasks.map((task) => formatTaskSummary(task))].join(
    '\n',
  );
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

export const tryHandleTaskCommand = (
  input: TaskCommandInput,
  dependencies: TaskToolDependencies = {},
): TaskCommandResult | null => {
  const parsedCommand = parseTaskCommand(input.message);

  if (!parsedCommand) {
    return null;
  }

  if (parsedCommand.args.__invalid__) {
    return buildUsageReply('命令格式无效。');
  }

  const taskRepository = dependencies.taskRepository ?? defaultTaskRepository;

  switch (parsedCommand.action) {
    case 'list': {
      if (Object.keys(parsedCommand.args).length > 0) {
        return buildUsageReply('/task list 不接受额外参数。');
      }

      const tasks = taskRepository.listTasksByOwner(input.userId);

      return {
        reply: buildTaskListReply(tasks),
        usedTools: ['task.list'],
      };
    }

    case 'create': {
      const city = parsedCommand.args.city;
      const dailyTime = parsedCommand.args.time;

      if (!city || !dailyTime) {
        return buildUsageReply('/task create 需要 city 和 time 参数。');
      }

      let enabled: boolean | undefined;

      if (parsedCommand.args.enabled !== undefined) {
        const parsedEnabled = parseBooleanFlag(parsedCommand.args.enabled);

        if (parsedEnabled === null) {
          return buildUsageReply('enabled 只能是 true 或 false。');
        }

        enabled = parsedEnabled;
      }

      try {
        const task = taskRepository.createTask({
          userId: input.userId,
          city,
          dailyTime,
          enabled,
          source: 'slash_command',
        });

        return {
          reply: buildTaskCreatedReply(task),
          usedTools: ['task.create'],
        };
      } catch (error) {
        if (error instanceof AppError) {
          return handleAppError(error, 'task.create');
        }

        throw error;
      }
    }

    case 'update': {
      const taskId = parsedCommand.args.taskId;

      if (!taskId) {
        return buildUsageReply('/task update 需要 taskId 参数。');
      }

      let enabled: boolean | undefined;

      if (parsedCommand.args.enabled !== undefined) {
        const parsedEnabled = parseBooleanFlag(parsedCommand.args.enabled);

        if (parsedEnabled === null) {
          return buildUsageReply('enabled 只能是 true 或 false。');
        }

        enabled = parsedEnabled;
      }

      const city = parsedCommand.args.city;
      const dailyTime = parsedCommand.args.time;

      if (city === undefined && dailyTime === undefined && enabled === undefined) {
        return buildUsageReply(
          '/task update 至少需要 city、time 或 enabled 中的一个参数。',
        );
      }

      try {
        const task = taskRepository.updateTask({
          userId: input.userId,
          taskId,
          city,
          dailyTime,
          enabled,
        });

        return {
          reply: buildTaskUpdatedReply(task),
          usedTools: ['task.update'],
        };
      } catch (error) {
        if (error instanceof AppError) {
          return handleAppError(error, 'task.update');
        }

        throw error;
      }
    }

    case 'delete': {
      const taskId = parsedCommand.args.taskId;

      if (!taskId) {
        return buildUsageReply('/task delete 需要 taskId 参数。');
      }

      try {
        const result = taskRepository.deleteTask(taskId, input.userId);

        return {
          reply: buildTaskDeletedReply(result.taskId),
          usedTools: ['task.delete'],
        };
      } catch (error) {
        if (error instanceof AppError) {
          return handleAppError(error, 'task.delete');
        }

        throw error;
      }
    }
  }
};

export const taskCommandUsage = TASK_COMMAND_USAGE;
