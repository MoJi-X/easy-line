import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

process.env.LINE_CHANNEL_SECRET ??= 'verify-line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'verify-line-token';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { createAlarmTools } = require('../tools/alarm-tools') as typeof import('../tools/alarm-tools');
const { createToolRegistry } = require('../tools') as typeof import('../tools');

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
): void => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
};

const createVerificationServer = (): Promise<{
  baseUrl: string;
  server: Server;
}> => {
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
        writeJson(res, 200, {
          total: 1,
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

        if (alarmId === 999) {
          res.write(
            'event: chunk\n' +
              'data: {"content":"设备 INV-999 持续离线，建议继续排查。"}\n\n',
          );

          setTimeout(() => {
            res.destroy(new Error('stream interrupted for verification'));
          }, 10);
          return;
        }

        res.write('event: progress\ndata: {"message":"开始分析"}\n\n');
        res.write(
          'event: chunk\n' +
            'data: {"content":"设备 INV-0001 发生离线告警，通信可能异常。"}\n\n',
        );
        res.write(
          'event: final\n' +
            'data: {"analysis_markdown":"### 分析结论\\n\\n设备 INV-0001 持续离线，建议派单排查通信链路和设备供电。"}\n\n',
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
  const { server, baseUrl } = await createVerificationServer();

  try {
    const tools = createAlarmTools({
      clientOptions: {
        baseUrl,
        timeoutMs: 2000,
      },
    }) as GenericTool[];

    const registry = createToolRegistry({
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

    assert.deepEqual(registry.getNames(), [
      'search.tavily',
      'create_alarm_session',
      'list_alarms',
      'analyze_alarm',
      'create_work_order',
    ]);

    const createAlarmSessionTool = findTool(tools, 'create_alarm_session');
    const listAlarmsTool = findTool(tools, 'list_alarms');
    const analyzeAlarmTool = findTool(tools, 'analyze_alarm');

    const sessionResult = (await createAlarmSessionTool.invoke({})) as {
      session_id: string;
      success: boolean;
    };

    assert.equal(sessionResult.success, true);
    assert.equal(sessionResult.session_id, 'session-123');

    const listResult = (await listAlarmsTool.invoke({})) as {
      alarm_summary_markdown: string;
      alarms: Array<{ device_sn: string; id: number }>;
      success: boolean;
      total: number;
    };

    assert.equal(listResult.success, true);
    assert.equal(listResult.total, 1);
    assert.equal(listResult.alarms[0]?.id, 101);
    assert.equal(listResult.alarms[0]?.device_sn, 'INV-0001');
    assert.match(listResult.alarm_summary_markdown, /1\. 告警ID/u);

    const analyzeResult = (await analyzeAlarmTool.invoke({
      session_id: 'session-123',
      alarm: {
        id: 101,
        device_sn: 'INV-0001',
        siteName: 'Bangkok PV Site',
      },
    })) as {
      analysis_markdown: string;
      raw_events: unknown[];
      should_offer_dispatch: boolean | null;
      success: boolean;
    };

    assert.equal(analyzeResult.success, true);
    assert.equal(analyzeResult.should_offer_dispatch, true);
    assert.match(analyzeResult.analysis_markdown, /分析结论/u);
    assert.match(analyzeResult.analysis_markdown, /建议派单/u);
    assert.ok(analyzeResult.raw_events.length >= 2);

    const interruptedAnalyzeResult = (await analyzeAlarmTool.invoke({
      session_id: 'session-123',
      alarm: {
        id: 999,
        device_sn: 'INV-999',
      },
    })) as {
      error_type: string;
      partial_analysis?: string;
      success: boolean;
    };

    assert.equal(interruptedAnalyzeResult.success, false);
    assert.equal(interruptedAnalyzeResult.error_type, 'alarm_analysis_failed');
    assert.match(interruptedAnalyzeResult.partial_analysis ?? '', /INV-999/u);

    console.info('Alarm tools verification passed.');
  } finally {
    await closeServer(server);
  }
};

void verify().catch((error: unknown) => {
  console.error('Alarm tools verification failed.', error);
  process.exitCode = 1;
});
