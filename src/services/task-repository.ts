import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';

import { AppError, type AppErrorDetail } from '../errors/app-error';
import { createAppLogger } from '../utils/app-logger';
import { maskUserId } from '../utils/logger';

export const TASKS_CONFIG_PATH = path.resolve(
  process.cwd(),
  'src/config/tasks.json',
);

export const ALARM_FETCH_TASK_TYPE = 'alarm_info_fetch';
const CRON_SEGMENT_COUNT = 6;
const taskRepositoryLogger = createAppLogger('task-repository');
const TASK_SOURCE_VALUES = [
  'api',
  'api_seed',
  'natural_language',
  'slash_command',
] as const;

type TaskCollectionChangeAction = 'create' | 'delete' | 'reload' | 'update';

export type TaskSource = (typeof TASK_SOURCE_VALUES)[number];
export type RuntimeTaskSource = Exclude<TaskSource, 'api_seed'>;
export type TaskRepositoryListener = (
  event: TaskRepositoryChangeEvent,
) => void;

export interface AlarmFetchTask {
  id: string;
  type: typeof ALARM_FETCH_TASK_TYPE;
  name: string;
  ownerUserId: string;
  alertScope: string;
  cron: string;
  enabled: boolean;
  source: TaskSource;
  createdAt: string;
  updatedAt: string;
}

interface TasksFile {
  tasks: AlarmFetchTask[];
}

export interface CreateTaskInput {
  userId: string;
  alertScope: string;
  cron: string;
  enabled?: boolean;
  source?: RuntimeTaskSource;
}

export interface UpdateTaskInput {
  userId: string;
  taskId: string;
  alertScope?: string;
  cron?: string;
  enabled?: boolean;
}

export interface TaskRepositoryChangeEvent {
  action: TaskCollectionChangeAction;
  task?: AlarmFetchTask;
  tasks: AlarmFetchTask[];
}

interface TaskRepositoryOptions {
  filePath?: string;
  now?: () => Date;
  generateId?: () => string;
}

const cloneTask = (task: AlarmFetchTask): AlarmFetchTask => {
  return { ...task };
};

const buildTaskName = (alertScope: string): string => {
  return `${alertScope}定时获取`;
};

const sortTasks = (tasks: AlarmFetchTask[]): AlarmFetchTask[] => {
  return [...tasks].sort((left, right) => {
    const createdAtCompare = left.createdAt.localeCompare(right.createdAt);

    if (createdAtCompare !== 0) {
      return createdAtCompare;
    }

    return left.id.localeCompare(right.id);
  });
};

const buildInvalidArgumentError = (
  message: string,
  details?: AppErrorDetail[],
): AppError => {
  return new AppError(400, 'INVALID_ARGUMENT', message, details);
};

const assertNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw buildInvalidArgumentError(`${field} must be a non-empty string.`, [
      {
        field,
        message: 'Expected a non-empty string.',
      },
    ]);
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw buildInvalidArgumentError(`${field} must be a non-empty string.`, [
      {
        field,
        message: 'Expected a non-empty string.',
      },
    ]);
  }

  return normalizedValue;
};

export const normalizeAlertScope = (value: unknown): string => {
  const normalizedValue = assertNonEmptyString(value, 'alertScope')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?]/gu, '');

  if (
    /^(untreated|未处理|当前未处理|未处理告警|当前未处理告警)$/iu.test(
      normalizedValue,
    )
  ) {
    return '当前未处理告警';
  }

  if (
    /^(all|全部|所有|全部告警|所有告警|当前告警|当前告警信息|告警信息)$/iu.test(
      normalizedValue,
    )
  ) {
    return '当前告警信息';
  }

  return normalizedValue;
};

const buildCronValidationError = (): AppError => {
  return buildInvalidArgumentError(
    'cron must use a valid 6-field cron expression, for example "0 0 8 * * *".',
    [
      {
        field: 'cron',
        message:
          'Expected a valid 6-field cron expression such as "0 0 8 * * *".',
      },
    ],
  );
};

export const normalizeCronExpression = (value: unknown): string => {
  const normalizedValue = assertNonEmptyString(value, 'cron').replace(
    /\s+/g,
    ' ',
  );

  if (normalizedValue.split(' ').length !== CRON_SEGMENT_COUNT) {
    throw buildCronValidationError();
  }

  if (!cron.validate(normalizedValue)) {
    throw buildCronValidationError();
  }

  return normalizedValue;
};

const assertBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') {
    throw buildInvalidArgumentError(`${field} must be a boolean value.`, [
      {
        field,
        message: 'Expected a boolean value.',
      },
    ]);
  }

  return value;
};

const isTaskSource = (value: string): value is TaskSource => {
  return TASK_SOURCE_VALUES.includes(value as TaskSource);
};

const assertRuntimeTaskSource = (value: unknown): RuntimeTaskSource => {
  const normalizedValue = assertNonEmptyString(value, 'source');

  if (!isTaskSource(normalizedValue) || normalizedValue === 'api_seed') {
    throw buildInvalidArgumentError(
      'source must be one of api, natural_language or slash_command.',
      [
        {
          field: 'source',
          message:
            'Expected one of api, natural_language or slash_command.',
        },
      ],
    );
  }

  return normalizedValue;
};

