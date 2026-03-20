import type { Message } from "@line/bot-sdk";
import cron, { type ScheduledTask } from "node-cron";

import {
  AlarmAgentClientError,
  type AlarmListAlarmsParams,
} from "../clients/alarm-agent-client";
import {
  normalizeListAlarmsResponse,
  type ListAlarmsSuccess,
} from "../tools/alarm-tools";
import { createAppLogger } from "../utils/app-logger";
import { getLocalIsoString } from "../utils/date";
import { maskUserId } from "../utils/logger";
import type {
  AlarmFetchTask,
  TaskRepositoryChangeEvent,
} from "./task-repository";
import { buildTextMessage } from "./line";

const DEFAULT_ALARM_LIST_PAGE = 1;
const DEFAULT_ALARM_LIST_PAGE_SIZE = 20;
const DEFAULT_ALARM_LIST_STATUS = "";
const CURRENT_ALARMS_SCOPE_LABEL = "Current Alarms";
const CURRENT_UNTREATED_ALARMS_SCOPE_LABEL = "Current Untreated Alarms";
const UNTREATED_ALARM_STATUS = "Untreated";
const MAX_EXECUTION_RECORDS = 20;
const schedulerLogger = createAppLogger("scheduler");

/**
 * Snapshot of a task collection refresh.
 */
export interface SchedulerRefreshSnapshot {
  /** The task collection event that triggered the refresh. */
  action: TaskRepositoryChangeEvent["action"];
  /** The number of cron jobs currently registered. */
  activeTaskCount: number;
  /** The number of tasks observed in the latest refresh. */
  taskCount: number;
  /** The task identifier associated with the event, when available. */
  taskId?: string;
  /** The refreshed task list. */
  tasks: AlarmFetchTask[];
  /** The timestamp when the refresh snapshot was captured. */
  updatedAt: string;
}

/**
 * Record of a single scheduled execution.
 */
export interface SchedulerExecutionRecord {
  /** The cron expression attached to the task. */
  cron: string;
  /** The time spent executing the task in milliseconds. */
  durationMs: number;
  /** The local timestamp when execution finished. */
  executedAt: string;
  /** The pushed or fallback message for this run. */
  message: string;
  /** The owner of the task. */
  ownerUserId: string;
  /** The execution result. */
  status: "failed" | "success";
  /** The task identifier. */
  taskId: string;
  /** The task display name. */
  taskName: string;
  /** The trigger source. */
  triggeredBy: "cron";
}

/**
 * Minimal alarm client surface required by the scheduler.
 */
export interface SchedulerAlarmClient {
  listAlarms(params: AlarmListAlarmsParams): Promise<unknown>;
}

/**
 * Minimal LINE push surface required by the scheduler.
 */
export interface SchedulerLineService {
  pushMessage(to: string, messages: Message | Message[]): Promise<void>;
}

/**
 * Runtime dependencies injected into the scheduler.
 */
export interface SchedulerServiceDeps {
  /** Direct alarm client used to fetch the current list. */
  alarmClient?: SchedulerAlarmClient;
  /** LINE collaborator used to push the rendered summary. */
  lineService?: SchedulerLineService;
}

const cloneTask = (task: AlarmFetchTask): AlarmFetchTask => {
  return { ...task };
};

const cloneExecutionRecord = (
  record: SchedulerExecutionRecord,
): SchedulerExecutionRecord => {
  return { ...record };
};

const describeAlertScope = (alertScope: string): string => {
  const normalizedAlertScope = alertScope.trim();

  if (
    normalizedAlertScope.toLowerCase() ===
    CURRENT_UNTREATED_ALARMS_SCOPE_LABEL.toLowerCase()
  ) {
    return "当前未处理告警";
  }

  if (
    normalizedAlertScope.toLowerCase() === CURRENT_ALARMS_SCOPE_LABEL.toLowerCase()
  ) {
    return "当前告警";
  }

  if (
    normalizedAlertScope === "当前未处理告警" ||
    normalizedAlertScope === "未处理告警" ||
    normalizedAlertScope === "未处理"
  ) {
    return "当前未处理告警";
  }

  if (
    normalizedAlertScope === "当前告警" ||
    normalizedAlertScope === "当前告警信息" ||
    normalizedAlertScope === "告警信息" ||
    normalizedAlertScope === "全部告警" ||
    normalizedAlertScope === "所有告警"
  ) {
    return "当前告警";
  }

  return normalizedAlertScope || "告警";
};

