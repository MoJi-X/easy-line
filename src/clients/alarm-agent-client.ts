import { Readable } from 'node:stream';

import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';

import { createAppLogger } from '../utils/app-logger';

const DEFAULT_ALARM_AGENT_TIMEOUT_MS = 10000;
const ALARM_SESSION_PATH = '/api/v1/new_session';
const ALARM_LIST_PATH = '/api/v1/alarms';
const ALARM_ANALYSIS_PATH = '/api/v1/process_alarms';
const ALARM_SESSION_DETAIL_PATH = '/api/v1/session';
const ALARM_DECISION_OVERRIDE_PATH = '/api/v1/decision/override';
const MAX_ERROR_SUMMARY_LENGTH = 300;
const alarmClientLogger = createAppLogger('alarm-client');

type AlarmAgentOperation =
  | 'createSession'
  | 'listAlarms'
  | 'processAlarmsSse'
  | 'getSession'
  | 'overrideDecision';

export type AlarmAgentClientErrorType =
  | 'NOT_CONFIGURED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UPSTREAM_ERROR'
  | 'INVALID_RESPONSE'
  | 'STREAM_ERROR';

export interface AlarmAgentClientOptions {
  baseUrl?: string;
  httpClient?: AxiosInstance;
  timeoutMs?: number;
}

export interface AlarmListAlarmsParams {
  page?: number;
  page_size?: number;
  status?: string;
}

export interface AlarmProcessAlarmsRequest {
  alarms: Record<string, unknown>[];
  business_type?: string;
  force_reanalyze?: boolean;
  language?: string;
  mode?: string;
  session_id: string;
}

export interface AlarmOverrideDecisionRequest {
  decision: string;
  reason?: string;
  session_id: string;
}

export interface AlarmSseEvent {
  data: unknown;
  event: string | null;
  id?: string;
  index: number;
  retry?: number;
}

export interface AlarmProcessAlarmsSseResult {
  events: AlarmSseEvent[];
  streamCompleted: boolean;
}

interface AlarmAgentClientErrorOptions {
  cause?: unknown;
  operation: AlarmAgentOperation;
  partialEvents?: AlarmSseEvent[];
  responseSummary?: unknown;
  statusCode?: number;
}

export class AlarmAgentClientError extends Error {
  readonly cause?: unknown;

  readonly operation: AlarmAgentOperation;

  readonly partialEvents?: AlarmSseEvent[];

  readonly responseSummary?: unknown;

  readonly statusCode?: number;

