process.env.LINE_CHANNEL_SECRET ??= 'verify-line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'verify-line-token';

import assert from 'node:assert/strict';

import type { AlarmFetchTask, TaskRepositoryChangeEvent } from '../services/task-repository';
import {
  SchedulerService,
  type SchedulerAlarmClient,
  type SchedulerLineService,
  type SchedulerRefreshSnapshot,
} from '../services/scheduler';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const buildTask = (overrides: Partial<AlarmFetchTask> = {}): AlarmFetchTask => ({
  id: 'task-001',
  type: 'alarm_info_fetch',
  name: '当前未处理告警定时获取',
  ownerUserId: 'U-scheduler-test',
  alertScope: '当前未处理告警',
  cron: '0 0 8 * * *',
  enabled: true,
  source: 'api',
  createdAt: '2026-03-18T00:00:00.000Z',
  updatedAt: '2026-03-18T00:00:00.000Z',
  ...overrides,
});

const buildEvent = (
  action: TaskRepositoryChangeEvent['action'],
  tasks: AlarmFetchTask[],
  task?: AlarmFetchTask,
): TaskRepositoryChangeEvent => ({ action, tasks, task });

const sleep = (durationMs: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
};

const extractMessageText = (messages: unknown): string => {
  const messageList = Array.isArray(messages) ? messages : [messages];

  return messageList
    .map((message) => {
      if (!message || typeof message !== 'object') {
        return '';
      }

      const record = message as Record<string, unknown>;

      return typeof record.text === 'string' ? record.text : '';
    })
    .join('\n');
};

/* ------------------------------------------------------------------ */
/* SCH-001  调度器加载与刷新生命周期                                     */
/* ------------------------------------------------------------------ */

const verifySCH001 = (): void => {
  console.info('\n-- SCH-001: Scheduler load and refresh lifecycle --');

  // 1. Reload registers enabled tasks
  const scheduler = new SchedulerService();
  const enabledTask = buildTask();
  const disabledTask = buildTask({ id: 'task-002', enabled: false });

  const snap1 = scheduler.notifyTasksUpdated(
    buildEvent('reload', [enabledTask, disabledTask]),
  );

  assert.equal(snap1.action, 'reload');
  assert.equal(snap1.taskCount, 2);
  assert.equal(snap1.activeTaskCount, 1);
  assert.ok(snap1.updatedAt);
  assert.equal(snap1.tasks.length, 2);

  // 2. Refresh after create
  const newTask = buildTask({ id: 'task-003', cron: '0 30 9 * * *' });
  const snap2 = scheduler.notifyTasksUpdated(
    buildEvent('create', [enabledTask, disabledTask, newTask], newTask),
  );

  assert.equal(snap2.action, 'create');
  assert.equal(snap2.taskCount, 3);
  assert.equal(snap2.activeTaskCount, 2);
  assert.equal(snap2.taskId, 'task-003');

  // 3. Refresh after delete
  const snap3 = scheduler.notifyTasksUpdated(
    buildEvent('delete', [disabledTask, newTask], enabledTask),
  );

  assert.equal(snap3.action, 'delete');
  assert.equal(snap3.taskCount, 2);
  assert.equal(snap3.activeTaskCount, 1);

  // 4. Idempotent stop
  scheduler.stop();
  scheduler.stop(); // double stop should not throw

  // 5. Reload after stop re-registers
  const snap4 = scheduler.notifyTasksUpdated(
    buildEvent('reload', [enabledTask]),
  );
  assert.equal(snap4.activeTaskCount, 1);
  scheduler.stop();

  // 6. Invalid cron does not throw, just skips
  const badCronTask = buildTask({ id: 'task-bad', cron: 'not-a-cron' });
  const snap5 = scheduler.notifyTasksUpdated(
    buildEvent('reload', [badCronTask]),
  );
  assert.equal(snap5.activeTaskCount, 0);
  assert.equal(snap5.taskCount, 1);
  scheduler.stop();

  console.info('  SCH-001 passed.');
};

/* ------------------------------------------------------------------ */
/* SCH-002  执行记录                                                   */
/* ------------------------------------------------------------------ */

const verifySCH002 = (): void => {
  console.info('\n-- SCH-002: Execution record tracking --');

  // Without deps set, executeTask records success with a fallback message.
  // We use a per-second cron to trigger quickly but we won't wait.
  // Instead test the recordExecution path via notifyTasksUpdated + manual assertions on getRecentExecutions.

  const scheduler = new SchedulerService();

  // No deps set — verify getRecentExecutions is initially empty
  assert.deepEqual(scheduler.getRecentExecutions(), []);

  // Trigger multiple reloads to verify record truncation — manually test via the public API.
  // notifyTasksUpdated itself doesn't add execution records; records appear only when cron fires.
  // For unit verification, we test the snapshot + empty records contract only.

  const task = buildTask();
  scheduler.notifyTasksUpdated(buildEvent('reload', [task]));

  // Immediately after reload, no executions have occurred
  assert.deepEqual(scheduler.getRecentExecutions(), []);
  scheduler.stop();

  console.info('  SCH-002 passed.');
};

