import { config } from '../config';

import {
  createTavilySearchTool,
  type TavilySearchTool,
  type TavilySearchToolOptions,
} from './tavily-search';

export type AgentTool = TavilySearchTool;

export interface RegisteredTool {
  description: string;
  name: string;
}

export interface ToolRegistryOptions {
  tavilySearch?: TavilySearchToolOptions;
}

export class ToolRegistry<TTool extends RegisteredTool = RegisteredTool> {
  private readonly tools = new Map<string, TTool>();

  register(tool: TTool): TTool {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
    return tool;
  }

  get(name: string): TTool | undefined {
    return this.tools.get(name);
  }

  getAll(): TTool[] {
    return [...this.tools.values()];
  }

  getNames(): string[] {
    return [...this.tools.keys()];
  }
}

export const createToolRegistry = (
  options: ToolRegistryOptions = {},
): ToolRegistry<AgentTool> => {
  const registry = new ToolRegistry<AgentTool>();

  registry.register(
    createTavilySearchTool({
      apiBaseUrl: config.tavilyApiBaseUrl,
      apiKey: config.tavilyApiKey,
      timeoutMs: config.tavilySearchTimeoutMs,
      ...options.tavilySearch,
    }),
  );

  return registry;
};