const assertIsoTimestamp = (value: unknown, field: string): string => {
  const normalizedValue = assertNonEmptyString(value, field);

  if (Number.isNaN(Date.parse(normalizedValue))) {
    throw new Error(`${field} must be a valid ISO 8601 timestamp.`);
  }

  return normalizedValue;
};

const normalizeLoadedTask = (record: unknown): AlarmFetchTask => {
  if (!record || typeof record !== 'object') {
    throw new Error('task record must be an object.');
  }

  const data = record as Record<string, unknown>;
  const type = assertNonEmptyString(data.type, 'type');

  if (type !== ALARM_FETCH_TASK_TYPE) {
    throw new Error(`type must be ${ALARM_FETCH_TASK_TYPE}.`);
  }

  const source = assertNonEmptyString(data.source, 'source');

  if (!isTaskSource(source)) {
    throw new Error(
      'source must be one of api, api_seed, natural_language or slash_command.',
    );
  }

  const alertScope = normalizeAlertScope(data.alertScope);

  return {
    id: assertNonEmptyString(data.id, 'id'),
    type: ALARM_FETCH_TASK_TYPE,
    name: buildTaskName(alertScope),
    ownerUserId: assertNonEmptyString(data.ownerUserId, 'ownerUserId'),
    alertScope,
    cron: normalizeCronExpression(data.cron),
    enabled: assertBoolean(data.enabled, 'enabled'),
    source,
    createdAt: assertIsoTimestamp(data.createdAt, 'createdAt'),
    updatedAt: assertIsoTimestamp(data.updatedAt, 'updatedAt'),
  };
};

export class TaskRepository {
  private tasksById = new Map<string, AlarmFetchTask>();

  private readonly listeners = new Set<TaskRepositoryListener>();

  private readonly filePath: string;

  private readonly now: () => Date;

  private readonly generateId: () => string;

  constructor(options: TaskRepositoryOptions = {}) {
    this.filePath = options.filePath ?? TASKS_CONFIG_PATH;
    this.now = options.now ?? (() => new Date());
    this.generateId =
      options.generateId ?? (() => `alarm-task-${randomUUID().slice(0, 8)}`);

    this.loadFromDisk();
  }

