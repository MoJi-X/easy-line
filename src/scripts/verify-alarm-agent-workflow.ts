import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

process.env.LINE_CHANNEL_SECRET ??= 'verify-line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'verify-line-token';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { AgentService, getWorkOrderGlobalContextAvailability } = require('../services/agent') as typeof import('../services/agent');
const { createToolRegistry } = require('../tools') as typeof import('../tools');

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  let body = '';

  for await (const chunk of req) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  }

  if (!body.trim()) {
    return {};
  }

  return JSON.parse(body) as unknown;
};

const writeJson = (
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
};

const createVerificationServer = (): Promise<{
  baseUrl: string;
  getLastListRequest: () => {
    page: string | null;
    page_size: string | null;
    status: string | null;
  } | null;
  server: Server;
}> => {
  let lastListRequest: {
    page: string | null;
    page_size: string | null;
    status: string | null;
  } | null = null;

  const server = createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'POST' && requestUrl.pathname === '/api/v1/new_session') {
        writeJson(res, 200, {
          session_id: 'session-123',
        });
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/api/v1/alarms') {
        lastListRequest = {
          status: requestUrl.searchParams.get('status'),
          page: requestUrl.searchParams.get('page'),
          page_size: requestUrl.searchParams.get('page_size'),
        };
        writeJson(res, 200, {
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
        });
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/api/v1/process_alarms') {
        const body = await readJsonBody(req);
        const alarm = body && typeof body === 'object' && 'alarm' in body
          ? (body as { alarm?: unknown }).alarm
          : undefined;
        const alarmId =
          alarm && typeof alarm === 'object' && alarm !== null && 'id' in alarm
            ? (alarm as { id?: unknown }).id
            : undefined;

        res.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        });

        if (alarmId === 102) {
          res.write('event: progress\ndata: {"message":"开始分析"}\n\n');
          res.write(
            'event: final\n' +
              'data: {"analysis_markdown":"### 分析结论\\n\\n设备 INV-0002 持续离线，建议派单排查通信链路和站点供电。"}\n\n',
          );
          res.end('data: [DONE]\n\n');
          return;
        }

        res.write('event: progress\ndata: {"message":"开始分析"}\n\n');
        res.write(
          'event: final\n' +
            'data: {"analysis_markdown":"### 分析结论\\n\\n设备 INV-0001 出现短时告警，建议继续观察。"}\n\n',
        );
        res.end('data: [DONE]\n\n');
        return;
      }

      writeJson(res, 404, {
        message: 'Not found',
      });
    })().catch((error: unknown) => {
      writeJson(res, 500, {
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve verification server address.'));
        return;
      }

      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        getLastListRequest: () => lastListRequest,
      });
    });
  });
};

const closeServer = (server: Server): Promise<void> => {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
};

