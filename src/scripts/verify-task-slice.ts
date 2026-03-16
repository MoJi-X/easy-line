process.env.LINE_CHANNEL_SECRET ??= 'verify-line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'verify-line-token';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';

import { errorHandler, notFoundHandler } from '../errors/error-handler';
import { createTasksRouter } from '../routes/tasks';
import { TaskRepository, type DailyWeatherTask } from '../services/task-repository';
import { tryHandleTaskCommand } from '../tools/task-tools';

const createSeedTask = (): DailyWeatherTask => {
  return {
    id: 'weather-seed-001',
    type: 'daily_weather',
    name: '台北天气提醒',
    ownerUserId: 'U-seed-user',
    city: '台北',
    dailyTime: '08:00',
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
      return `weather-test-${String(idCounter).padStart(3, '0')}`;
    },
    now: () => {
      const now = new Date(Date.UTC(2026, 2, 16, 8, minuteOffset, 0, 0));
      minuteOffset += 1;
      return now;
    },
  });
};

const readTasksFromFile = (filePath: string): DailyWeatherTask[] => {
  const payload = JSON.parse(readFileSync(filePath, 'utf-8')) as {
    tasks: DailyWeatherTask[];
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
        city: '北京',
        dailyTime: '08:30',
        enabled: true,
        source: 'api',
      }),
    });

    assert.equal(createResponse.status, 201);

    const createdPayload = (await createResponse.json()) as {
      data: { task: DailyWeatherTask };
    };
    const createdTaskId = createdPayload.data.task.id;

    assert.equal(createdPayload.data.task.ownerUserId, 'U-api-user');
    assert.equal(createdPayload.data.task.type, 'daily_weather');
    assert.equal(createdPayload.data.task.source, 'api');

    const listResponse = await fetch(
      `${baseUrl}/api/tasks?userId=U-api-user`,
    );
    const listPayload = (await listResponse.json()) as {
      data: { recentExecutions: unknown[]; tasks: DailyWeatherTask[] };
    };

    assert.equal(listResponse.status, 200);
    assert.equal(listPayload.data.tasks.length, 1);
    assert.equal(listPayload.data.tasks[0]?.id, createdTaskId);
    assert.deepEqual(listPayload.data.recentExecutions, []);

    const isolatedListResponse = await fetch(
      `${baseUrl}/api/tasks?userId=U-other-user`,
    );
    const isolatedListPayload = (await isolatedListResponse.json()) as {
      data: { tasks: DailyWeatherTask[] };
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
        city: '上海',
        dailyTime: '09:00',
        enabled: false,
      }),
    });
    const updatePayload = (await updateResponse.json()) as {
      data: { task: DailyWeatherTask };
    };

    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.task.city, '上海');
    assert.equal(updatePayload.data.task.dailyTime, '09:00');
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
          dailyTime: '10:00',
        }),
      },
    );
    const forbiddenPayload = (await forbiddenResponse.json()) as {
      code: string;
    };

    assert.equal(forbiddenResponse.status, 403);
    assert.equal(forbiddenPayload.code, 'FORBIDDEN_TASK_ACCESS');

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
      message: '/task create city=深圳 time=07:15 enabled=false',
    },
    { taskRepository },
  );

  assert.ok(createResult);
  assert.deepEqual(createResult.usedTools, ['task.create']);
  assert.match(createResult.reply, /weather-test-002/u);

  const listResult = tryHandleTaskCommand(
    {
      userId: 'U-command-user',
      message: '/task list',
    },
    { taskRepository },
  );

  assert.ok(listResult);
  assert.deepEqual(listResult.usedTools, ['task.list']);
  assert.match(listResult.reply, /深圳天气提醒/u);

  const updateResult = tryHandleTaskCommand(
    {
      userId: 'U-command-user',
      message: '/task update taskId=weather-test-002 time=07:45 enabled=true',
    },
    { taskRepository },
  );

  assert.ok(updateResult);
  assert.deepEqual(updateResult.usedTools, ['task.update']);
  assert.match(updateResult.reply, /07:45/u);

  const invalidUsageResult = tryHandleTaskCommand(
    {
      userId: 'U-command-user',
      message: '/task create city=深圳',
    },
    { taskRepository },
  );

  assert.ok(invalidUsageResult);
  assert.deepEqual(invalidUsageResult.usedTools, []);
  assert.match(invalidUsageResult.reply, /需要 city 和 time 参数/u);

  const deleteResult = tryHandleTaskCommand(
    {
      userId: 'U-command-user',
      message: '/task delete taskId=weather-test-002',
    },
    { taskRepository },
  );

  assert.ok(deleteResult);
  assert.deepEqual(deleteResult.usedTools, ['task.delete']);
  assert.match(deleteResult.reply, /已删除任务/u);

  const persistedTasks = readTasksFromFile(filePath);

  assert.equal(persistedTasks.length, 1);
  assert.equal(persistedTasks[0]?.id, 'weather-seed-001');
};

const verify = async (): Promise<void> => {
  const tempDirectoryPath = mkdtempSync(path.join(tmpdir(), 'easy-line-task-'));
  const tasksFilePath = path.join(tempDirectoryPath, 'tasks.json');

  writeFileSync(
    tasksFilePath,
    JSON.stringify(
      {
        tasks: [
          createSeedTask(),
          {
            id: 'invalid-task',
            type: 'daily_weather',
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );

  try {
    const taskRepository = createRepository(tasksFilePath);

    assert.equal(taskRepository.listAllTasks().length, 1);
    assert.equal(taskRepository.listAllTasks()[0]?.id, 'weather-seed-001');

    await verifyTaskApi(taskRepository);
    verifyTaskCommands(taskRepository, tasksFilePath);

    console.info('Task CRUD slice verification passed.');
  } finally {
    rmSync(tempDirectoryPath, { force: true, recursive: true });
  }
};

void verify().catch((error: unknown) => {
  console.error('Task CRUD slice verification failed.', error);
  process.exitCode = 1;
});
