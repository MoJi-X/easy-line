process.env.LINE_CHANNEL_SECRET ??= 'verify-line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'verify-line-token';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';

import { errorHandler, notFoundHandler } from '../errors/error-handler';
import { createTasksRouter } from '../routes/tasks';
import { AgentService } from '../services/agent';
import { TaskRepository, type AlarmFetchTask } from '../services/task-repository';
import { createToolRegistry } from '../tools';
import { tryHandleTaskCommand } from '../tools/task-tools';

const createSeedTask = (): AlarmFetchTask => {
  return {
    id: 'alarm-task-seed-001',
    type: 'alarm_info_fetch',
    name: '当前未处理告警定时获取',
    ownerUserId: 'U-seed-user',
    alertScope: '当前未处理告警',
    cron: '0 0 8 * * *',
    enabled: false,
    source: 'api_seed',
    createdAt: '2026-03-16T08:00:00.000Z',
    updatedAt: '2026-03-16T08:00:00.000Z',
  };
};

const createRepository = (filePath: string): TaskRepository => {
  let idCounter = 0;
  let minuteOffset = 0;

  return new TaskRepository({
    filePath,
    generateId: () => {
      idCounter += 1;
      return `alarm-task-test-${String(idCounter).padStart(3, '0')}`;
    },
    now: () => {
      const now = new Date(Date.UTC(2026, 2, 16, 8, minuteOffset, 0, 0));
      minuteOffset += 1;
      return now;
    },
  });
};

const createTasksFile = (filePath: string): void => {
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        tasks: [
          createSeedTask(),
          {
            id: 'invalid-task',
            type: 'alarm_info_fetch',
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );
};

const readTasksFromFile = (filePath: string): AlarmFetchTask[] => {
  const payload = JSON.parse(readFileSync(filePath, 'utf-8')) as {
    tasks: AlarmFetchTask[];
  };

  return payload.tasks;
};

const verifyTaskApi = async (taskRepository: TaskRepository): Promise<void> => {
  const app = express();

  app.use(express.json());
  app.use('/api', createTasksRouter({ taskRepository }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const listeningServer = app.listen(0, () => {
      resolve(listeningServer);
    });
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve verification server address.');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: 'U-api-user',
        alertScope: '当前未处理告警',
        cron: '0 30 8 * * *',
        enabled: true,
        source: 'api',
      }),
    });

    assert.equal(createResponse.status, 201);

    const createdPayload = (await createResponse.json()) as {
      data: { task: AlarmFetchTask };
    };
    const createdTaskId = createdPayload.data.task.id;

    assert.equal(createdPayload.data.task.ownerUserId, 'U-api-user');
    assert.equal(createdPayload.data.task.type, 'alarm_info_fetch');
    assert.equal(createdPayload.data.task.source, 'api');
    assert.equal(createdPayload.data.task.alertScope, '当前未处理告警');
    assert.equal(createdPayload.data.task.cron, '0 30 8 * * *');

    const listResponse = await fetch(
      `${baseUrl}/api/tasks?userId=U-api-user`,
    );
    const listPayload = (await listResponse.json()) as {
      data: { recentExecutions: unknown[]; tasks: AlarmFetchTask[] };
    };

    assert.equal(listResponse.status, 200);
    assert.equal(listPayload.data.tasks.length, 1);
    assert.equal(listPayload.data.tasks[0]?.id, createdTaskId);
    assert.deepEqual(listPayload.data.recentExecutions, []);

    const isolatedListResponse = await fetch(
      `${baseUrl}/api/tasks?userId=U-other-user`,
    );
    const isolatedListPayload = (await isolatedListResponse.json()) as {
      data: { tasks: AlarmFetchTask[] };
    };

    assert.equal(isolatedListResponse.status, 200);
    assert.equal(isolatedListPayload.data.tasks.length, 0);

    const updateResponse = await fetch(`${baseUrl}/api/tasks/${createdTaskId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: 'U-api-user',
        alertScope: '当前告警信息',
        cron: '0 0 9 * * *',
        enabled: false,
      }),
    });
    const updatePayload = (await updateResponse.json()) as {
      data: { task: AlarmFetchTask };
    };

    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.task.alertScope, '当前告警信息');
    assert.equal(updatePayload.data.task.cron, '0 0 9 * * *');
    assert.equal(updatePayload.data.task.enabled, false);

    const forbiddenResponse = await fetch(
      `${baseUrl}/api/tasks/${createdTaskId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'U-other-user',
          cron: '0 0 10 * * *',
        }),
      },
    );
    const forbiddenPayload = (await forbiddenResponse.json()) as {
      code: string;
    };

    assert.equal(forbiddenResponse.status, 403);
    assert.equal(forbiddenPayload.code, 'FORBIDDEN_TASK_ACCESS');

    const invalidCronResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: 'U-api-user',
        alertScope: '当前未处理告警',
        cron: '0 8 * * *',
        enabled: true,
        source: 'api',
      }),
    });
    const invalidCronPayload = (await invalidCronResponse.json()) as {
      code: string;
      message: string;
    };

    assert.equal(invalidCronResponse.status, 400);
    assert.equal(invalidCronPayload.code, 'INVALID_ARGUMENT');
    assert.match(invalidCronPayload.message, /6-field cron/u);

    const deleteResponse = await fetch(
      `${baseUrl}/api/tasks/${createdTaskId}?userId=U-api-user`,
      {
        method: 'DELETE',
      },
    );
    const deletePayload = (await deleteResponse.json()) as {
      data: { deleted: boolean; taskId: string };
    };

    assert.equal(deleteResponse.status, 200);
    assert.equal(deletePayload.data.deleted, true);
    assert.equal(deletePayload.data.taskId, createdTaskId);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
};

