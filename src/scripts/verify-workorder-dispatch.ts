import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

process.env.LINE_CHANNEL_SECRET ??= 'verify-line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'verify-line-token';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { AgentService } = require('../services/agent') as typeof import('../services/agent');
const { config } = require('../config') as typeof import('../config');
const { createToolRegistry } = require('../tools') as typeof import('../tools');
const { createWorkOrderTools } = require('../tools/workorder-tools') as typeof import('../tools/workorder-tools');

type GenericTool = {
  invoke: (input: unknown) => Promise<unknown>;
  name: string;
};

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
  headers: Record<string, string> = {},
): void => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(payload));
};

const createAlarmVerificationServer = (): Promise<{
  baseUrl: string;
  getLastListRequest: () => {
    page: string | null;
    page_size: string | null;
    status: string | null;
  } | null;
  getLastProcessRequest: () => unknown;
  server: Server;
}> => {
  let lastListRequest: {
    page: string | null;
    page_size: string | null;
    status: string | null;
  } | null = null;
  let lastProcessRequest: unknown;

  const server = createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'POST' && requestUrl.pathname === '/api/v1/new_session') {
        writeJson(res, 200, {
          session_id: 'session-workorder-123',
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
          total: 1,
          page: 1,
          page_size: 20,
          data: [
            {
              id: 201,
              deviceSn: 'INV-201',
              deviceType: 'inverter',
              siteName: 'Bangkok PV Site',
              alarmType: 'Offline',
              alarmTypeName: 'Device Offline',
              alarm_code: '130',
              processingStatus: 'Untreated',
              createdAt: '2026-03-16 09:20:00',
              raw_data: JSON.stringify({
                deviceSn: 'INV-201',
                deviceType: 'inverter',
                siteName: 'Bangkok PV Site',
                alarmType: 'Offline',
                alarmTypeName: 'Device Offline',
                alarm_code: '130',
              }),
            },
          ],
        });
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/api/v1/process_alarms') {
        lastProcessRequest = await readJsonBody(req);
        res.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        });
        res.write('event: progress\ndata: {"message":"开始分析"}\n\n');
        res.write(
          'event: final\n' +
            'data: {"analysis_markdown":"### 分析结论\\n\\n设备 INV-201 持续离线超过 4 小时，建议尽快派单排查通信链路、电源状态、站点网络和数据采集链路，并在处理完成后回写结果。"}\n\n',
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
        reject(new Error('Failed to resolve alarm verification server address.'));
        return;
      }

      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        getLastListRequest: () => lastListRequest,
        getLastProcessRequest: () => lastProcessRequest,
      });
    });
  });
};

const createWorkOrderVerificationServer = (): Promise<{
  baseUrl: string;
  getLastRequestBody: () => unknown;
  server: Server;
}> => {
  let lastRequestBody: unknown;

  const server = createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'POST' && requestUrl.pathname === '/v1/workflows/run') {
        lastRequestBody = await readJsonBody(req);
        writeJson(
          res,
          200,
          {
            workflow_run_id: 'workflow-run-live-001',
            data: {
              id: 'workflow-run-live-001',
              status: 'succeeded',
              outputs: {
                work_order_id: 'WO20260316001',
                work_order_no: 'GD-20260316-001',
                title: 'Bangkok PV Site Device Offline 工单',
                level: 'HIGH',
                status: 'created',
                assignee: 'iRunDo',
                acceptor: 'iRunDo',
                description: '根据告警分析自动建单',
                start_time: '2026-03-16 11:25:38',
                end_time: '2026-03-23 11:25:38',
              },
            },
          },
          {
            'x-request-id': 'req-live-001',
          },
        );
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
        reject(
          new Error('Failed to resolve workorder verification server address.'),
        );
        return;
      }

      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        getLastRequestBody: () => lastRequestBody,
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

const findTool = (tools: GenericTool[], name: string): GenericTool => {
  const targetTool = tools.find((tool) => tool.name === name);

  assert.ok(targetTool, `Missing tool ${name}`);
  return targetTool;
};

