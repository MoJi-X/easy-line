import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosResponseHeaders,
  type RawAxiosResponseHeaders,
} from 'axios';

import { createAppLogger } from '../utils/app-logger';

const DEFAULT_WORKORDER_TIMEOUT_MS = 10000;
const MAX_ERROR_SUMMARY_LENGTH = 300;
const workorderClientLogger = createAppLogger('workorder-client');

type WorkOrderOperation = 'runWorkflow';

export type WorkOrderClientErrorType =
  | 'NOT_CONFIGURED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UPSTREAM_ERROR';

export interface WorkOrderClientOptions {
  apiKey?: string;
  httpClient?: AxiosInstance;
  timeoutMs?: number;
  workflowUrl?: string;
}

export interface WorkOrderWorkflowRequest {
  inputs: Record<string, unknown>;
  response_mode: 'blocking';
  user: string;
}

export interface WorkOrderWorkflowResponse {
  data: unknown;
  requestId?: string;
  statusCode: number;
}

interface WorkOrderClientErrorOptions {
  cause?: unknown;
  operation: WorkOrderOperation;
  requestId?: string;
  responseSummary?: unknown;
  statusCode?: number;
}

export class WorkOrderClientError extends Error {
  readonly cause?: unknown;

  readonly operation: WorkOrderOperation;

  readonly requestId?: string;

  readonly responseSummary?: unknown;

  readonly statusCode?: number;

  constructor(
    public readonly type: WorkOrderClientErrorType,
    message: string,
    options: WorkOrderClientErrorOptions,
  ) {
    super(message);
    this.name = 'WorkOrderClientError';
    this.operation = options.operation;
    this.requestId = options.requestId;
    this.responseSummary = options.responseSummary;
    this.statusCode = options.statusCode;

    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

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

  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const candidateKeys = ['message', 'detail', 'error'];

  for (const key of candidateKeys) {
    const candidate = (payload as Record<string, unknown>)[key];
    const readableMessage = extractReadableMessage(candidate);

    if (readableMessage) {
      return readableMessage;
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

const extractHeaderValue = (
  headers: RawAxiosResponseHeaders | AxiosResponseHeaders | undefined,
  key: string,
): string | undefined => {
  if (!headers) {
    return undefined;
  }

  const value = headers[key];

  if (typeof value === 'string') {
    const normalizedValue = value.trim();
    return normalizedValue.length > 0 ? normalizedValue : undefined;
  }

  if (Array.isArray(value)) {
    const firstValue = value.find((item) => typeof item === 'string');
    const normalizedValue = firstValue?.trim();
    return normalizedValue && normalizedValue.length > 0
      ? normalizedValue
      : undefined;
  }

  return undefined;
};

const extractRequestId = (
  headers: RawAxiosResponseHeaders | AxiosResponseHeaders | undefined,
): string | undefined => {
  return (
    extractHeaderValue(headers, 'x-request-id') ??
    extractHeaderValue(headers, 'request-id') ??
    extractHeaderValue(headers, 'x_request_id')
  );
};

export class WorkOrderClient {
  private readonly apiKey?: string;

  private readonly configured: boolean;

  private readonly httpClient: AxiosInstance;

  private readonly timeoutMs: number;

  private readonly workflowUrl?: string;

  constructor(options: WorkOrderClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WORKORDER_TIMEOUT_MS;
    this.workflowUrl = options.workflowUrl?.trim() || undefined;
    this.configured = Boolean(options.httpClient || this.workflowUrl);
    this.httpClient = options.httpClient ?? axios.create({
      timeout: this.timeoutMs,
    });
  }

  async runWorkflow(
    request: WorkOrderWorkflowRequest,
  ): Promise<WorkOrderWorkflowResponse> {
    const startedAt = Date.now();

    this.assertConfigured('runWorkflow');
    workorderClientLogger.info('workorder request started', {
      operation: 'runWorkflow',
      timeoutMs: this.timeoutMs,
    });

    try {
      const response = await this.httpClient.request({
        method: 'POST',
        url: this.workflowUrl,
        data: request,
        headers: {
          Accept: 'application/json',
          Authorization: this.apiKey ? `Bearer ${this.apiKey}` : undefined,
          'Content-Type': 'application/json',
        },
        timeout: this.timeoutMs,
      });
      const requestId = extractRequestId(response.headers);

      workorderClientLogger.info('workorder request succeeded', {
        operation: 'runWorkflow',
        durationMs: Date.now() - startedAt,
        requestId,
        statusCode: response.status,
      });

      return {
        data: response.data,
        requestId,
        statusCode: response.status,
      };
    } catch (error) {
      const wrappedError = this.wrapRequestError('runWorkflow', error);

      workorderClientLogger.error(
        'workorder request failed',
        {
          operation: 'runWorkflow',
          durationMs: Date.now() - startedAt,
          errorType: wrappedError.type,
          requestId: wrappedError.requestId,
          statusCode: wrappedError.statusCode,
        },
        wrappedError,
      );

      throw wrappedError;
    }
  }

  private assertConfigured(operation: WorkOrderOperation): void {
    if (this.configured) {
      return;
    }

    throw new WorkOrderClientError(
      'NOT_CONFIGURED',
      'Workorder workflow is not configured. Please set WORKORDER_WORKFLOW_URL first.',
      {
        operation,
      },
    );
  }

  private wrapRequestError(
    operation: WorkOrderOperation,
    error: unknown,
  ): WorkOrderClientError {
    if (error instanceof WorkOrderClientError) {
      return error;
    }

    if (axios.isAxiosError(error)) {
      return this.wrapAxiosError(operation, error);
    }

    return new WorkOrderClientError(
      'NETWORK_ERROR',
      error instanceof Error
        ? error.message
        : 'Unknown workorder workflow request error.',
      {
        cause: error,
        operation,
      },
    );
  }

  private wrapAxiosError(
    operation: WorkOrderOperation,
    error: AxiosError,
  ): WorkOrderClientError {
    if (error.code === 'ECONNABORTED') {
      return new WorkOrderClientError(
        'TIMEOUT',
        `Workorder workflow request timed out after ${this.timeoutMs}ms.`,
        {
          cause: error,
          operation,
        },
      );
    }

    if (error.response) {
      const responseSummary = summarizePayload(error.response.data);
      const readableMessage =
        extractReadableMessage(error.response.data) ?? 'Unknown upstream error.';

      return new WorkOrderClientError(
        'UPSTREAM_ERROR',
        `Workorder workflow request failed with status ${error.response.status}: ${readableMessage}`,
        {
          cause: error,
          operation,
          requestId: extractRequestId(error.response.headers),
          responseSummary,
          statusCode: error.response.status,
        },
      );
    }

    if (error.request) {
      return new WorkOrderClientError(
        'NETWORK_ERROR',
        'Workorder workflow request failed because the server did not respond.',
        {
          cause: error,
          operation,
        },
      );
    }

    return new WorkOrderClientError(
      'NETWORK_ERROR',
      error.message || 'Unknown workorder workflow request error.',
      {
        cause: error,
        operation,
      },
    );
  }
}