const verifyTaskCommands = (
  taskRepository: TaskRepository,
  filePath: string,
): void => {
  const createResult = tryHandleTaskCommand(
    {
      userId: 'U-command-user',
      message: '/task create alertScope=当前未处理告警 cron="0 15 7 * * *" enabled=false',
    },
    { taskRepository },
  );

  assert.ok(createResult);
  assert.deepEqual(createResult.usedTools, ['task.create']);
  assert.match(createResult.reply, /alarm-task-test-001/u);
  assert.match(createResult.reply, /当前未处理告警/u);
  assert.match(createResult.reply, /0 15 7 \* \* \*/u);

  const listResult = tryHandleTaskCommand(
    {
      userId: 'U-command-user',
      message: '/task list',
    },
    { taskRepository },
  );

  assert.ok(listResult);
  assert.deepEqual(listResult.usedTools, ['task.list']);
  assert.match(listResult.reply, /当前未处理告警定时获取/u);

  const updateResult = tryHandleTaskCommand(
    {
      userId: 'U-command-user',
      message: '/task update taskId=alarm-task-test-001 cron="0 45 7 * * *" enabled=true',
    },
    { taskRepository },
  );

  assert.ok(updateResult);
  assert.deepEqual(updateResult.usedTools, ['task.update']);
  assert.match(updateResult.reply, /0 45 7 \* \* \*/u);

  const invalidUsageResult = tryHandleTaskCommand(
    {
      userId: 'U-command-user',
      message: '/task create alertScope=当前未处理告警',
    },
    { taskRepository },
  );

  assert.ok(invalidUsageResult);
  assert.deepEqual(invalidUsageResult.usedTools, []);
  assert.match(invalidUsageResult.reply, /需要 alertScope 和 cron 参数/u);

  const invalidQuoteResult = tryHandleTaskCommand(
    {
      userId: 'U-command-user',
      message: '/task create alertScope=当前未处理告警 cron="0 0 8 * * *',
    },
    { taskRepository },
  );

  assert.ok(invalidQuoteResult);
  assert.deepEqual(invalidQuoteResult.usedTools, []);
  assert.match(invalidQuoteResult.reply, /命令格式无效/u);

  const deleteResult = tryHandleTaskCommand(
    {
      userId: 'U-command-user',
      message: '/task delete taskId=alarm-task-test-001',
    },
    { taskRepository },
  );

  assert.ok(deleteResult);
  assert.deepEqual(deleteResult.usedTools, ['task.delete']);
  assert.match(deleteResult.reply, /已删除任务/u);

  const persistedTasks = readTasksFromFile(filePath);

  assert.equal(persistedTasks.length, 1);
  assert.equal(persistedTasks[0]?.id, 'alarm-task-seed-001');
};

