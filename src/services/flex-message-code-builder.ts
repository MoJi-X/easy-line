import type { NormalizedAlarmRecord } from "../tools/alarm-tools";

export type FlexMessageAction = "dispatch" | "observe" | "close" | "ignore";

export interface FlexMessage {
  type: "flex";
  altText: string;
  contents: FlexBubble;
}

export interface FlexBubble {
  type: "bubble";
  header?: FlexBox;
  body?: FlexBox;
  footer?: FlexBox;
  styles?: FlexBubbleStyles;
}

export interface FlexBubbleStyles {
  header?: FlexBlockStyle;
  body?: FlexBlockStyle;
  footer?: FlexBlockStyle;
}

export interface FlexBlockStyle {
  backgroundColor?: string;
}

export interface FlexBox {
  type: "box";
  layout: "vertical" | "horizontal" | "baseline";
  contents: FlexComponent[];
  spacing?: string;
  paddingAll?: string;
  backgroundColor?: string;
  cornerRadius?: string;
  margin?: string;
}

export type FlexComponent = FlexText | FlexBox | FlexSeparator | FlexImage;

export interface FlexText {
  type: "text";
  text: string;
  weight?: "regular" | "bold";
  size?: string;
  color?: string;
  wrap?: boolean;
  maxLines?: number;
  flex?: number;
  align?: "start" | "center" | "end";
  margin?: string;
}

export interface FlexSeparator {
  type: "separator";
  margin?: string;
  color?: string;
}

export interface FlexImage {
  type: "image";
  url: string;
  size?: string;
  aspectRatio?: string;
  aspectMode?: "cover" | "fit";
  flex?: number;
}

export interface AlarmAnalysisInput {
  alarm: NormalizedAlarmRecord;
  analysisMarkdown: string;
  recommendedAction: FlexMessageAction | null;
  confidence?: number | null;
  alarmLevel?: string | null;
}

const ACTION_COLORS: Record<FlexMessageAction, string> = {
  dispatch: "#FF6B6B",
  observe: "#4ECDC4",
  close: "#95E1D3",
  ignore: "#A0A0A0",
};

const ACTION_TEXTS: Record<FlexMessageAction, string> = {
  dispatch: "派单处理",
  observe: "持续观察",
  close: "关闭告警",
  ignore: "忽略告警",
};

const ACTION_BACKGROUNDS: Record<FlexMessageAction, string> = {
  dispatch: "#FFF0F0",
  observe: "#E8FAF8",
  close: "#E8FDF5",
  ignore: "#F5F5F5",
};

const getActionColor = (action: FlexMessageAction): string => {
  return ACTION_COLORS[action];
};

const getActionText = (action: FlexMessageAction): string => {
  return ACTION_TEXTS[action];
};

const getActionBackground = (action: FlexMessageAction): string => {
  return ACTION_BACKGROUNDS[action];
};

const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + "...";
};

const formatFieldValue = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined || value === "") {
    return "未知";
  }
  return String(value);
};

const formatConfidence = (confidence: number | null | undefined): string => {
  if (confidence === null || confidence === undefined) {
    return "未知";
  }
  return `${Math.round(confidence * 100)}%`;
};

const buildFieldRow = (label: string, value: string, valueColor?: string): FlexBox => {
  return {
    type: "box",
    layout: "horizontal",
    contents: [
      {
        type: "text",
        text: label,
        size: "sm",
        color: "#666666",
        flex: 2,
      },
      {
        type: "text",
        text: value,
        size: "sm",
        color: valueColor ?? "#333333",
        flex: 3,
        wrap: true,
      },
    ],
    spacing: "md",
  };
};

const buildHeader = (action: FlexMessageAction | null): FlexBox => {
  const displayAction = action ?? "observe";
  const actionText = getActionText(displayAction);
  const actionColor = getActionColor(displayAction);

  return {
    type: "box",
    layout: "vertical",
    contents: [
      {
        type: "text",
        text: "告警研判结果",
        weight: "bold",
        size: "lg",
        color: "#FFFFFF",
      },
      {
        type: "text",
        text: actionText,
        weight: "bold",
        size: "md",
        color: actionColor,
        margin: "sm",
      },
    ],
    paddingAll: "lg",
    backgroundColor: "#1E3A5F",
    cornerRadius: "md",
  };
};

