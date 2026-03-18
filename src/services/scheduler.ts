import cron, { type ScheduledTask } from 'node-cron';

import { createAppLogger } from '../utils/app-logger';
import { maskUserId } from '../utils/logger';
import type {
  AlarmFetchTask,
  TaskRepositoryChangeEvent,
} from './task-repository';

export interface SchedulerRefreshSnapshot {
  action: TaskRepositoryChangeEvent['action'];
  activeTaskCount: number;
  taskCount: number;
  taskId?: string;
  tasks: AlarmFetchTask[];
  updatedAt: string;
}

export interface SchedulerExecutionRecord {
  cron: string;
  durationMs: number;
  executedAt: string;
  message: string;
  ownerUserId: string;
  status: 'failed' | 'success';
  taskId: string;
  taskName: string;
  triggeredBy: 'cron';
}

const schedulerLogger = createAppLogger('scheduler');
const MAX_EXECUTION_RECORDS = 20;

const cloneTask = (task: AlarmFetchTask): AlarmFetchTask => {
  return { ...task };
};

const cloneExecutionRecord = (
  record: SchedulerExecutionRecord,
): SchedulerExecutionRecord => {
  return { ...record };
};

export class SchedulerService {
  private readonly jobsByTaskId = new Map<string, ScheduledTask>();

  private lastRefresh?: SchedulerRefreshSnapshot;

  private recentExecutions: SchedulerExecutionRecord[] = [];

  notifyTasksUpdated(
    event: TaskRepositoryChangeEvent,
  ): SchedulerRefreshSnapshot {
    this.reload(event.tasks);

    const snapshot: SchedulerRefreshSnapshot = {
      action: event.action,
      activeTaskCount: this.jobsByTaskId.size,
      taskCount: event.tasks.length,
      taskId: event.task?.id,
      tasks: event.tasks.map((task) => cloneTask(task)),
      updatedAt: new Date().toISOString(),
    };

    this.lastRefresh = snapshot;

    schedulerLogger.info('task collection refresh event received', {
      action: snapshot.action,
      activeTaskCount: snapshot.activeTaskCount,
      taskCount: snapshot.taskCount,
      taskId: snapshot.taskId,
    });

    return this.getLastRefresh() as SchedulerRefreshSnapshot;
  }

  getLastRefresh(): SchedulerRefreshSnapshot | undefined {
    if (!this.lastRefresh) {
      return undefined;
    }

    return {
      ...this.lastRefresh,
      tasks: this.lastRefresh.tasks.map((task) => cloneTask(task)),
    };
  }

  getRecentExecutions(): SchedulerExecutionRecord[] {
    return this.recentExecutions.map((record) => cloneExecutionRecord(record));
  }

  stop(): void {
    this.stopAllJobs();
  }

  private reload(tasks: AlarmFetchTask[]): void {
    this.stopAllJobs();

    tasks
      .filter((task) => task.enabled)
      .forEach((task) => {
        try {
          const scheduledTask = cron.schedule(
            task.cron,
            () => {
              void this.executeTask(task);
            },
            {
              scheduled: false,
            },
          );

          scheduledTask.start();
          this.jobsByTaskId.set(task.id, scheduledTask);

          schedulerLogger.info('alarm task scheduled', {
            cron: task.cron,
            taskId: task.id,
            taskName: task.name,
            userId: maskUserId(task.ownerUserId),
          });
        } catch (error) {
          schedulerLogger.warn('alarm task schedule registration failed', {
            cron: task.cron,
            reason: error instanceof Error ? error.message : 'Unknown error',
            taskId: task.id,
            userId: maskUserId(task.ownerUserId),
          });
        }
      });
  }

  private stopAllJobs(): void {
    this.jobsByTaskId.forEach((job, taskId) => {
      try {
        job.stop();
      } catch (error) {
        schedulerLogger.warn('scheduled job stop failed', {
          reason: error instanceof Error ? error.message : 'Unknown error',
          taskId,
        });
      }
    });

    this.jobsByTaskId.clear();
  }

  private async executeTask(task: AlarmFetchTask): Promise<void> {
    const startedAt = Date.now();

    schedulerLogger.info('alarm task execution started', {
      alertScope: task.alertScope,
      cron: task.cron,
      taskId: task.id,
      taskName: task.name,
      userId: maskUserId(task.ownerUserId),
    });

    try {
      const executionMessage = `已触发告警信息定时任务，范围=${task.alertScope}`;

      this.recordExecution({
        cron: task.cron,
        durationMs: Date.now() - startedAt,
        executedAt: new Date().toISOString(),
        message: executionMessage,
        ownerUserId: task.ownerUserId,
        status: 'success',
        taskId: task.id,
        taskName: task.name,
        triggeredBy: 'cron',
      });

      schedulerLogger.info('alarm task execution finished', {
        cron: task.cron,
        durationMs: Date.now() - startedAt,
        taskId: task.id,
        userId: maskUserId(task.ownerUserId),
      });
    } catch (error) {
      const executionMessage =
        error instanceof Error ? error.message : 'Unknown scheduler error.';

      this.recordExecution({
        cron: task.cron,
        durationMs: Date.now() - startedAt,
        executedAt: new Date().toISOString(),
        message: executionMessage,
        ownerUserId: task.ownerUserId,
        status: 'failed',
        taskId: task.id,
        taskName: task.name,
        triggeredBy: 'cron',
      });

      schedulerLogger.error(
        'alarm task execution failed',
        {
          cron: task.cron,
          taskId: task.id,
          userId: maskUserId(task.ownerUserId),
        },
        error,
      );
    }
  }

  private recordExecution(record: SchedulerExecutionRecord): void {
    this.recentExecutions = [
      cloneExecutionRecord(record),
      ...this.recentExecutions,
    ].slice(0, MAX_EXECUTION_RECORDS);
  }
}

export const schedulerService = new SchedulerService();