const verifyNaturalLanguage = async (taskRepository: TaskRepository): Promise<void> => {
  const service = new AgentService({
    taskRepository,
    toolRegistry: createToolRegistry({
      taskTools: {
        taskRepository,
      },
      tavilySearch: {
        apiWrapper: {
          rawResults: async () => {
            return {
              query: '',
              answer: '',
              results: [],
              response_time: 0.01,
            };
          },
        },
      },
    }),
  });

  const missingDraftResult = await service.processUserMessage({
    channel: 'chat_api',
    userId: 'U-natural-user',
    message: '帮我创建一个告警定时任务',
  });

  assert.deepEqual(missingDraftResult.usedTools, []);
  assert.match(missingDraftResult.reply, /补充告警范围和执行时间/u);

  const createResult = await service.processUserMessage({
    channel: 'chat_api',
    userId: 'U-natural-user',
    message: '每天早上 8 点获取当前未处理告警信息',
  });

  assert.deepEqual(createResult.usedTools, ['task.create']);
  assert.match(createResult.reply, /当前未处理告警/u);
  assert.match(createResult.reply, /0 0 8 \* \* \*/u);

  const listResult = await service.processUserMessage({
    channel: 'chat_api',
    userId: 'U-natural-user',
    message: '我现在有哪些告警定时任务',
  });

  assert.deepEqual(listResult.usedTools, ['task.list']);
  assert.match(listResult.reply, /当前任务列表/u);
  assert.match(listResult.reply, /当前未处理告警定时获取/u);
  assert.match(listResult.reply, /0 0 8 \* \* \*/u);

  const session = service.getSessionContext('U-natural-user');
  assert.equal(session.taskWorkflow.pendingCreateDraft, undefined);
};

const verifyRefreshContract = (taskRepository: TaskRepository): void => {
  const actions: string[] = [];

  const unsubscribe = taskRepository.subscribe((event) => {
    actions.push(event.action);
  });

  const createdTask = taskRepository.createTask({
    userId: 'U-refresh-user',
    alertScope: '当前未处理告警',
    cron: '0 30 6 * * *',
    source: 'api',
  });

  taskRepository.updateTask({
    userId: 'U-refresh-user',
    taskId: createdTask.id,
    cron: '0 45 6 * * *',
  });

  taskRepository.deleteTask(createdTask.id, 'U-refresh-user');
  unsubscribe();

  assert.deepEqual(actions, ['create', 'update', 'delete']);
};

const verify = async (): Promise<void> => {
  const tempDirectoryPath = mkdtempSync(path.join(tmpdir(), 'easy-line-task-'));
  const apiTasksFilePath = path.join(tempDirectoryPath, 'tasks-api.json');
  const commandTasksFilePath = path.join(tempDirectoryPath, 'tasks-command.json');
  const naturalLanguageTasksFilePath = path.join(
    tempDirectoryPath,
    'tasks-natural-language.json',
  );
  const refreshTasksFilePath = path.join(tempDirectoryPath, 'tasks-refresh.json');

  createTasksFile(apiTasksFilePath);
  createTasksFile(commandTasksFilePath);
  createTasksFile(naturalLanguageTasksFilePath);
  createTasksFile(refreshTasksFilePath);

  try {
    const apiRepository = createRepository(apiTasksFilePath);
    const commandRepository = createRepository(commandTasksFilePath);
    const naturalLanguageRepository = createRepository(naturalLanguageTasksFilePath);
    const refreshRepository = createRepository(refreshTasksFilePath);

    assert.equal(apiRepository.listAllTasks().length, 1);
    assert.equal(apiRepository.listAllTasks()[0]?.id, 'alarm-task-seed-001');

    await verifyTaskApi(apiRepository);
    verifyTaskCommands(commandRepository, commandTasksFilePath);
    await verifyNaturalLanguage(naturalLanguageRepository);
    verifyRefreshContract(refreshRepository);

    console.info('Task CRUD slice verification passed.');
  } finally {
    rmSync(tempDirectoryPath, { force: true, recursive: true });
  }
};

void verify().catch((error: unknown) => {
  console.error('Task CRUD slice verification failed.', error);
  process.exitCode = 1;
});
