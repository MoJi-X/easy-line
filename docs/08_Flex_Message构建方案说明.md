# Flex Message 构建方案说明

## 1. 概述

在告警分析场景中，需要将 SSE 流式分析结果转换为 LINE Flex Message 格式展示给用户。为了兼顾稳定性与灵活性，系统实现了两种构建方式：

- **代码构建（code）**：通过预定义的代码逻辑构建 Flex Message
- **LLM 构建（llm）**：通过大语言模型智能解析并生成 Flex Message

两种方式通过配置开关控制，可随时切换。

---

## 2. 方案对比

### 2.1 代码构建方式

**工作原理：**
```
SSE 原始数据 → 解析提取关键字段 → 代码模板渲染 → Flex Message JSON
```

**优点：**
- ⚡ **响应快速**：无额外 LLM 调用，毫秒级响应
- 💰 **成本低**：不消耗 LLM Token
- 🎯 **结果稳定**：输出格式完全可控
- 🔒 **可靠性高**：不依赖 LLM 输出质量

**缺点：**
- 🔧 **灵活性低**：SSE 格式变化需要修改代码
- 📝 **样式调整**：需要修改代码并重新部署
- 🔄 **适应性差**：无法处理未预期的数据格式

**适用场景：**
- 生产环境稳定运行
- SSE 格式固定不变
- 对响应速度有要求
- 成本敏感场景

---

### 2.2 LLM 构建方式

**工作原理：**
```
SSE 原始数据 + 提示词 → LLM 处理 → Flex Message JSON
```

**优点：**
- 🔄 **灵活性高**：可适应各种 SSE 格式变化
- 🎨 **样式可调**：通过修改提示词调整输出样式
- 📝 **智能提取**：自动识别和提取关键信息
- 🛠️ **维护简单**：无需修改代码即可调整输出

**缺点：**
- ⏱️ **响应较慢**：额外 LLM 调用增加 1-3 秒延迟
- 💸 **成本增加**：每次调用消耗 LLM Token
- ⚠️ **输出不稳定**：LLM 输出可能偶尔不符合预期
- 🔍 **调试困难**：问题排查需要分析 LLM 输出

**适用场景：**
- Demo 演示环境
- SSE 格式频繁变化
- 需要快速迭代样式
- 对延迟不敏感场景

---

## 3. 配置说明

### 3.1 环境变量配置

在 `.env` 文件中设置：

```bash
# Flex Message 构建方式
# code: 使用代码构建（默认，快速稳定）
# llm: 使用大模型构建（更灵活，适应性强）
FLEX_MESSAGE_BUILDER=code
```

### 3.2 配置项说明

| 配置值 | 说明 | 推荐场景 |
|--------|------|---------|
| `code` | 代码构建 | 生产环境、稳定运行 |
| `llm` | LLM 构建 | Demo 环境、快速迭代 |

### 3.3 默认值

如果未配置，默认使用 `code` 方式。

---

## 4. 技术实现

### 4.1 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    analyze_alarm Tool                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   SSE Response                                              │
│       │                                                     │
│       ▼                                                     │
│   ┌─────────────┐                                          │
│   │ 解析 SSE    │                                          │
│   │ 提取决策结果│                                          │
│   └──────┬──────┘                                          │
│          │                                                  │
│          ▼                                                  │
│   ┌─────────────────────────────────────┐                  │
│   │     flexMessageBuilder 配置判断     │                  │
│   └──────────────┬──────────────────────┘                  │
│                  │                                          │
│         ┌───────┴───────┐                                  │
│         │               │                                  │
│    'code'           'llm'                                  │
│         │               │                                  │
│         ▼               ▼                                  │
│   ┌───────────┐   ┌───────────────┐                       │
│   │ Code      │   │ LLM Builder   │                       │
│   │ Builder   │   │               │                       │
│   └─────┬─────┘   └───────┬───────┘                       │
│         │                 │                                │
│         │            ┌────┴────┐                          │
│         │            │ 成功？  │                          │
│         │            └────┬────┘                          │
│         │           是/   │   \否                         │
│         │              │      │                            │
│         │              ▼      ▼                            │
│         │         返回结果  降级到 Code Builder            │
│         │                     │                            │
│         └─────────────────────┘                            │
│                       │                                     │
│                       ▼                                     │
│              Flex Message JSON                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 核心代码

**配置读取（config/index.ts）：**

```typescript
function getAlarmConfig(): AlarmConfig {
  return {
    // ... 其他配置
    flexMessageBuilder: (process.env.FLEX_MESSAGE_BUILDER as 'code' | 'llm') || 'code',
  };
}
```

**构建逻辑（alarm.tools.ts）：**

```typescript
let flexMessage;
if (alarmConfig.flexMessageBuilder === 'llm') {
  // 尝试 LLM 构建
  flexMessage = await flexMessageLLMBuilder.buildAlarmAnalysisFlexMessage(
    alarm, 
    decisionResults, 
    result.rawText
  );
  
  // LLM 构建失败，降级到代码构建
  if (!flexMessage) {
    flexMessage = buildAlarmAnalysisFlexMessage(alarm, decisionResults, result.rawText);
    logger.warn('ALARM', 'LLM Flex Message build failed, fallback to code builder');
  }
} else {
  // 代码构建
  flexMessage = buildAlarmAnalysisFlexMessage(alarm, decisionResults, result.rawText);
}
```

### 4.3 降级策略

当选择 `llm` 模式时，如果 LLM 构建失败（返回 null 或解析错误），系统会自动降级到代码构建，确保用户始终能收到 Flex Message。