const resolveAlarmListStatus = (alertScope: string): string => {
  const normalizedAlertScope = alertScope.trim().toLowerCase();

  if (
    normalizedAlertScope ===
      CURRENT_UNTREATED_ALARMS_SCOPE_LABEL.toLowerCase() ||
    normalizedAlertScope === "untreated" ||
    normalizedAlertScope === "当前未处理告警" ||
    normalizedAlertScope === "未处理告警" ||
    normalizedAlertScope === "未处理"
  ) {
    return UNTREATED_ALARM_STATUS;
  }

  return DEFAULT_ALARM_LIST_STATUS;
};

const buildAlarmListRequest = (
  task: AlarmFetchTask,
): AlarmListAlarmsParams => {
  return {
    status: resolveAlarmListStatus(task.alertScope),
    page: DEFAULT_ALARM_LIST_PAGE,
    page_size: DEFAULT_ALARM_LIST_PAGE_SIZE,
  };
};

const buildScheduledAlarmPushMessage = (
  task: AlarmFetchTask,
  result: ListAlarmsSuccess,
): string => {
  const summaryHeader = [
    `已完成告警定时任务：${task.name}`,
    `查询范围：${describeAlertScope(task.alertScope)}`,
    `本次查询：共 ${result.total} 条，返回 ${result.alarms.length} 条`,
  ];

  const footer =
    result.alarms.length > 0
      ? ["如需继续分析，请回复“查看告警信息”后选择告警编号。"]
      : [];

  return [...summaryHeader, result.alarm_summary_markdown, ...footer].join(
    "\n\n",
  );
};

const buildFallbackExecutionMessage = (
  task: AlarmFetchTask,
  reason: string,
): string => {
  return `已触发告警信息定时任务，范围=${describeAlertScope(task.alertScope)}（${reason}）`;
};

const isAlarmClientNotConfigured = (error: unknown): boolean => {
  return error instanceof AlarmAgentClientError && error.type === "NOT_CONFIGURED";
};

/**
 * Register, execute, and record alarm fetch cron jobs.
 */
export class SchedulerService {
  private readonly jobsByTaskId = new Map<string, ScheduledTask>();

  private lastRefresh?: SchedulerRefreshSnapshot;

  private recentExecutions: SchedulerExecutionRecord[] = [];

  private alarmClient?: SchedulerAlarmClient;

  private lineService?: SchedulerLineService;

  /**
   * Inject runtime dependencies for direct alarm fetching and LINE push.
   */
  setDeps(deps: SchedulerServiceDeps): void {
    this.alarmClient = deps.alarmClient;
    this.lineService = deps.lineService;
  }