const verify = async (): Promise<void> => {
  const missingContextAvailability = getWorkOrderGlobalContextAvailability({});

  assert.equal(missingContextAvailability.available, false);
  assert.deepEqual(missingContextAvailability.missingKeys, [
    'WORKORDER_TENANT_ID',
    'WORKORDER_PMMS_AUTHORIZATION',
    'WORKORDER_USER',
  ]);

  const availableContext = getWorkOrderGlobalContextAvailability({
    tenantId: 'tenant-1',
    pmmsAuthorization: 'pmms-token',
    user: 'workflow-user',
  });

  assert.equal(availableContext.available, true);
  assert.deepEqual(availableContext.missingKeys, []);

  const { server, baseUrl, getLastListRequest } = await createVerificationServer();

  try {
    const toolRegistry = createToolRegistry({
      tavilySearch: {
        apiWrapper: {
          rawResults: async (params) => {
            return {
              query: params.query,
              answer: '',
              results: [],
              response_time: 0.01,
            };
          },
        },
      },
      alarmTools: {
        clientOptions: {
          baseUrl,
          timeoutMs: 2000,
        },
      },
    });
    const service = new AgentService({
      toolRegistry,
    });

    const listResult = await service.processUserMessage({
      channel: 'chat_api',
      userId: 'alarm-user',
      message: '查看当前未处理告警',
    });

    assert.deepEqual(listResult.usedTools, ['list_alarms']);
    assert.match(listResult.reply, /1\. 告警ID/u);
    assert.match(listResult.reply, /分析第 1 条告警/u);
    assert.deepEqual(getLastListRequest(), {
      status: 'Untreated',
      page: '1',
      page_size: '20',
    });

    const listedSession = service.getSessionContext('alarm-user');

    assert.equal(listedSession.alarmWorkflow.alarmList.length, 2);
    assert.equal(listedSession.alarmWorkflow.pendingConfirmation, undefined);
    assert.equal('tenant_id' in listedSession.alarmWorkflow, false);
    assert.equal('pmms_authorization' in listedSession.alarmWorkflow, false);
    assert.equal('user' in listedSession.alarmWorkflow, false);

    const analyzeResult = await service.processUserMessage({
      channel: 'line_webhook',
      userId: 'alarm-user',
      message: '分析第 2 条告警',
    });

    assert.deepEqual(analyzeResult.usedTools, [
      'create_alarm_session',
      'analyze_alarm',
    ]);
    assert.match(analyzeResult.reply, /INV-0002/u);
    assert.match(analyzeResult.reply, /是否需要为这条告警创建工单/u);

    const analyzedSession = service.getSessionContext('alarm-user');

    assert.equal(analyzedSession.alarmWorkflow.alarmSessionId, 'session-123');
    assert.equal(analyzedSession.alarmWorkflow.selectedAlarm?.id, 102);
    assert.equal(
      analyzedSession.alarmWorkflow.pendingConfirmation,
      'create_work_order',
    );
    assert.match(
      analyzedSession.alarmWorkflow.lastAnalysisMarkdown ?? '',
      /建议派单/u,
    );

    const cancelResult = await service.processUserMessage({
      channel: 'chat_api',
      userId: 'alarm-user',
      message: '先不建单',
    });

    assert.deepEqual(cancelResult.usedTools, []);
    assert.match(cancelResult.reply, /先不建单/u);
    assert.equal(
      service.getSessionContext('alarm-user').alarmWorkflow.pendingConfirmation,
      undefined,
    );

    await service.processUserMessage({
      channel: 'chat_api',
      userId: 'alarm-user',
      message: '分析第 2 条告警',
    });

    const confirmResult = await service.processUserMessage({
      channel: 'chat_api',
      userId: 'alarm-user',
      message: '确认建单',
    });

    assert.deepEqual(confirmResult.usedTools, []);
    assert.equal(
      confirmResult.reply,
      '当前未配置全局建单上下文，暂时只能完成告警分析',
    );

    const confirmedSession = service.getSessionContext('alarm-user');

    assert.equal(confirmedSession.alarmWorkflow.pendingConfirmation, undefined);
    assert.equal(
      confirmedSession.alarmWorkflow.lastWorkOrderResult?.message,
      '当前未配置全局建单上下文，暂时只能完成告警分析',
    );

    const isolatedUserResult = await service.processUserMessage({
      channel: 'chat_api',
      userId: 'alarm-user-2',
      message: '分析第 1 条告警',
    });

    assert.deepEqual(isolatedUserResult.usedTools, []);
    assert.equal(
      isolatedUserResult.reply,
      '当前会话里还没有可分析的告警列表，请先回复“查看当前未处理告警”。',
    );
    assert.equal(
      service.getSessionContext('alarm-user-2').alarmWorkflow.alarmList.length,
      0,
    );
    assert.equal(service.getUserContext('alarm-user').length, 6);

    console.info('Alarm agent workflow verification passed.');
  } finally {
    await closeServer(server);
  }
};

void verify().catch((error: unknown) => {
  console.error('Alarm agent workflow verification failed.', error);
  process.exitCode = 1;
});