  constructor(
    public readonly type: AlarmAgentClientErrorType,
    message: string,
    options: AlarmAgentClientErrorOptions,
  ) {
    super(message);
    this.name = 'AlarmAgentClientError';
    this.operation = options.operation;
    this.statusCode = options.statusCode;
    this.responseSummary = options.responseSummary;
    this.partialEvents = options.partialEvents;

    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

const trimTrailingSlash = (value: string): string => {
  return value.replace(/\/+$/, '');
};

const truncateText = (value: string, maxLength: number): string => {
  const normalizedValue = value.trim().replace(/\s+/g, ' ');

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength - 3)}...`;
};

const extractReadableMessage = (payload: unknown): string | undefined => {
  if (typeof payload === 'string') {
    const normalizedPayload = payload.trim();
    return normalizedPayload.length > 0 ? normalizedPayload : undefined;
  }

  if (Array.isArray(payload)) {
    const messages = payload
      .map((item) => extractReadableMessage(item))
      .filter((item): item is string => Boolean(item));

    if (messages.length === 0) {
      return undefined;
    }

    return [...new Set(messages)].slice(0, 3).join('; ');
  }

  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const candidateKeys = ['message', 'detail', 'error', 'msg'];

  for (const key of candidateKeys) {
    const value = (payload as Record<string, unknown>)[key];
    const readableValue = extractReadableMessage(value);

    if (readableValue) {
      return readableValue;
    }
  }

  return undefined;
};

const summarizePayload = (payload: unknown): unknown => {
  if (typeof payload === 'string') {
    return truncateText(payload, MAX_ERROR_SUMMARY_LENGTH);
  }

  if (Array.isArray(payload)) {
    return payload.slice(0, 5);
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const summary: Record<string, unknown> = {};

    ['message', 'detail', 'error', 'code', 'status'].forEach((key) => {
      const value = record[key];

      if (value !== undefined) {
        summary[key] = value;
      }
    });

    if (Object.keys(summary).length > 0) {
      return summary;
    }
  }

  return payload;
};

const parseResponsePayload = (value: string): unknown => {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return undefined;
  }

  try {
    return JSON.parse(normalizedValue) as unknown;
  } catch {
    return normalizedValue;
  }
};

const readAxiosResponseData = async (data: unknown): Promise<unknown> => {
  if (!(data instanceof Readable)) {
    return data;
  }

  let responseText = '';

  try {
    for await (const chunk of data) {
      responseText += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    }

    return parseResponsePayload(responseText);
  } catch {
    return undefined;
  } finally {
    data.destroy();
  }
};

const normalizeSseChunk = (chunk: unknown): string => {
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  return String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
};

const parseSseEventData = (value: string): unknown => {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return '';
  }

  if (normalizedValue === '[DONE]') {
    return '[DONE]';
  }

  try {
    return JSON.parse(normalizedValue) as unknown;
  } catch {
    return normalizedValue;
  }
};

const parseSseBlock = (
  block: string,
  index: number,
): AlarmSseEvent | null => {
  const normalizedBlock = block.trim();

  if (!normalizedBlock) {
    return null;
  }

  let eventName: string | null = null;
  let id: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];

  normalizedBlock.split('\n').forEach((line) => {
    if (!line || line.startsWith(':')) {
      return;
    }

    const separatorIndex = line.indexOf(':');
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const rawValue =
      separatorIndex >= 0 ? line.slice(separatorIndex + 1).replace(/^ /, '') : '';

    if (field === 'event') {
      eventName = rawValue || null;
      return;
    }

    if (field === 'data') {
      dataLines.push(rawValue);
      return;
    }

    if (field === 'id') {
      id = rawValue || undefined;
      return;
    }

    if (field === 'retry') {
      const parsedRetry = Number(rawValue);
      retry = Number.isInteger(parsedRetry) && parsedRetry >= 0
        ? parsedRetry
        : undefined;
    }
  });

  const dataText = dataLines.join('\n');

  if (!dataText && !eventName) {
    return null;
  }

  return {
    index,
    event: eventName,
    data: parseSseEventData(dataText),
    id,
    retry,
  };
};

export class AlarmAgentClient {
  private readonly baseUrl?: string;

  private readonly configured: boolean;

  private readonly httpClient: AxiosInstance;

  private readonly timeoutMs: number;

  constructor(options: AlarmAgentClientOptions = {}) {
    this.baseUrl = options.baseUrl?.trim()
      ? trimTrailingSlash(options.baseUrl.trim())
      : undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ALARM_AGENT_TIMEOUT_MS;
    this.configured = Boolean(options.httpClient || this.baseUrl);
    this.httpClient =
      options.httpClient ??
      axios.create({
        baseURL: this.baseUrl,
        timeout: this.timeoutMs,
      });
  }

  async createSession(): Promise<unknown> {
    return this.requestJson('createSession', {
      method: 'POST',
      url: ALARM_SESSION_PATH,
      data: {},
    });
  }

  async listAlarms(params: AlarmListAlarmsParams = {}): Promise<unknown> {
    return this.requestJson('listAlarms', {
      method: 'GET',
      url: ALARM_LIST_PATH,
      params,
    });
  }

  async processAlarmsSse(
    request: AlarmProcessAlarmsRequest,
  ): Promise<AlarmProcessAlarmsSseResult> {
    const startedAt = Date.now();

    this.assertConfigured('processAlarmsSse');
    alarmClientLogger.info('alarm request started', {
      operation: 'processAlarmsSse',
      timeoutMs: this.timeoutMs,
    });

    try {
      const response = await this.httpClient.request<Readable>({
        method: 'POST',
        url: ALARM_ANALYSIS_PATH,
        data: request,
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: this.timeoutMs,
      });
      const stream = response.data;

      if (!(stream instanceof Readable)) {
        throw new AlarmAgentClientError(
          'INVALID_RESPONSE',
          'Alarm analysis stream returned an invalid response.',
          {
            operation: 'processAlarmsSse',
            responseSummary: summarizePayload(response.data),
            statusCode: response.status,
          },
        );
      }

      const result = await this.collectSseEvents(stream);

      alarmClientLogger.info('alarm request succeeded', {
        operation: 'processAlarmsSse',
        durationMs: Date.now() - startedAt,
        eventCount: result.events.length,
      });

      return result;
    } catch (error) {
      const wrappedError = await this.wrapRequestError('processAlarmsSse', error);

      alarmClientLogger.error(
        'alarm request failed',
        {
          operation: 'processAlarmsSse',
          durationMs: Date.now() - startedAt,
          errorType: wrappedError.type,
          statusCode: wrappedError.statusCode,
          partialEventCount: wrappedError.partialEvents?.length,
        },
        wrappedError,
      );

      throw wrappedError;
    }
  }

  async getSession(sessionId: string): Promise<unknown> {
    return this.requestJson('getSession', {
      method: 'GET',
      url: `${ALARM_SESSION_DETAIL_PATH}/${encodeURIComponent(sessionId)}`,
    });
  }

  async overrideDecision(
    request: AlarmOverrideDecisionRequest,
  ): Promise<unknown> {
    return this.requestJson('overrideDecision', {
      method: 'POST',
      url: ALARM_DECISION_OVERRIDE_PATH,
      data: request,
    });
  }

  private assertConfigured(operation: AlarmAgentOperation): void {
    if (this.configured) {
      return;
    }

    throw new AlarmAgentClientError(
      'NOT_CONFIGURED',
      'Alarm backend is not configured. Please set ALARM_AGENT_BASE_URL first.',
      {
        operation,
      },
    );
  }

  private async collectSseEvents(
    stream: Readable,
  ): Promise<AlarmProcessAlarmsSseResult> {
    const events: AlarmSseEvent[] = [];
    let buffer = '';

    try {
      for await (const chunk of stream) {
        buffer += normalizeSseChunk(chunk);

        let boundaryIndex = buffer.indexOf('\n\n');

        while (boundaryIndex >= 0) {
          const block = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);

          const parsedEvent = parseSseBlock(block, events.length);

          if (parsedEvent) {
            events.push(parsedEvent);
          }

          boundaryIndex = buffer.indexOf('\n\n');
        }
      }

      const finalEvent = parseSseBlock(buffer, events.length);

      if (finalEvent) {
        events.push(finalEvent);
      }

      return {
        events,
        streamCompleted: true,
      };
    } catch (error) {
      throw new AlarmAgentClientError(
        'STREAM_ERROR',
        'Alarm analysis stream failed while reading SSE events.',
        {
          cause: error,
          operation: 'processAlarmsSse',
          partialEvents: events,
        },
      );
    } finally {
      stream.destroy();
    }
  }

  private async requestJson(
    operation: AlarmAgentOperation,
    requestConfig: AxiosRequestConfig,
  ): Promise<unknown> {
    const startedAt = Date.now();

    this.assertConfigured(operation);
    alarmClientLogger.info('alarm request started', {
      operation,
      timeoutMs: this.timeoutMs,
    });

    try {
      const response = await this.httpClient.request({
        ...requestConfig,
        timeout: this.timeoutMs,
      });

      alarmClientLogger.info('alarm request succeeded', {
        operation,
        durationMs: Date.now() - startedAt,
        statusCode: response.status,
      });

      return response.data;
    } catch (error) {
      const wrappedError = await this.wrapRequestError(operation, error);

      alarmClientLogger.error(
        'alarm request failed',
        {
          operation,
          durationMs: Date.now() - startedAt,
          errorType: wrappedError.type,
          statusCode: wrappedError.statusCode,
        },
        wrappedError,
      );

      throw wrappedError;
    }
  }

  private async wrapRequestError(
    operation: AlarmAgentOperation,
    error: unknown,
  ): Promise<AlarmAgentClientError> {
    if (error instanceof AlarmAgentClientError) {
      return error;
    }

    if (axios.isAxiosError(error)) {
      return this.wrapAxiosError(operation, error);
    }

    return new AlarmAgentClientError(
      'NETWORK_ERROR',
      error instanceof Error ? error.message : 'Unknown alarm request error.',
      {
        cause: error,
        operation,
      },
    );
  }

  private async wrapAxiosError(
    operation: AlarmAgentOperation,
    error: AxiosError,
  ): Promise<AlarmAgentClientError> {
    if (error.code === 'ECONNABORTED') {
      return new AlarmAgentClientError(
        'TIMEOUT',
        `Alarm request timed out after ${this.timeoutMs}ms.`,
        {
          cause: error,
          operation,
        },
      );
    }

    if (error.response) {
      const responseData = await readAxiosResponseData(error.response.data);
      const responseSummary = summarizePayload(responseData);
      const readableMessage =
        extractReadableMessage(responseData) ?? 'Unknown upstream error.';

      return new AlarmAgentClientError(
        'UPSTREAM_ERROR',
        `Alarm backend request failed with status ${error.response.status}: ${readableMessage}`,
        {
          cause: error,
          operation,
          responseSummary,
          statusCode: error.response.status,
        },
      );
    }

    if (error.request) {
      return new AlarmAgentClientError(
        'NETWORK_ERROR',
        'Alarm backend request failed because the server did not respond.',
        {
          cause: error,
          operation,
        },
      );
    }

    return new AlarmAgentClientError(
      'NETWORK_ERROR',
      error.message || 'Unknown alarm backend request error.',
      {
        cause: error,
        operation,
      },
    );
  }
}
