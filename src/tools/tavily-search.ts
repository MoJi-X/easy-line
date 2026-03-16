import {
  TavilySearch,
  type TavilySearchAPIWrapper,
  type TavilySearchParams,
  type TavilySearchResponse,
} from '@langchain/tavily';
import { tool } from 'langchain';

import { createAppLogger } from '../utils/app-logger';

const DEFAULT_TAVILY_API_BASE_URL = 'https://api.tavily.com';
const DEFAULT_TAVILY_MAX_RESULTS = 3;
const DEFAULT_TAVILY_TIMEOUT_MS = 5000;
const DEFAULT_TAVILY_SEARCH_DEPTH = 'advanced';
const DEFAULT_TAVILY_TOPIC = 'general';
const MAX_RESULT_SNIPPET_LENGTH = 180;
const MAX_RESULT_TITLE_LENGTH = 80;
const TAVILY_TOOL_NAME = 'search.tavily';
const tavilyLogger = createAppLogger('tavily');

type TavilySearchDepth = 'advanced' | 'basic';
type TavilyTimeRange = 'day' | 'month' | 'week' | 'year';
type TavilyTopic = 'finance' | 'general' | 'news';

type TavilySearchToolErrorType =
  | 'MISSING_API_KEY'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'INVALID_RESPONSE';

export interface TavilySearchApiWrapperLike {
  apiBaseUrl?: string;
  rawResults: (params: TavilySearchToolRequest) => Promise<TavilySearchResponse>;
  tavilyApiKey?: string;
}

export interface TavilySearchToolOptions {
  apiBaseUrl?: string;
  apiKey?: string;
  apiWrapper?: TavilySearchApiWrapperLike;
  maxResults?: number;
  timeoutMs?: number;
}

interface TavilySearchToolInput {
  excludeDomains?: string[];
  includeDomains?: string[];
  includeImages?: boolean;
  query: string;
  searchDepth?: TavilySearchDepth;
  timeRange?: TavilyTimeRange;
  topic?: TavilyTopic;
}

interface TavilySearchToolRequest extends TavilySearchToolInput {
  includeAnswer?: boolean;
  includeImageDescriptions?: boolean;
  includeRawContent?: boolean | 'markdown' | 'text';
  includeUsage?: boolean;
  maxResults?: number;
}

class TavilySearchToolError extends Error {
  constructor(
    public readonly type: TavilySearchToolErrorType,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TavilySearchToolError';
  }
}

class TimeoutTavilySearchAPIWrapper implements TavilySearchApiWrapperLike {
  readonly apiBaseUrl: string;

  readonly tavilyApiKey?: string;

  private readonly timeoutMs: number;

  constructor(options: TavilySearchToolOptions = {}) {
    this.apiBaseUrl =
      options.apiBaseUrl?.trim() || DEFAULT_TAVILY_API_BASE_URL;
    this.tavilyApiKey =
      options.apiKey?.trim() || process.env.TAVILY_API_KEY?.trim();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TAVILY_TIMEOUT_MS;
  }

  private convertCamelToSnakeCase(
    params: object,
  ): Record<string, unknown> {
    const normalizedParams: Record<string, unknown> = {};

    Object.entries(params as Record<string, unknown>).forEach(([key, value]) => {
      if (value === undefined) {
        return;
      }

      const normalizedKey = key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
      normalizedParams[normalizedKey] = value;
    });

    return normalizedParams;
  }

  async rawResults(
    params: TavilySearchToolRequest,
  ): Promise<TavilySearchResponse> {
    if (!this.tavilyApiKey) {
      throw new TavilySearchToolError(
        'MISSING_API_KEY',
        'Tavily search is not configured.',
      );
    }

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, this.timeoutMs);

