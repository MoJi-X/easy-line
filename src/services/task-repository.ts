import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { AppError, type AppErrorDetail } from '../errors/app-error';
import { createAppLogger } from '../utils/app-logger';
import { maskUserId } from '../utils/logger';

export const TASKS_CONFIG_PATH = path.resolve(
  process.cwd(),
  'src/config/tasks.json',
);

export const DAILY_WEATHER_TASK_TYPE = 'daily_weather';
const DAILY_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const taskRepositoryLogger = createAppLogger('task-repository');
const TASK_SOURCE_VALUES = [
  'api',
  'api_seed',
  'natural_language',
  'slash_command',
] as const;

export type TaskSource = (typeof TASK_SOURCE_VALUES)[number];
export type RuntimeTaskSource = Exclude<TaskSource, 'api_seed'>;

export interface DailyWeatherTask {
  id: string;
  type: typeof DAILY_WEATHER_TASK_TYPE;
  name: string;
  ownerUserId: string;
  city: string;
  dailyTime: string;
  enabled: boolean;
  source: TaskSource;
  createdAt: string;
  updatedAt: string;
}

interface TasksFile {
  tasks: DailyWeatherTask[];
}

export interface CreateTaskInput {
  userId: string;
  city: string;
  dailyTime: string;
  enabled?: boolean;
  source?: RuntimeTaskSource;
}

export interface UpdateTaskInput {
  userId: string;
  taskId: string;
  city?: string;
  dailyTime?: string;
  enabled?: boolean;
}

interface TaskRepositoryOptions {
  filePath?: string;
  now?: () => Date;
  generateId?: () => string;
}

const cloneTask = (task: DailyWeatherTask): DailyWeatherTask => {
  return { ...task };
};

const buildTaskName = (city: string): string => {
  return `${city}天气提醒`;
};

const sortTasks = (tasks: DailyWeatherTask[]): DailyWeatherTask[] => {
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

const assertDailyTime = (value: unknown): string => {
  const normalizedValue = assertNonEmptyString(value, 'dailyTime');

  if (!DAILY_TIME_PATTERN.test(normalizedValue)) {
    throw buildInvalidArgumentError('dailyTime must use HH:mm format.', [
      {
        field: 'dailyTime',
        message: 'Expected HH:mm.',
      },
    ]);
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

const normalizeLoadedTask = (record: unknown): DailyWeatherTask => {
  if (!record || typeof record !== 'object') {
    throw new Error('task record must be an object.');
  }

  const data = record as Record<string, unknown>;
  const type = assertNonEmptyString(data.type, 'type');

  if (type !== DAILY_WEATHER_TASK_TYPE) {
    throw new Error('type must be daily_weather.');
  }

  const source = assertNonEmptyString(data.source, 'source');

  if (!isTaskSource(source)) {
    throw new Error(
      'source must be one of api, api_seed, natural_language or slash_command.',
    );
  }

  return {
    id: assertNonEmptyString(data.id, 'id'),
    type: DAILY_WEATHER_TASK_TYPE,
    name: assertNonEmptyString(data.name, 'name'),
    ownerUserId: assertNonEmptyString(data.ownerUserId, 'ownerUserId'),
    city: assertNonEmptyString(data.city, 'city'),
    dailyTime: assertDailyTime(data.dailyTime),
    enabled: assertBoolean(data.enabled, 'enabled'),
    source,
    createdAt: assertIsoTimestamp(data.createdAt, 'createdAt'),
    updatedAt: assertIsoTimestamp(data.updatedAt, 'updatedAt'),
  };
};

export class TaskRepository {
  private tasksById = new Map<string, DailyWeatherTask>();

  private readonly filePath: string;

  private readonly now: () => Date;

  private readonly generateId: () => string;

  constructor(options: TaskRepositoryOptions = {}) {
    this.filePath = options.filePath ?? TASKS_CONFIG_PATH;
    this.now = options.now ?? (() => new Date());
    this.generateId =
      options.generateId ?? (() => `weather-${randomUUID().slice(0, 8)}`);

    this.loadFromDisk();
  }

  listTasksByOwner(userId: string): DailyWeatherTask[] {
    const normalizedUserId = assertNonEmptyString(userId, 'userId');

    return sortTasks(
      Array.from(this.tasksById.values())
        .filter((task) => task.ownerUserId === normalizedUserId)
        .map((task) => cloneTask(task)),
    );
  }

  listAllTasks(): DailyWeatherTask[] {
    return sortTasks(
      Array.from(this.tasksById.values()).map((task) => cloneTask(task)),
    );
  }

  createTask(input: CreateTaskInput): DailyWeatherTask {
    const ownerUserId = assertNonEmptyString(input.userId, 'userId');
    const city = assertNonEmptyString(input.city, 'city');
    const dailyTime = assertDailyTime(input.dailyTime);
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
    const task: DailyWeatherTask = {
      id: this.generateId(),
      type: DAILY_WEATHER_TASK_TYPE,
      name: buildTaskName(city),
      ownerUserId,
      city,
      dailyTime,
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

  updateTask(input: UpdateTaskInput): DailyWeatherTask {
    const ownerUserId = assertNonEmptyString(input.userId, 'userId');
    const taskId = assertNonEmptyString(input.taskId, 'taskId');
    const currentTask = this.getOwnedTask(taskId, ownerUserId);

    if (
      input.city === undefined &&
      input.dailyTime === undefined &&
      input.enabled === undefined
    ) {
      throw buildInvalidArgumentError(
        'At least one of city, dailyTime or enabled must be provided.',
        [
          {
            field: 'body',
            message: 'Expected at least one updatable task field.',
          },
        ],
      );
    }

    const city =
      input.city === undefined
        ? currentTask.city
        : assertNonEmptyString(input.city, 'city');
    const dailyTime =
      input.dailyTime === undefined
        ? currentTask.dailyTime
        : assertDailyTime(input.dailyTime);
    const enabled =
      input.enabled === undefined
        ? currentTask.enabled
        : assertBoolean(input.enabled, 'enabled');
    const updatedTask: DailyWeatherTask = {
      ...currentTask,
      city,
      dailyTime,
      enabled,
      name: buildTaskName(city),
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

  private readTasksFile(): TasksFile {
    this.ensureFileExists();

    try {
      const fileContent = readFileSync(this.filePath, 'utf-8');
      const parsedContent = JSON.parse(fileContent) as { tasks?: unknown };

      if (!Array.isArray(parsedContent.tasks)) {
        throw new Error('tasks must be an array.');
      }

      return {
        tasks: parsedContent.tasks as DailyWeatherTask[],
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
    const nextTasksById = new Map<string, DailyWeatherTask>();

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
  }

  private getOwnedTask(taskId: string, userId: string): DailyWeatherTask {
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
    nextTasksById: Map<string, DailyWeatherTask>,
    action: 'create' | 'update' | 'delete',
    task: DailyWeatherTask,
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
  }
}

export const taskRepository = new TaskRepository();