const buildAlarmInfoSection = (alarm: NormalizedAlarmRecord): FlexBox => {
  return {
    type: "box",
    layout: "vertical",
    contents: [
      {
        type: "text",
        text: "告警对象",
        weight: "bold",
        size: "md",
        color: "#1E3A5F",
        margin: "md",
      },
      {
        type: "separator",
        margin: "sm",
        color: "#E0E0E0",
      },
      {
        type: "box",
        layout: "vertical",
        contents: [
          buildFieldRow("设备SN", formatFieldValue(alarm.device_sn)),
          buildFieldRow("站点", formatFieldValue(alarm.site_name)),
          buildFieldRow("告警代码", formatFieldValue(alarm.alarm_code)),
          buildFieldRow("处理状态", formatFieldValue(alarm.processing_status)),
          buildFieldRow("发生时间", formatFieldValue(alarm.created_at)),
        ],
        spacing: "sm",
        margin: "md",
      },
    ],
  };
};

const buildAnalysisSection = (
  analysisMarkdown: string,
  confidence: number | null | undefined,
  alarmLevel: string | null | undefined,
): FlexBox => {
  const truncatedAnalysis = truncateText(analysisMarkdown, 500);

  const contents: FlexComponent[] = [
    {
      type: "text",
      text: "研判结论",
      weight: "bold",
      size: "md",
      color: "#1E3A5F",
      margin: "md",
    },
    {
      type: "separator",
      margin: "sm",
      color: "#E0E0E0",
    },
  ];

  if (confidence !== null && confidence !== undefined) {
    contents.push({
      type: "box",
      layout: "vertical",
      contents: [
        buildFieldRow("置信度", formatConfidence(confidence)),
        buildFieldRow("告警等级", formatFieldValue(alarmLevel)),
      ],
      spacing: "sm",
      margin: "md",
    });
  }

  contents.push({
    type: "box",
    layout: "vertical",
    contents: [
      {
        type: "text",
        text: "研判理由",
        size: "sm",
        color: "#666666",
        margin: "sm",
      },
      {
        type: "text",
        text: truncatedAnalysis,
        size: "sm",
        color: "#333333",
        wrap: true,
        maxLines: 8,
      },
    ],
    margin: "md",
  });

  return {
    type: "box",
    layout: "vertical",
    contents,
  };
};

const buildActionBadge = (action: FlexMessageAction): FlexBox => {
  const actionText = getActionText(action);
  const actionColor = getActionColor(action);
  const actionBackground = getActionBackground(action);

  return {
    type: "box",
    layout: "horizontal",
    contents: [
      {
        type: "text",
        text: actionText,
        weight: "bold",
        size: "md",
        color: actionColor,
        align: "center",
      },
    ],
    paddingAll: "md",
    backgroundColor: actionBackground,
    cornerRadius: "md",
    margin: "md",
  };
};

const buildFooter = (action: FlexMessageAction | null): FlexBox | undefined => {
  if (!action) {
    return undefined;
  }

  return {
    type: "box",
    layout: "vertical",
    contents: [buildActionBadge(action)],
    paddingAll: "md",
  };
};

export const buildAlarmAnalysisFlexMessage = (
  input: AlarmAnalysisInput,
): FlexMessage => {
  const { alarm, analysisMarkdown, recommendedAction, confidence, alarmLevel } = input;
  const action = recommendedAction ?? "observe";
  const actionText = getActionText(action);
  const deviceName = formatFieldValue(alarm.device_sn);

  const bubble: FlexBubble = {
    type: "bubble",
    header: buildHeader(action),
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        buildAlarmInfoSection(alarm),
        buildAnalysisSection(analysisMarkdown, confidence, alarmLevel),
      ],
      spacing: "lg",
      paddingAll: "lg",
    },
    footer: buildFooter(action),
    styles: {
      header: {
        backgroundColor: "#1E3A5F",
      },
    },
  };

  return {
    type: "flex",
    altText: `设备 ${deviceName} 告警研判结果：${actionText}`,
    contents: bubble,
  };
};

export const isValidFlexMessageAction = (value: string): value is FlexMessageAction => {
  return value === "dispatch" || value === "observe" || value === "close" || value === "ignore";
};

export const parseFlexMessageAction = (
  value: string | null | undefined,
): FlexMessageAction | null => {
  if (!value) {
    return null;
  }

  const normalizedValue = value.toLowerCase().trim();

  if (normalizedValue === "dispatch" || normalizedValue === "派单" || normalizedValue === "建单") {
    return "dispatch";
  }

  if (normalizedValue === "observe" || normalizedValue === "观察" || normalizedValue === "持续观察") {
    return "observe";
  }

  if (normalizedValue === "close" || normalizedValue === "关闭" || normalizedValue === "关闭告警") {
    return "close";
  }

  if (normalizedValue === "ignore" || normalizedValue === "忽略" || normalizedValue === "忽略告警") {
    return "ignore";
  }

  return null;
};