  subscribe(listener: TaskRepositoryListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  listTasksByOwner(userId: string): AlarmFetchTask[] {
    const normalizedUserId = assertNonEmptyString(userId, 'userId');

    return sortTasks(
      Array.from(this.tasksById.values())
        .filter((task) => task.ownerUserId === normalizedUserId)
        .map((task) => cloneTask(task)),
    );
  }

  listAllTasks(): AlarmFetchTask[] {
    return sortTasks(
      Array.from(this.tasksById.values()).map((task) => cloneTask(task)),
    );
  }

  createTask(input: CreateTaskInput): AlarmFetchTask {
    const ownerUserId = assertNonEmptyString(input.userId, 'userId');
    const alertScope = normalizeAlertScope(input.alertScope);
    const taskCron = normalizeCronExpression(input.cron);
    const enabled = input.enabled ?? true;

    if (typeof enabled !== 'boolean') {
      throw buildInvalidArgumentError('enabled must be a boolean value.', [
        {
          field: 'enabled',
          message: 'Expected a boolean value.',
        },
      ]);
    }

    const source = input.source
      ? assertRuntimeTaskSource(input.source)
      : 'api';
    const timestamp = this.now().toISOString();
    const task: AlarmFetchTask = {
      id: this.generateId(),
      type: ALARM_FETCH_TASK_TYPE,
      name: buildTaskName(alertScope),
      ownerUserId,
      alertScope,
      cron: taskCron,
      enabled,
      source,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const nextTasksById = new Map(this.tasksById);

    nextTasksById.set(task.id, task);
    this.persist(nextTasksById, 'create', task);

    return cloneTask(task);
  }

  updateTask(input: UpdateTaskInput): AlarmFetchTask {
    const ownerUserId = assertNonEmptyString(input.userId, 'userId');
    const taskId = assertNonEmptyString(input.taskId, 'taskId');
    const currentTask = this.getOwnedTask(taskId, ownerUserId);

    if (
      input.alertScope === undefined &&
      input.cron === undefined &&
      input.enabled === undefined
    ) {
      throw buildInvalidArgumentError(
        'At least one of alertScope, cron or enabled must be provided.',
        [
          {
            field: 'body',
            message: 'Expected at least one updatable task field.',
          },
        ],
      );
    }

    const alertScope =
      input.alertScope === undefined
        ? currentTask.alertScope
        : normalizeAlertScope(input.alertScope);
    const taskCron =
      input.cron === undefined
        ? currentTask.cron
        : normalizeCronExpression(input.cron);
    const enabled =
      input.enabled === undefined
        ? currentTask.enabled
        : assertBoolean(input.enabled, 'enabled');
    const updatedTask: AlarmFetchTask = {
      ...currentTask,
      alertScope,
      cron: taskCron,
      enabled,
      name: buildTaskName(alertScope),
      updatedAt: this.now().toISOString(),
    };
    const nextTasksById = new Map(this.tasksById);

    nextTasksById.set(taskId, updatedTask);
    this.persist(nextTasksById, 'update', updatedTask);

    return cloneTask(updatedTask);
  }

  deleteTask(taskId: string, userId: string): { taskId: string; deleted: true } {
    const normalizedUserId = assertNonEmptyString(userId, 'userId');
    const normalizedTaskId = assertNonEmptyString(taskId, 'taskId');
    const task = this.getOwnedTask(normalizedTaskId, normalizedUserId);
    const nextTasksById = new Map(this.tasksById);

    nextTasksById.delete(normalizedTaskId);
    this.persist(nextTasksById, 'delete', task);

    return {
      taskId: normalizedTaskId,
      deleted: true,
    };
  }

  reload(): void {
    this.loadFromDisk();
  }

  private ensureFileExists(): void {
    const directoryPath = path.dirname(this.filePath);

    mkdirSync(directoryPath, { recursive: true });

    if (existsSync(this.filePath)) {
      return;
    }

    writeFileSync(
      this.filePath,
      `${JSON.stringify({ tasks: [] }, null, 2)}\n`,
      'utf-8',
    );

    taskRepositoryLogger.warn('task file did not exist and was initialized', {
      filePath: this.filePath,
    });
  }

  private notifyListeners(event: TaskRepositoryChangeEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener({
          action: event.action,
          task: event.task ? cloneTask(event.task) : undefined,
          tasks: event.tasks.map((task) => cloneTask(task)),
        });
      } catch (error) {
        taskRepositoryLogger.warn('task repository listener failed', {
          action: event.action,
          filePath: this.filePath,
          reason: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
  }

  private readTasksFile(): TasksFile {
    this.ensureFileExists();

    try {
      const fileContent = readFileSync(this.filePath, 'utf-8');
      const parsedContent = JSON.parse(fileContent) as { tasks?: unknown };

      if (!Array.isArray(parsedContent.tasks)) {
        throw new Error('tasks must be an array.');
      }

      return {
        tasks: parsedContent.tasks as AlarmFetchTask[],
      };
    } catch (error) {
      taskRepositoryLogger.error(
        'failed to read task file',
        {
          filePath: this.filePath,
        },
        error,
      );

      throw new AppError(
        500,
        'INTERNAL_ERROR',
        'Failed to load tasks config from src/config/tasks.json.',
      );
    }
  }

  private loadFromDisk(): void {
    const rawTasks = this.readTasksFile().tasks;
    const nextTasksById = new Map<string, AlarmFetchTask>();

    rawTasks.forEach((rawTask, index) => {
      try {
        const task = normalizeLoadedTask(rawTask);

        if (nextTasksById.has(task.id)) {
          taskRepositoryLogger.warn('duplicate task skipped while loading', {
            filePath: this.filePath,
            index,
            taskId: task.id,
          });
          return;
        }

        nextTasksById.set(task.id, task);
      } catch (error) {
        taskRepositoryLogger.warn('invalid task skipped while loading', {
          filePath: this.filePath,
          index,
          reason: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    this.tasksById = nextTasksById;

    taskRepositoryLogger.info('task repository loaded from disk', {
      filePath: this.filePath,
      taskCount: this.tasksById.size,
    });

    this.notifyListeners({
      action: 'reload',
      tasks: this.listAllTasks(),
    });
  }

  private getOwnedTask(taskId: string, userId: string): AlarmFetchTask {
    const task = this.tasksById.get(taskId);

    if (!task) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', `Task not found: ${taskId}`);
    }

    if (task.ownerUserId !== userId) {
      throw new AppError(
        403,
        'FORBIDDEN_TASK_ACCESS',
        `Task ${taskId} does not belong to the current user.`,
      );
    }

    return cloneTask(task);
  }

  private persist(
    nextTasksById: Map<string, AlarmFetchTask>,
    action: 'create' | 'update' | 'delete',
    task: AlarmFetchTask,
  ): void {
    const nextTasks = sortTasks(Array.from(nextTasksById.values()));
    const fileContent = {
      tasks: nextTasks,
    };

    try {
      writeFileSync(
        this.filePath,
        `${JSON.stringify(fileContent, null, 2)}\n`,
        'utf-8',
      );
    } catch (error) {
      taskRepositoryLogger.error(
        'failed to persist task changes',
        {
          action,
          filePath: this.filePath,
          taskId: task.id,
          ownerUserId: maskUserId(task.ownerUserId),
        },
        error,
      );

      throw new AppError(
        500,
        'INTERNAL_ERROR',
        'Failed to persist tasks to src/config/tasks.json.',
      );
    }

    this.tasksById = nextTasksById;

    taskRepositoryLogger.info('task persisted successfully', {
      action,
      filePath: this.filePath,
      taskId: task.id,
      ownerUserId: maskUserId(task.ownerUserId),
      taskCount: this.tasksById.size,
    });

    this.notifyListeners({
      action,
      task,
      tasks: nextTasks,
    });
  }
}

export const taskRepository = new TaskRepository();