/* ------------------------------------------------------------------ */
/* SCH-003  调度状态与健康摘要                                          */
/* ------------------------------------------------------------------ */

const verifySCH003 = (): void => {
  console.info('\n-- SCH-003: Scheduler status and health summary --');

  const scheduler = new SchedulerService();

  // 1. No refresh yet
  assert.equal(scheduler.getLastRefresh(), undefined);

  // 2. After first refresh
  const task = buildTask();
  scheduler.notifyTasksUpdated(buildEvent('reload', [task]));

  const snapshot = scheduler.getLastRefresh() as SchedulerRefreshSnapshot;
  assert.ok(snapshot);
  assert.equal(snapshot.activeTaskCount, 1);
  assert.equal(snapshot.taskCount, 1);
  assert.ok(snapshot.updatedAt);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0]?.id, 'task-001');

  // 3. Snapshot updates on next refresh
  const task2 = buildTask({ id: 'task-002', cron: '0 0 9 * * *' });
  scheduler.notifyTasksUpdated(buildEvent('create', [task, task2], task2));

  const snapshot2 = scheduler.getLastRefresh() as SchedulerRefreshSnapshot;
  assert.equal(snapshot2.activeTaskCount, 2);
  assert.equal(snapshot2.taskCount, 2);
  assert.equal(snapshot2.taskId, 'task-002');

  // 4. Snapshot is a deep copy — mutating it does not affect scheduler
  snapshot2.tasks.length = 0;
  const snapshot3 = scheduler.getLastRefresh() as SchedulerRefreshSnapshot;
  assert.equal(snapshot3.tasks.length, 2);

  scheduler.stop();

  console.info('  SCH-003 passed.');
};

/* ------------------------------------------------------------------ */
/* SCH-004  直连告警拉取与推送                                            */
/* ------------------------------------------------------------------ */

const verifySCH004 = async (): Promise<void> => {
  console.info('\n-- SCH-004: Direct alarm fetch and push --');

  let lastListRequest:
    | {
        page?: number;
        page_size?: number;
        status?: string;
      }
    | undefined;
  const pushedMessages: Array<{ text: string; to: string }> = [];

  const alarmClient: SchedulerAlarmClient = {
    async listAlarms(request) {
      lastListRequest = request;

      return {
        total: 2,
        page: 1,
        page_size: 20,
        data: [
          {
            id: 101,
            deviceSn: 'INV-0001',
            siteName: 'Bangkok PV Site',
            alarm_code: '130',
            processingStatus: 'Untreated',
            createdAt: '2026-03-16 09:20:00',
          },
          {
            id: 102,
            deviceSn: 'INV-0002',
            siteName: 'Bangkok PV Site',
            alarm_code: '131',
            processingStatus: 'Untreated',
            createdAt: '2026-03-16 09:25:00',
          },
        ],
      };
    },
  };

  const lineService: SchedulerLineService = {
    async pushMessage(to, messages) {
      pushedMessages.push({
        text: extractMessageText(messages),
        to,
      });
    },
  };

  const scheduler = new SchedulerService();
  scheduler.setDeps({ alarmClient, lineService });

  const task = buildTask({
    alertScope: 'Current Untreated Alarms',
    cron: '*/1 * * * * *',
    id: 'task-direct-fetch',
    name: '当前未处理告警定时获取',
  });

  scheduler.notifyTasksUpdated(buildEvent('reload', [task]));
  await sleep(1700);
  scheduler.stop();

  assert.deepEqual(lastListRequest, {
    status: 'Untreated',
    page: 1,
    page_size: 20,
  });

  assert.ok(pushedMessages.length > 0);

  const firstPush = pushedMessages[0]?.text ?? '';
  assert.match(firstPush, /已完成告警定时任务/u);
  assert.match(firstPush, /当前未处理告警/u);
  assert.match(firstPush, /INV-0001/u);
  assert.match(firstPush, /Bangkok PV Site/u);
  assert.doesNotMatch(firstPush, /状态机接管/u);
  assert.doesNotMatch(firstPush, /Current Alarms/u);

  const executions = scheduler.getRecentExecutions();
  assert.ok(executions.length > 0);
  assert.equal(executions[0]?.status, 'success');
  assert.match(executions[0]?.message ?? '', /INV-0001/u);

  console.info('  SCH-004 passed.');
};

/* ------------------------------------------------------------------ */
/* Run all                                                            */
/* ------------------------------------------------------------------ */

const verify = async (): Promise<void> => {
  verifySCH001();
  verifySCH002();
  verifySCH003();
  await verifySCH004();

  console.info('\nScheduler lifecycle verification passed.\n');
};

void verify().catch((error: unknown) => {
  console.error('Scheduler lifecycle verification failed.', error);
  process.exitCode = 1;
});
