import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import cron, { type ScheduledTask } from 'node-cron';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { AppError } from '../errors/app-error';
import { schedulerLogFilePath, schedulerLogger } from '../utils/scheduler-logger';
import { lineService } from './line';

export interface TaskApiConfig {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface SchedulerTaskConfig {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  api: TaskApiConfig;
  template: string;
  targets: string[];
}

interface TasksFile {
  tasks: SchedulerTaskConfig[];
}

type TaskExecutionStatus = 'success' | 'failed';

export type TaskExecutionTrigger = 'manual' | 'scheduled';

export interface TaskExecutionRecord {
  taskId: string;
  taskName: string;
  status: TaskExecutionStatus;
  triggeredBy: TaskExecutionTrigger;
  executedAt: string;
  durationMs: number;
  message: string;
}

interface ExecuteTaskOptions {
  trigger?: TaskExecutionTrigger;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RECORDS = 20;
const TASKS_CONFIG_PATH = path.resolve(process.cwd(), 'src/config/tasks.json');

const resolveEnvPlaceholders = (value: string): string => {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_matched, key: string) => {
    return process.env[key] ?? '';
  });
};

const renderTemplate = (template: string, payload: unknown): string => {
  const data = payload as Record<string, unknown>;

  return template.replace(/\{([^}]+)\}/g, (_matched, token: string) => {
    const pathTokens = token.split('.');
    let current: unknown = data;

    for (const pathToken of pathTokens) {
      if (typeof current !== 'object' || current === null || !(pathToken in (current as Record<string, unknown>))) {
        return '';
      }

      current = (current as Record<string, unknown>)[pathToken];
    }

    return current == null ? '' : String(current);
  });
};

const normalizeTask = (task: SchedulerTaskConfig): SchedulerTaskConfig => {
  return {
    ...task,
    api: {
      ...task.api,
      url: resolveEnvPlaceholders(task.api.url),
      headers: Object.entries(task.api.headers ?? {}).reduce<Record<string, string>>((acc, [key, value]) => {
        acc[key] = resolveEnvPlaceholders(value);
        return acc;
      }, {}),
    },
  };
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
};

export class SchedulerService {
  private readonly scheduledJobs = new Map<string, ScheduledTask>();

  private readonly loadedTasks = new Map<string, SchedulerTaskConfig>();

  private readonly executionRecords: TaskExecutionRecord[] = [];

  private started = false;