降级触发条件：
- LLM API 调用超时
- LLM 返回内容无法解析为 JSON
- LLM 返回的 JSON 不符合 Flex Message 结构
- LLM 服务不可用

---

## 5. LLM 构建器实现

### 5.1 提示词设计

**核心提示词结构：**

```
你是一个"LINE Flex Message 告警卡片生成助手"。

## 目标
将告警研判结果转换成可直接发送给 LINE Bot 的 Flex Message。

## 输出要求
1. 只输出 JSON
2. 不要输出 Markdown
3. 不要输出代码块
4. JSON 必须符合 LINE Flex Message 结构
...

## 提取内容
- 研判状态
- 告警总数
- 设备名称
- 告警类型
- 最终建议动作
- 告警等级
- 置信度
- 研判理由
...

## 卡片结构要求
- header：显示标题
- body：显示核心字段
- footer：可选按钮
```

### 5.2 输出处理

```typescript
async buildAlarmAnalysisFlexMessage(
  alarm: AlarmInfo,
  decisionResults: DecisionResult[],
  rawAnalysis: string
): Promise<any> {
  const response = await this.model.invoke(prompt);
  const content = response.content as string;
  
  // 清理可能的 Markdown 代码块标记
  let jsonStr = content.trim();
  if (jsonStr.startsWith('```json')) {
    jsonStr = jsonStr.slice(7);
  }
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.slice(3);
  }
  if (jsonStr.endsWith('```')) {
    jsonStr = jsonStr.slice(0, -3);
  }
  
  return JSON.parse(jsonStr.trim());
}
```

---

## 6. 代码构建器实现

### 6.1 模板结构

```typescript
export function buildAlarmAnalysisFlexMessage(
  alarm: AlarmInfo,
  decisionResults: DecisionResult[],
  rawAnalysis?: string
): FlexMessage {
  const decision = decisionResults[0];
  
  return {
    type: 'flex',
    altText: `设备 ${deviceName} 告警研判结果：${getActionText(decision.action)}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '告警研判结果', weight: 'bold', size: 'lg' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          // 告警对象信息
          // 研判结论
          // 研判理由
        ]
      }
    }
  };
}
```

### 6.2 样式映射

```typescript
function getActionColor(action: string): string {
  switch (action) {
    case 'dispatch': return '#FF6B6B';  // 红色 - 派单
    case 'observe': return '#4ECDC4';   // 青色 - 观察
    case 'close': return '#95E1D3';     // 绿色 - 关闭
    case 'ignore': return '#A0A0A0';    // 灰色 - 忽略
    default: return '#666666';
  }
}

function getActionText(action: string): string {
  switch (action) {
    case 'dispatch': return '派单处理';
    case 'observe': return '持续观察';
    case 'close': return '关闭告警';
    case 'ignore': return '忽略告警';
    default: return action;
  }
}
```

---

## 7. 测试与验证

### 7.1 切换测试

```bash
# 测试代码构建
FLEX_MESSAGE_BUILDER=code npm run dev

# 测试 LLM 构建
FLEX_MESSAGE_BUILDER=llm npm run dev
```

### 7.2 日志观察

开启 debug 日志：

```bash
LOG_LEVEL=debug
```

观察日志输出：

```
# 代码构建
[DEBUG] [ALARM] [analyze_alarm] Building Flex Message with code

# LLM 构建
[DEBUG] [ALARM] [analyze_alarm] Building Flex Message with LLM

# LLM 构建失败降级
[WARN] [ALARM] [analyze_alarm] LLM Flex Message build failed, fallback to code builder
```

### 7.3 验证清单

| 检查项 | 代码构建 | LLM 构建 |
|--------|---------|---------|
| Flex Message 格式正确 | ✅ | ✅ |
| 关键信息完整 | ✅ | ✅ |
| 样式显示正常 | ✅ | ✅ |
| 响应时间 < 3s | ✅ | ⚠️ |
| 降级机制生效 | N/A | ✅ |

---

## 8. 最佳实践

### 8.1 环境选择

| 环境 | 推荐配置 | 原因 |
|------|---------|------|
| 开发环境 | `llm` | 快速迭代，方便调试 |
| 测试环境 | `llm` 或 `code` | 根据测试目的选择 |
| Demo 环境 | `llm` | 展示效果更好 |
| 生产环境 | `code` | 稳定可靠 |

### 8.2 监控建议

1. **监控 LLM 构建成功率**：记录降级次数
2. **监控响应时间**：对比两种方式的延迟
3. **监控 Token 消耗**：评估 LLM 成本

### 8.3 故障排查

**问题：LLM 构建总是失败**

检查项：
1. LLM API 是否可用
2. API Key 是否正确
3. 模型是否支持 JSON 输出
4. 提示词是否过长

**问题：Flex Message 显示异常**

检查项：
1. JSON 格式是否正确
2. LINE Flex Message 规范是否满足
3. 字段值是否超出限制

---

## 9. 扩展开发

### 9.1 添加新的构建方式

1. 在 `AlarmConfig` 中添加新类型：

```typescript
flexMessageBuilder: 'code' | 'llm' | 'hybrid';
```

2. 实现新的构建器：

```typescript
// src/services/flex-message-hybrid.service.ts
export class FlexMessageHybridBuilder {
  async buildAlarmAnalysisFlexMessage(...): Promise<any> {
    // 混合策略实现
  }
}
```

3. 在 Tool 中添加判断逻辑：

```typescript
if (alarmConfig.flexMessageBuilder === 'hybrid') {
  flexMessage = await flexMessageHybridBuilder.buildAlarmAnalysisFlexMessage(...);
}
```