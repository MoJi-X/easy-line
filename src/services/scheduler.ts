import cron, { type ScheduledTask } from 'node-cron';

import { createAppLogger } from '../utils/app-logger';
import { maskUserId } from '../utils/logger';
import type {
  AlarmFetchTask,
  TaskRepositoryChangeEvent,
} from './task-repository';
import type { AgentService, ProcessUserMessageResult } from './agent';
import { buildTextMessage, type LineService } from './line';

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

export interface SchedulerServiceDeps {
  agentService?: AgentService;
  lineService?: LineService;
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

const buildScheduledAlarmMessage = (alertScope: string): string => {
  return `查看${alertScope || '告警'}`;
};

export class SchedulerService {
  private readonly jobsByTaskId = new Map<string, ScheduledTask>();

  private lastRefresh?: SchedulerRefreshSnapshot;

  private recentExecutions: SchedulerExecutionRecord[] = [];

  private agentService?: AgentService;

  private lineService?: LineService;

  setDeps(deps: SchedulerServiceDeps): void {
    this.agentService = deps.agentService;
    this.lineService = deps.lineService;
  }

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
    const logContext = {
      alertScope: task.alertScope,
      cron: task.cron,
      taskId: task.id,
      taskName: task.name,
      userId: maskUserId(task.ownerUserId),
    };

    schedulerLogger.info('alarm task execution started', logContext);

    try {
      const agentReply = await this.fetchAndPush(task);

      this.recordExecution({
        cron: task.cron,
        durationMs: Date.now() - startedAt,
        executedAt: new Date().toISOString(),
        message: agentReply,
        ownerUserId: task.ownerUserId,
        status: 'success',
        taskId: task.id,
        taskName: task.name,
        triggeredBy: 'cron',
      });

      schedulerLogger.info('alarm task execution finished', {
        ...logContext,
        durationMs: Date.now() - startedAt,
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
        { ...logContext, durationMs: Date.now() - startedAt },
        error,
      );
    }
  }

  /**
   * Route the alarm fetch through the agent service so that the alarm list
   * is stored in the user's session context, allowing subsequent interactions
   * (e.g. "分析第 1 条告警") to work seamlessly.
   */
  private async fetchAndPush(task: AlarmFetchTask): Promise<string> {
    if (!this.agentService || !this.lineService) {
      const fallback = `已触发告警信息定时任务，范围=${task.alertScope}（agent/line 服务未注入，跳过推送）`;
      schedulerLogger.warn('scheduler deps not set, skipping fetch and push', {
        taskId: task.id,
      });
      return fallback;
    }

    const syntheticMessage = buildScheduledAlarmMessage(task.alertScope);

    let agentResult: ProcessUserMessageResult;
    try {
      agentResult = await this.agentService.processUserMessage({
        channel: 'chat_api',
        userId: task.ownerUserId,
        message: syntheticMessage,
      });
    } catch (agentError) {
      throw new Error(
        `Agent processing failed: ${agentError instanceof Error ? agentError.message : 'Unknown error'}`,
      );
    }

    try {
      await this.lineService.pushMessage(
        task.ownerUserId,
        buildTextMessage(agentResult.reply),
      );
    } catch (pushError) {
      schedulerLogger.warn(
        'alarm task LINE push failed, alarm context still saved in session',
        {
          taskId: task.id,
          userId: maskUserId(task.ownerUserId),
          reason: pushError instanceof Error ? pushError.message : 'Unknown error',
        },
      );
    }

    return agentResult.reply;
  }

  private recordExecution(record: SchedulerExecutionRecord): void {
    this.recentExecutions = [
      cloneExecutionRecord(record),
      ...this.recentExecutions,
    ].slice(0, MAX_EXECUTION_RECORDS);
  }
}

export const schedulerService = new SchedulerService();
