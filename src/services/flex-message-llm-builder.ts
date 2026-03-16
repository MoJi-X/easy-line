import { ChatOpenAI } from "@langchain/openai";

import { config } from "../config";
import type { NormalizedAlarmRecord } from "../tools/alarm-tools";
import { createAppLogger } from "../utils/app-logger";
import type { FlexMessage } from "./flex-message-code-builder";

const llmBuilderLogger = createAppLogger("flex-message-llm-builder");

export interface FlexMessageLLMBuilderOptions {
  model?: ChatOpenAI;
  timeoutMs?: number;
}

export interface AlarmAnalysisLLMInput {
  alarm: NormalizedAlarmRecord;
  analysisMarkdown: string;
  rawAnalysis?: string;
}

const LLM_BUILDER_SYSTEM_PROMPT = `你是一个"LINE Flex Message 告警卡片生成助手"。

## 目标
将告警研判结果转换成可直接发送给 LINE Bot 的 Flex Message JSON。

## 输出要求
1. 只输出 JSON，不要输出任何其他内容
2. 不要输出 Markdown 代码块标记（如 \`\`\`json 或 \`\`\`）
3. 不要输出解释性文字
4. JSON 必须符合 LINE Flex Message 结构规范

## 提取内容
从输入中提取以下信息：
- 研判状态（派单/观察/关闭/忽略）
- 设备名称（device_sn）
- 站点名称（site_name）
- 告警代码（alarm_code）
- 处理状态（processing_status）
- 发生时间（created_at）
- 置信度（如有）
- 告警等级（如有）
- 研判理由（从分析文本中提取关键内容）

## 卡片结构要求
使用 bubble 容器，包含以下部分：

### header
- 显示"告警研判结果"标题
- 显示研判状态（派单处理/持续观察/关闭告警/忽略告警）
- 使用深蓝色背景（#1E3A5F）

### body
- 告警对象信息：设备SN、站点、告警代码、处理状态、发生时间
- 研判结论：置信度、告警等级（如有）
- 研判理由：简洁的关键内容摘要

### footer
- 显示研判状态徽章
- 根据状态使用不同颜色：
  - 派单处理：红色（#FF6B6B），背景（#FFF0F0）
  - 持续观察：青色（#4ECDC4），背景（#E8FAF8）
  - 关闭告警：绿色（#95E1D3），背景（#E8FDF5）
  - 忽略告警：灰色（#A0A0A0），背景（#F5F5F5）

## 样式规范
- 使用 box 布局，layout 为 vertical 或 horizontal
- 文字大小：标题 lg，正文 sm
- 颜色：标题白色，正文深灰色（#333333），标签灰色（#666666）
- 间距：使用 spacing 和 margin 控制布局
- 圆角：header 使用 cornerRadius: "md"

## altText 格式
"设备 {device_sn} 告警研判结果：{研判状态}"`;

const buildLLMUserPrompt = (input: AlarmAnalysisLLMInput): string => {
  const { alarm, analysisMarkdown, rawAnalysis } = input;

  const alarmInfo = [
    `设备SN: ${alarm.device_sn ?? "未知"}`,
    `站点: ${alarm.site_name ?? "未知"}`,
    `告警代码: ${alarm.alarm_code ?? "未知"}`,
    `处理状态: ${alarm.processing_status ?? "未知"}`,
    `发生时间: ${alarm.created_at ?? "未知"}`,
  ].join("\n");

  const analysisSection = rawAnalysis ?? analysisMarkdown;

  return `## 告警信息
${alarmInfo}

## 分析结果
${analysisSection}

请根据以上信息生成 LINE Flex Message JSON。`;
};

const cleanJsonResponse = (content: string): string => {
  let jsonStr = content.trim();

  if (jsonStr.startsWith("```json")) {
    jsonStr = jsonStr.slice(7);
  } else if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.slice(3);
  }

  if (jsonStr.endsWith("```")) {
    jsonStr = jsonStr.slice(0, -3);
  }

  return jsonStr.trim();
};

const validateFlexMessageStructure = (obj: unknown): obj is FlexMessage => {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const message = obj as Record<string, unknown>;

  if (message.type !== "flex") {
    return false;
  }

  if (typeof message.altText !== "string" || message.altText.length === 0) {
    return false;
  }

  if (typeof message.contents !== "object" || message.contents === null) {
    return false;
  }

  const contents = message.contents as Record<string, unknown>;

  if (contents.type !== "bubble") {
    return false;
  }

  return true;
};

export class FlexMessageLLMBuilder {
  private model: ChatOpenAI;
  private timeoutMs: number;

  constructor(options: FlexMessageLLMBuilderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10000;

    if (options.model) {
      this.model = options.model;
    } else {
      if (!config.llmApiKey) {
        throw new Error(
          "LLM API key is required for Flex Message LLM builder. Please set LLM_API_KEY environment variable.",
        );
      }

      const modelConfig: {
        modelName: string;
        temperature: number;
        timeout: number;
        apiKey: string;
        configuration?: { baseURL?: string };
      } = {
        modelName: config.llmModel,
        temperature: 0.1,
        timeout: this.timeoutMs,
        apiKey: config.llmApiKey,
      };

      if (config.llmBaseUrl) {
        modelConfig.configuration = { baseURL: config.llmBaseUrl };
      }

      this.model = new ChatOpenAI(modelConfig);
    }
  }

  async buildAlarmAnalysisFlexMessage(
    input: AlarmAnalysisLLMInput,
  ): Promise<FlexMessage | null> {
    const startedAt = Date.now();

    try {
      llmBuilderLogger.debug("Building Flex Message with LLM", {
        deviceSn: input.alarm.device_sn,
        analysisLength: input.analysisMarkdown.length,
      });

      const userPrompt = buildLLMUserPrompt(input);

      const response = await this.model.invoke([
        { role: "system", content: LLM_BUILDER_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ]);

      const content = response.content as string;
      const jsonStr = cleanJsonResponse(content);

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(jsonStr);
      } catch (parseError) {
        llmBuilderLogger.warn("Failed to parse LLM response as JSON", {
          error: parseError instanceof Error ? parseError.message : "Unknown error",
          responseLength: content.length,
          durationMs: Date.now() - startedAt,
        });
        return null;
      }

      if (!validateFlexMessageStructure(parsedJson)) {
        llmBuilderLogger.warn("LLM response is not a valid Flex Message", {
          durationMs: Date.now() - startedAt,
        });
        return null;
      }

      llmBuilderLogger.debug("Flex Message built successfully with LLM", {
        durationMs: Date.now() - startedAt,
      });

      return parsedJson;
    } catch (error) {
      llmBuilderLogger.warn("LLM Flex Message build failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
  }
}

export const createFlexMessageLLMBuilder = (
  options?: FlexMessageLLMBuilderOptions,
): FlexMessageLLMBuilder => {
  return new FlexMessageLLMBuilder(options);
};