const verify = async (): Promise<void> => {
  const originalConfig = {
    workorderPmmsAuthorization: config.workorderPmmsAuthorization,
    workorderTenantId: config.workorderTenantId,
    workorderUser: config.workorderUser,
  };

  config.workorderPmmsAuthorization = undefined;
  config.workorderTenantId = undefined;
  config.workorderUser = undefined;

  const missingConfigTools = createWorkOrderTools({
    runtimeConfig: {
      mockCreateWorkOrder: false,
    },
  }) as GenericTool[];
  const missingConfigTool = findTool(missingConfigTools, 'create_work_order');
  const missingConfigResult = (await missingConfigTool.invoke({
    alarm: {
      id: 201,
      device_sn: 'INV-201',
    },
    analysis_markdown: '设备持续离线，建议派单排查通信链路和站点供电。',
  })) as {
    error_type: string;
    success: boolean;
  };

  assert.equal(missingConfigResult.success, false);
  assert.equal(missingConfigResult.error_type, 'missing_business_context');

  const mockTools = createWorkOrderTools({
    runtimeConfig: {
      mockCreateWorkOrder: true,
      workorderPmmsAuthorization: 'pmms-mock-token',
      workorderTenantId: 'tenant-mock',
      workorderUser: 'workflow-mock-user',
    },
  }) as GenericTool[];
  const mockTool = findTool(mockTools, 'create_work_order');
  const mockResult = (await mockTool.invoke({
    alarm: {
      id: 202,
      device_sn: '',
      raw_data: JSON.stringify({
        externalId: 'INV-202-RAW',
      }),
      site_name: 'Mock PV Site',
      alarm_type_name: 'Device Offline',
    },
    analysis_markdown:
      '### 分析结论\n\n设备 INV-202-RAW 长时间离线，建议派单核查现场通信链路、电源状态和数据采集链路。',
  })) as {
    mock: boolean;
    success: boolean;
    title: string | null;
    work_order_no: string | null;
  };

  assert.equal(mockResult.success, true);
  assert.equal(mockResult.mock, true);
  assert.match(mockResult.work_order_no ?? '', /^MOCK-/u);
  assert.match(mockResult.title ?? '', /INV-202-RAW/u);

  const {
    server: alarmServer,
    baseUrl: alarmBaseUrl,
    getLastListRequest,
    getLastProcessRequest,
  } =
    await createAlarmVerificationServer();
  const {
    server: workorderServer,
    baseUrl: workorderBaseUrl,
    getLastRequestBody,
  } = await createWorkOrderVerificationServer();

  try {
    const liveTools = createWorkOrderTools({
      clientOptions: {
        timeoutMs: 2000,
        workflowUrl: `${workorderBaseUrl}/v1/workflows/run`,
      },
      runtimeConfig: {
        mockCreateWorkOrder: false,
        workorderPmmsAuthorization: 'pmms-live-token',
        workorderTenantId: 'tenant-live',
        workorderUser: 'workflow-live-user',
      },
    }) as GenericTool[];
    const liveTool = findTool(liveTools, 'create_work_order');
    const liveResult = (await liveTool.invoke({
      alarm: {
        id: 201,
        device_sn: '',
        device_type: 'inverter',
        site_name: 'Bangkok PV Site',
        alarm_category: 'AlarmWorkOrder',
        alarm_type: 'Offline',
        alarm_type_name: 'Device Offline',
        fault_code: 130,
        created_at: '2026-03-16 09:20:00',
        raw_data: JSON.stringify({
          externalId: 'INV-201-RAW',
        }),
      },
      analysis_markdown:
        '### 分析结论\n\n设备 INV-201-RAW 持续离线超过 4 小时，建议尽快派单排查通信链路、电源状态、站点网络和数据采集链路，并在处理完成后回写结果。',
    })) as {
      mock: boolean;
      request_id?: string;
      success: boolean;
      work_order_no: string | null;
      workflow_run_id: string;
    };

    assert.equal(liveResult.success, true);
    assert.equal(liveResult.mock, false);
    assert.equal(liveResult.workflow_run_id, 'workflow-run-live-001');
    assert.equal(liveResult.work_order_no, 'GD-20260316-001');
    assert.equal(liveResult.request_id, 'req-live-001');

    const directRequestBody = getLastRequestBody() as {
      inputs?: Record<string, unknown>;
      user?: string;
    };

    assert.equal(directRequestBody.user, 'workflow-live-user');
    assert.equal(directRequestBody.inputs?.tenant_id, 'tenant-live');
    assert.equal(
      directRequestBody.inputs?.pmms_authorization,
      'pmms-live-token',
    );
    assert.equal(directRequestBody.inputs?.device_sn, 'INV-201-RAW');
    assert.equal(directRequestBody.inputs?.alarm_id, '201');
    assert.equal(typeof directRequestBody.inputs?.fault_desc, 'string');
    assert.match(
      directRequestBody.inputs?.fault_desc as string,
      /INV-201-RAW/u,
    );
    assert.ok(
      (directRequestBody.inputs?.fault_desc as string).length >= 100,
      'fault_desc should be at least 100 characters.',
    );
    assert.ok(
      (directRequestBody.inputs?.fault_desc as string).length <= 400,
      'fault_desc should be at most 400 characters.',
    );

    config.workorderTenantId = 'tenant-live';
    config.workorderPmmsAuthorization = 'pmms-live-token';
    config.workorderUser = 'workflow-live-user';

    const liveService = new AgentService({
      toolRegistry: createToolRegistry({
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
            baseUrl: alarmBaseUrl,
            timeoutMs: 2000,
          },
        },
        workorderTools: {
          clientOptions: {
            timeoutMs: 2000,
            workflowUrl: `${workorderBaseUrl}/v1/workflows/run`,
          },
          runtimeConfig: {
            mockCreateWorkOrder: false,
            workorderPmmsAuthorization: 'pmms-live-token',
            workorderTenantId: 'tenant-live',
            workorderUser: 'workflow-live-user',
          },
        },
      }),
    });

    const listResult = await liveService.processUserMessage({
      channel: 'chat_api',
      userId: 'live-user',
      message: '查看当前未处理告警',
    });

    assert.deepEqual(listResult.usedTools, ['list_alarms']);
    assert.deepEqual(getLastListRequest(), {
      status: 'Untreated',
      page: '1',
      page_size: '20',
    });

    const analyzeResult = await liveService.processUserMessage({
      channel: 'chat_api',
      userId: 'live-user',
      message: '分析第 1 条告警',
    });

    assert.deepEqual(analyzeResult.usedTools, [
      'create_alarm_session',
      'analyze_alarm',
    ]);
    assert.deepEqual(getLastProcessRequest(), {
      session_id: 'session-workorder-123',
      alarms: [
        {
          id: 201,
          deviceSn: 'INV-201',
          deviceType: 'inverter',
          siteName: 'Bangkok PV Site',
          alarmType: 'Offline',
          alarmTypeName: 'Device Offline',
          alarm_code: '130',
        },
      ],
      mode: 'standard',
      business_type: 'device_alarm',
      force_reanalyze: false,
      language: 'zh',
    });
    assert.match(analyzeResult.reply, /是否需要为这条告警创建工单/u);

    const confirmResult = await liveService.processUserMessage({
      channel: 'chat_api',
      userId: 'live-user',
      message: '确认建单',
    });

    assert.deepEqual(confirmResult.usedTools, ['create_work_order']);
    assert.match(confirmResult.reply, /已为这条告警创建工单/u);
    assert.match(confirmResult.reply, /GD-20260316-001/u);

    const liveSession = liveService.getSessionContext('live-user');

    assert.equal(liveSession.alarmWorkflow.pendingConfirmation, undefined);
    assert.equal(
      liveSession.alarmWorkflow.lastWorkOrderResult?.work_order_no,
      'GD-20260316-001',
    );

    console.info('Workorder dispatch verification passed.');
  } finally {
    config.workorderTenantId = originalConfig.workorderTenantId;
    config.workorderPmmsAuthorization =
      originalConfig.workorderPmmsAuthorization;
    config.workorderUser = originalConfig.workorderUser;
    await closeServer(alarmServer);
    await closeServer(workorderServer);
  }
};

void verify().catch((error: unknown) => {
  console.error('Workorder dispatch verification failed.', error);
  process.exitCode = 1;
});