  loadTasksFromConfig(): SchedulerTaskConfig[] {
    try {
      const content = readFileSync(TASKS_CONFIG_PATH, 'utf-8');
      const raw = JSON.parse(content) as TasksFile;

      if (!raw.tasks || !Array.isArray(raw.tasks)) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Invalid tasks config format.');
      }

      return raw.tasks.map((task) => normalizeTask(task));
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(500, 'INTERNAL_ERROR', `Failed to load tasks config: ${getErrorMessage(error)}`);
    }
  }

  start(): void {
    if (this.started) {
      schedulerLogger.warn('scheduler service start requested while already running');
      return;
    }

    schedulerLogger.info('scheduler service starting', {
      configPath: TASKS_CONFIG_PATH,
      logFilePath: schedulerLogFilePath,
    });

    let tasks: SchedulerTaskConfig[];

    try {
      tasks = this.loadTasksFromConfig();
    } catch (error) {
      schedulerLogger.error('scheduler service failed to load task config', { configPath: TASKS_CONFIG_PATH }, error);
      throw error;
    }

    schedulerLogger.info('scheduler task configs loaded', { taskCount: tasks.length });

    tasks.forEach((task) => {
      if (!task.enabled) {
        schedulerLogger.info('scheduler task skipped because it is disabled', {
          taskId: task.id,
          taskName: task.name,
        });
        return;
      }

      if (!cron.validate(task.schedule)) {
        schedulerLogger.error('scheduler task skipped because cron expression is invalid', {
          taskId: task.id,
          taskName: task.name,
          schedule: task.schedule,
        });
        return;
      }

      if (task.targets.length === 0) {
        schedulerLogger.warn('scheduler task skipped because no targets are configured', {
          taskId: task.id,
          taskName: task.name,
        });
        return;
      }

      try {
        const job = cron.schedule(task.schedule, () => {
          void this.executeTask(task.id, { trigger: 'scheduled' }).catch(() => undefined);
        });

        this.loadedTasks.set(task.id, task);
        this.scheduledJobs.set(task.id, job);

        schedulerLogger.info('scheduler task registered', {
          taskId: task.id,
          taskName: task.name,
          schedule: task.schedule,
          targetCount: task.targets.length,
        });
      } catch (error) {
        schedulerLogger.error('scheduler task registration failed', {
          taskId: task.id,
          taskName: task.name,
          schedule: task.schedule,
        }, error);
      }
    });

    this.started = true;

    schedulerLogger.info('scheduler service started', { activeTaskCount: this.loadedTasks.size });
  }

  stop(): void {
    if (!this.started) {
      schedulerLogger.warn('scheduler service stop requested while not running');
      return;
    }

    schedulerLogger.info('scheduler service stopping', { activeTaskCount: this.scheduledJobs.size });

    this.scheduledJobs.forEach((job, taskId) => {
      job.stop();

      const task = this.loadedTasks.get(taskId);

      schedulerLogger.info('scheduler task stopped', {
        taskId,
        taskName: task?.name ?? taskId,
      });
    });

    this.scheduledJobs.clear();
    this.loadedTasks.clear();
    this.started = false;

    schedulerLogger.info('scheduler service stopped');
  }

  listTasks(): SchedulerTaskConfig[] {
    return Array.from(this.loadedTasks.values());
  }

  listExecutionRecords(): TaskExecutionRecord[] {
    return [...this.executionRecords];
  }

  async executeTask(taskId: string, options: ExecuteTaskOptions = {}): Promise<{ taskId: string; message: string }> {
    const triggeredBy = options.trigger ?? 'manual';
    const task = this.loadedTasks.get(taskId);

    if (!task) {
      schedulerLogger.error('task execution rejected because task is not loaded', { taskId, triggeredBy });
      throw new AppError(404, 'RESOURCE_NOT_FOUND', `Task not found: ${taskId}`);
    }

    const executionStartedAt = Date.now();
    const executedAt = new Date().toISOString();

    schedulerLogger.info('task execution started', {
      taskId,
      taskName: task.name,
      triggeredBy,
      targetCount: task.targets.length,
    });

    try {
      const messageText = await this.fetchAndRender(task);
      const message = { type: 'text' as const, text: messageText };

      if (task.targets.length === 1) {
        await lineService.pushMessage(task.targets[0], message);
      } else {
        await lineService.multicast(task.targets, message);
      }

      const durationMs = Date.now() - executionStartedAt;
      const successMessage = 'Task executed successfully.';

      this.recordExecution({
        taskId,
        taskName: task.name,
        status: 'success',
        triggeredBy,
        executedAt,
        durationMs,
        message: successMessage,
      });

      schedulerLogger.info('task execution succeeded', {
        taskId,
        taskName: task.name,
        triggeredBy,
        targetCount: task.targets.length,
        durationMs,
      });

      return { taskId, message: successMessage };
    } catch (error) {
      const durationMs = Date.now() - executionStartedAt;
      const failureMessage = getErrorMessage(error);

      this.recordExecution({
        taskId,
        taskName: task.name,
        status: 'failed',
        triggeredBy,
        executedAt,
        durationMs,
        message: failureMessage,
      });

      schedulerLogger.error('task execution failed', {
        taskId,
        taskName: task.name,
        triggeredBy,
        targetCount: task.targets.length,
        durationMs,
        errorMessage: failureMessage,
      }, error);

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(500, 'INTERNAL_ERROR', `Task execution failed: ${failureMessage}`);
    }
  }

  private async fetchAndRender(task: SchedulerTaskConfig): Promise<string> {
    const axiosConfig: AxiosRequestConfig = {
      url: task.api.url,
      method: task.api.method ?? 'GET',
      headers: task.api.headers,
      params: task.api.params,
      data: task.api.body,
      timeout: task.api.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };

    try {
      const response = await axios.request(axiosConfig);
      return renderTemplate(task.template, response.data);
    } catch (error) {
      const message = error instanceof AxiosError ? error.message : 'Unknown API error';
      throw new AppError(502, 'EXTERNAL_SERVICE_ERROR', `Task API request failed: ${message}`);
    }
  }

  private recordExecution(record: TaskExecutionRecord): void {
    this.executionRecords.unshift(record);
    if (this.executionRecords.length > MAX_RECORDS) {
      this.executionRecords.pop();
    }
  }
}

export const schedulerService = new SchedulerService();