  /**
   * Refresh the cron registry from the latest task snapshot.
   */
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
      updatedAt: getLocalIsoString(),
    };

    this.lastRefresh = snapshot;

    schedulerLogger.info("task collection refresh event received", {
      action: snapshot.action,
      activeTaskCount: snapshot.activeTaskCount,
      taskCount: snapshot.taskCount,
      taskId: snapshot.taskId,
    });

    return this.getLastRefresh() ?? snapshot;
  }

  /**
   * Return the latest refresh snapshot, if any.
   */
  getLastRefresh(): SchedulerRefreshSnapshot | undefined {
    if (!this.lastRefresh) {
      return undefined;
    }

    return {
      ...this.lastRefresh,
      tasks: this.lastRefresh.tasks.map((task) => cloneTask(task)),
    };
  }

  /**
   * Return recent execution records in descending order.
   */
  getRecentExecutions(): SchedulerExecutionRecord[] {
    return this.recentExecutions.map((record) => cloneExecutionRecord(record));
  }

  /**
   * Stop every scheduled cron job.
   */
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
              timezone: process.env.TZ || "Asia/Shanghai",
            },
          );

          scheduledTask.start();
          this.jobsByTaskId.set(task.id, scheduledTask);

          schedulerLogger.info("alarm task scheduled", {
            cron: task.cron,
            taskId: task.id,
            taskName: task.name,
            userId: maskUserId(task.ownerUserId),
          });
        } catch (error) {
          schedulerLogger.warn("alarm task schedule registration failed", {
            cron: task.cron,
            reason: error instanceof Error ? error.message : "Unknown error",
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
        schedulerLogger.warn("scheduled job stop failed", {
          reason: error instanceof Error ? error.message : "Unknown error",
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

    schedulerLogger.info("alarm task execution started", logContext);

    try {
      const pushMessage = await this.fetchAndPush(task);

      this.recordExecution({
        cron: task.cron,
        durationMs: Date.now() - startedAt,
        executedAt: getLocalIsoString(),
        message: pushMessage,
        ownerUserId: task.ownerUserId,
        status: "success",
        taskId: task.id,
        taskName: task.name,
        triggeredBy: "cron",
      });

      schedulerLogger.info("alarm task execution finished", {
        ...logContext,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const executionMessage =
        error instanceof Error ? error.message : "Unknown scheduler error.";

      this.recordExecution({
        cron: task.cron,
        durationMs: Date.now() - startedAt,
        executedAt: getLocalIsoString(),
        message: executionMessage,
        ownerUserId: task.ownerUserId,
        status: "failed",
        taskId: task.id,
        taskName: task.name,
        triggeredBy: "cron",
      });

      schedulerLogger.error(
        "alarm task execution failed",
        { ...logContext, durationMs: Date.now() - startedAt },
        error,
      );
    }
  }

  /**
   * Fetch alarms directly from the alarm service, render a deterministic
   * summary, and push it to LINE.
   */
  private async fetchAndPush(task: AlarmFetchTask): Promise<string> {
    if (!this.alarmClient || !this.lineService) {
      const fallback = buildFallbackExecutionMessage(
        task,
        "告警服务或 LINE 服务未注入，跳过推送",
      );

      schedulerLogger.warn("scheduler deps not set, skipping direct fetch", {
        taskId: task.id,
        userId: maskUserId(task.ownerUserId),
      });

      return fallback;
    }

    const request = buildAlarmListRequest(task);
    const requestContext = {
      page: request.page ?? DEFAULT_ALARM_LIST_PAGE,
      page_size: request.page_size ?? DEFAULT_ALARM_LIST_PAGE_SIZE,
      status: request.status ?? DEFAULT_ALARM_LIST_STATUS,
    };

    let listResult: ListAlarmsSuccess;

    try {
      const payload = await this.alarmClient.listAlarms(request);
      listResult = normalizeListAlarmsResponse(payload, requestContext);
    } catch (error) {
      if (isAlarmClientNotConfigured(error)) {
        const fallback = buildFallbackExecutionMessage(
          task,
          "告警服务未配置，跳过推送",
        );

        schedulerLogger.warn("alarm client not configured, skipping fetch", {
          taskId: task.id,
          userId: maskUserId(task.ownerUserId),
        });

        return fallback;
      }

      throw new Error(
        `Alarm list request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }

    schedulerLogger.info("alarm task list fetched", {
      taskId: task.id,
      taskName: task.name,
      userId: maskUserId(task.ownerUserId),
      status: requestContext.status || "all",
      total: listResult.total,
      returnedCount: listResult.alarms.length,
    });

    const reply = buildScheduledAlarmPushMessage(task, listResult);

    try {
      await this.lineService.pushMessage(
        task.ownerUserId,
        buildTextMessage(reply),
      );
    } catch (pushError) {
      schedulerLogger.warn("alarm task LINE push failed", {
        taskId: task.id,
        userId: maskUserId(task.ownerUserId),
        reason: pushError instanceof Error ? pushError.message : "Unknown error",
      });
    }

    return reply;
  }

  private recordExecution(record: SchedulerExecutionRecord): void {
    this.recentExecutions = [
      cloneExecutionRecord(record),
      ...this.recentExecutions,
    ].slice(0, MAX_EXECUTION_RECORDS);
  }
}

export const schedulerService = new SchedulerService();