    try {
      const response = await fetch(`${this.apiBaseUrl}/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.tavilyApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...this.convertCamelToSnakeCase(params),
          client_source: 'easy-line',
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new TavilySearchToolError(
          'UPSTREAM_ERROR',
          `Tavily search failed with status ${response.status}: ${await readErrorMessage(response)}`,
        );
      }

      const payload = (await response.json()) as TavilySearchResponse;

      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.results)) {
        throw new TavilySearchToolError(
          'INVALID_RESPONSE',
          'Tavily returned an invalid response payload.',
        );
      }

      return payload;
    } catch (error) {
      if (error instanceof TavilySearchToolError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new TavilySearchToolError(
          'TIMEOUT',
          `Tavily search timed out after ${this.timeoutMs}ms.`,
          error,
        );
      }

      throw new TavilySearchToolError(
        'UPSTREAM_ERROR',
        error instanceof Error ? error.message : 'Unknown Tavily search error.',
        error,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as {
      detail?: { error?: string } | string;
      error?: string;
      message?: string;
    };

    if (typeof payload.detail === 'string' && payload.detail.trim()) {
      return payload.detail.trim();
    }

    if (
      payload.detail &&
      typeof payload.detail === 'object' &&
      typeof payload.detail.error === 'string' &&
      payload.detail.error.trim()
    ) {
      return payload.detail.error.trim();
    }

    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }

    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
  } catch {
    // Ignore malformed upstream error payloads and fall back to a generic message.
  }

  return 'Unknown upstream error.';
};

const truncateText = (value: string, maxLength: number): string => {
  const normalizedValue = value.trim().replace(/\s+/g, ' ');

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength - 3)}...`;
};

const buildResultSummary = (payload: TavilySearchResponse): string => {
  const sections = [
    '以下是 `search.tavily` 的实时搜索结果，请基于这些结果整理中文回复，不要编造未出现的事实。',
    `查询: ${payload.query}`,
  ];

  if (typeof payload.answer === 'string' && payload.answer.trim()) {
    sections.push(`搜索摘要: ${truncateText(payload.answer, 300)}`);
  }

  const topResults = payload.results.slice(0, DEFAULT_TAVILY_MAX_RESULTS);

  if (topResults.length === 0) {
    sections.push('参考来源: 未检索到可靠结果。');
    return sections.join('\n\n');
  }

  const resultLines = topResults.map((result, index) => {
    const title = truncateText(result.title || result.url, MAX_RESULT_TITLE_LENGTH);
    const summary = truncateText(result.content || '未返回摘要。', MAX_RESULT_SNIPPET_LENGTH);

    return [
      `${index + 1}. ${title}`,
      `来源: ${result.url}`,
      `摘要: ${summary}`,
    ].join('\n');
  });

  sections.push(`参考来源:\n${resultLines.join('\n\n')}`);

  return sections.join('\n\n');
};

const mapTavilyErrorToReadableMessage = (error: unknown): string => {
  if (error instanceof TavilySearchToolError) {
    if (error.type === 'MISSING_API_KEY') {
      return '实时搜索当前不可用：搜索服务尚未完成配置。请直接告诉用户暂时无法获取最新外部信息，不要编造答案。';
    }

    if (error.type === 'TIMEOUT') {
      return '实时搜索当前不可用：搜索请求超时了。请直接告诉用户稍后重试，不要编造答案。';
    }
  }

  return '实时搜索当前不可用：搜索服务暂时异常。请直接告诉用户稍后重试，不要编造答案。';
};

const buildSearchRequest = (
  input: TavilySearchToolInput,
  maxResults: number,
): TavilySearchToolRequest => {
  return {
    query: input.query,
    includeDomains: input.includeDomains,
    excludeDomains: input.excludeDomains,
    includeImages: input.includeImages,
    searchDepth: input.searchDepth ?? DEFAULT_TAVILY_SEARCH_DEPTH,
    timeRange: input.timeRange,
    topic: input.topic ?? DEFAULT_TAVILY_TOPIC,
    maxResults,
    includeAnswer: true,
    includeRawContent: false,
    includeImageDescriptions: false,
    includeUsage: false,
  };
};

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalizedValues = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return normalizedValues.length > 0 ? normalizedValues : undefined;
};

const normalizeToolInput = (input: Record<string, unknown>): TavilySearchToolInput => {
  return {
    query: typeof input.query === 'string' ? input.query : '',
    includeDomains: normalizeStringArray(input.includeDomains),
    excludeDomains: normalizeStringArray(input.excludeDomains),
    includeImages:
      typeof input.includeImages === 'boolean' ? input.includeImages : undefined,
    searchDepth:
      input.searchDepth === 'basic' || input.searchDepth === 'advanced'
        ? input.searchDepth
        : undefined,
    timeRange:
      input.timeRange === 'day' ||
      input.timeRange === 'week' ||
      input.timeRange === 'month' ||
      input.timeRange === 'year'
        ? input.timeRange
        : undefined,
    topic:
      input.topic === 'general' ||
      input.topic === 'news' ||
      input.topic === 'finance'
        ? input.topic
        : undefined,
  };
};

export const createTavilySearchTool = (
  options: TavilySearchToolOptions = {},
) => {
  const maxResults = options.maxResults ?? DEFAULT_TAVILY_MAX_RESULTS;
  const apiWrapper =
    options.apiWrapper ??
    new TimeoutTavilySearchAPIWrapper({
      apiBaseUrl: options.apiBaseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
    });
  const baseTool = new TavilySearch({
    apiWrapper: apiWrapper as unknown as TavilySearchAPIWrapper,
    includeAnswer: true,
    includeRawContent: false,
    maxResults,
  });

  return tool(
    async (input: Record<string, unknown>) => {
      const startedAt = Date.now();
      const normalizedInput = normalizeToolInput(input);
      const searchRequest = buildSearchRequest(normalizedInput, maxResults);
      const includeDomains = Array.isArray(searchRequest.includeDomains)
        ? searchRequest.includeDomains
        : [];
      const excludeDomains = Array.isArray(searchRequest.excludeDomains)
        ? searchRequest.excludeDomains
        : [];

      tavilyLogger.info('tavily search requested', {
        query: truncateText(normalizedInput.query, 120),
        topic:
          typeof searchRequest.topic === 'string'
            ? searchRequest.topic
            : DEFAULT_TAVILY_TOPIC,
        searchDepth:
          typeof searchRequest.searchDepth === 'string'
            ? searchRequest.searchDepth
            : DEFAULT_TAVILY_SEARCH_DEPTH,
        includeDomainCount: includeDomains.length,
        excludeDomainCount: excludeDomains.length,
      });

      try {
        const payload = await apiWrapper.rawResults(searchRequest);
        const summary = buildResultSummary(payload);

        tavilyLogger.info('tavily search succeeded', {
          query: truncateText(normalizedInput.query, 120),
          resultCount: payload.results.length,
          durationMs: Date.now() - startedAt,
        });

        return summary;
      } catch (error) {
        const fallbackMessage = mapTavilyErrorToReadableMessage(error);

        tavilyLogger.warn('tavily search degraded gracefully', {
          query: truncateText(normalizedInput.query, 120),
          durationMs: Date.now() - startedAt,
          errorType:
            error instanceof TavilySearchToolError ? error.type : 'UNKNOWN',
        });

        return fallbackMessage;
      }
    },
    {
      name: TAVILY_TOOL_NAME,
      description: [
        '当用户的问题依赖最新、当前、实时、今天、本周、近期变化的外部信息时，使用这个工具。',
        'Use this tool for current events, recent announcements, market updates, live external facts, and other information that may have changed recently.',
        '不要把它用于纯常识、稳定历史事实或任务 CRUD。',
      ].join(' '),
      schema: baseTool.schema,
    },
  );
};

export type TavilySearchTool = ReturnType<typeof createTavilySearchTool>;
