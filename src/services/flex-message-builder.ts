import { config } from "../config";
import type { NormalizedAlarmRecord } from "../tools/alarm-tools";
import { createAppLogger } from "../utils/app-logger";
import {
  buildAlarmAnalysisFlexMessage,
  type AlarmAnalysisInput,
  type FlexMessage,
  type FlexMessageAction,
  parseFlexMessageAction,
} from "./flex-message-code-builder";
import {
  createFlexMessageLLMBuilder,
  type AlarmAnalysisLLMInput,
  FlexMessageLLMBuilder,
} from "./flex-message-llm-builder";

const flexMessageLogger = createAppLogger("flex-message-builder");

export type { FlexMessage, FlexMessageAction } from "./flex-message-code-builder";

export interface BuildFlexMessageOptions {
  llmBuilder?: FlexMessageLLMBuilder;
}

const mapActionFromToolResult = (
  actionHint: "create_work_order" | null,
  shouldOfferDispatch: boolean | null,
): FlexMessageAction | null => {
  if (actionHint === "create_work_order") {
    return "dispatch";
  }

  if (shouldOfferDispatch === true) {
    return "dispatch";
  }

  if (shouldOfferDispatch === false) {
    return "observe";
  }

  return null;
};

const extractConfidenceFromAnalysis = (
  analysisMarkdown: string,
): number | null => {
  const confidenceMatch = analysisMarkdown.match(
    /置信度[：:]\s*(\d+(?:\.\d+)?)\s*%?/u,
  );
  if (confidenceMatch) {
    const value = parseFloat(confidenceMatch[1]);
    if (value >= 0 && value <= 100) {
      return value / 100;
    }
    if (value > 1 && value <= 1) {
      return value;
    }
  }
  return null;
};

const extractAlarmLevelFromAnalysis = (
  analysisMarkdown: string,
): string | null => {
  const levelMatch = analysisMarkdown.match(
    /告警等级[：:]\s*(紧急|严重|一般|轻微|高|中|低)/u,
  );
  return levelMatch ? levelMatch[1] : null;
};

const buildCodeFlexMessage = (input: AlarmAnalysisInput): FlexMessage => {
  return buildAlarmAnalysisFlexMessage(input);
};

const buildLLMFlexMessage = async (
  input: AlarmAnalysisLLMInput,
  llmBuilder: FlexMessageLLMBuilder,
): Promise<FlexMessage | null> => {
  return llmBuilder.buildAlarmAnalysisFlexMessage(input);
};

export const buildAlarmAnalysisFlexMessageWithFallback = async (
  alarm: NormalizedAlarmRecord,
  analysisMarkdown: string,
  actionHint: "create_work_order" | null,
  shouldOfferDispatch: boolean | null,
  rawAnalysis?: string,
  options: BuildFlexMessageOptions = {},
): Promise<FlexMessage> => {
  const startedAt = Date.now();
  const builderType = config.flexMessageBuilder;
  const action = mapActionFromToolResult(actionHint, shouldOfferDispatch);
  const confidence = extractConfidenceFromAnalysis(analysisMarkdown);
  const alarmLevel = extractAlarmLevelFromAnalysis(analysisMarkdown);

  flexMessageLogger.debug("Building Flex Message", {
    builderType,
    deviceSn: alarm.device_sn,
    action,
    analysisLength: analysisMarkdown.length,
  });

  if (builderType === "llm") {
    const llmBuilder =
      options.llmBuilder ?? createFlexMessageLLMBuilder();

    const llmInput: AlarmAnalysisLLMInput = {
      alarm,
      analysisMarkdown,
      rawAnalysis,
    };

    try {
      const llmResult = await buildLLMFlexMessage(llmInput, llmBuilder);

      if (llmResult) {
        flexMessageLogger.debug("Flex Message built with LLM", {
          durationMs: Date.now() - startedAt,
        });
        return llmResult;
      }

      flexMessageLogger.warn(
        "LLM Flex Message build returned null, fallback to code builder",
        {
          durationMs: Date.now() - startedAt,
        },
      );
    } catch (error) {
      flexMessageLogger.warn(
        "LLM Flex Message build failed, fallback to code builder",
        {
          error: error instanceof Error ? error.message : "Unknown error",
          durationMs: Date.now() - startedAt,
        },
      );
    }
  }

  const codeInput: AlarmAnalysisInput = {
    alarm,
    analysisMarkdown,
    recommendedAction: action,
    confidence,
    alarmLevel,
  };

  const codeResult = buildCodeFlexMessage(codeInput);

  flexMessageLogger.debug("Flex Message built with code", {
    builderType: builderType === "llm" ? "llm-fallback" : "code",
    durationMs: Date.now() - startedAt,
  });

  return codeResult;
};

export {
  buildAlarmAnalysisFlexMessage,
  parseFlexMessageAction,
  createFlexMessageLLMBuilder,
  FlexMessageLLMBuilder,
};
