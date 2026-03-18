import { config } from "../config";

import {
  createAlarmTools,
  type AlarmTool,
  type AlarmToolsOptions,
} from "./alarm-tools";
import {
  createTaskTools,
  type TaskTool,
  type TaskToolsOptions,
} from "./task-tools";
import {
  createTavilySearchTool,
  type TavilySearchTool,
  type TavilySearchToolOptions,
} from "./tavily-search";
import {
  createWorkOrderTools,
  type WorkOrderTool,
  type WorkOrderToolsOptions,
} from "./workorder-tools";

export type AgentTool = TavilySearchTool | TaskTool | AlarmTool | WorkOrderTool;

export interface RegisteredTool {
  description: string;
  name: string;
}

export interface ToolRegistryOptions {
  alarmTools?: AlarmToolsOptions;
  taskTools?: TaskToolsOptions;
  tavilySearch?: TavilySearchToolOptions;
  workorderTools?: WorkOrderToolsOptions;
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

  createTaskTools(options.taskTools).forEach((tool) => {
    registry.register(tool);
  });

  createAlarmTools(options.alarmTools).forEach((tool) => {
    registry.register(tool);
  });

  createWorkOrderTools(options.workorderTools).forEach((tool) => {
    registry.register(tool);
  });

  return registry;
};
