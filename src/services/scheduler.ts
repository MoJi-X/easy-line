import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import cron, { type ScheduledTask } from 'node-cron';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { lineService } from './line';
import { AppError } from '../errors/app-error';

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

interface TaskExecutionRecord {
  taskId: string;
  status: 'success' | 'failed';
  executedAt: string;
  message: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RECORDS = 20;

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

export class SchedulerService {
  private readonly scheduledJobs = new Map<string, ScheduledTask>();

  private readonly loadedTasks = new Map<string, SchedulerTaskConfig>();

  private readonly executionRecords: TaskExecutionRecord[] = [];

  loadTasksFromConfig(): SchedulerTaskConfig[] {
    const configPath = path.resolve(process.cwd(), 'src/config/tasks.json');
    const content = readFileSync(configPath, 'utf-8');
    const raw = JSON.parse(content) as TasksFile;

    if (!raw.tasks || !Array.isArray(raw.tasks)) {
      throw new AppError(500, 'INTERNAL_ERROR', 'Invalid tasks config format.');
    }

    return raw.tasks.map((task) => normalizeTask(task));
  }

  start(): void {
    const tasks = this.loadTasksFromConfig();

    tasks
      .filter((task) => task.enabled)
      .forEach((task) => {
        if (!cron.validate(task.schedule)) {
          console.error(`[scheduler] invalid cron for task=${task.id}, schedule=${task.schedule}`);
          return;
        }

        this.loadedTasks.set(task.id, task);

        const job = cron.schedule(task.schedule, async () => {
          try {
            await this.executeTask(task.id);
          } catch (error) {
            console.error(`[scheduler] task execution failed, task=${task.id}`, error);
          }
        });

        this.scheduledJobs.set(task.id, job);
      });

    console.info(`[scheduler] loaded enabled tasks count=${this.loadedTasks.size}`);
  }

  listTasks(): SchedulerTaskConfig[] {
    return Array.from(this.loadedTasks.values());
  }

  listExecutionRecords(): TaskExecutionRecord[] {
    return [...this.executionRecords];
  }

  async executeTask(taskId: string): Promise<{ taskId: string; message: string }> {
    const task = this.loadedTasks.get(taskId);

    if (!task) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', `Task not found: ${taskId}`);
    }

    const messageText = await this.fetchAndRender(task);
    const message = { type: 'text' as const, text: messageText };

    if (task.targets.length === 1) {
      await lineService.pushMessage(task.targets[0], message);
    } else {
      await lineService.multicast(task.targets, message);
    }

    this.recordExecution({
      taskId,
      status: 'success',
      executedAt: new Date().toISOString(),
      message: 'Task executed successfully.',
    });

    return { taskId, message: 'Task executed successfully.' };
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

      this.recordExecution({
        taskId: task.id,
        status: 'failed',
        executedAt: new Date().toISOString(),
        message: `External API request failed: ${message}`,
      });

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
