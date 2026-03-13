# API接口设计文档

## 文档信息

| 项目名称 | LINE Bot 智能消息处理系统 |
|---------|-------------------------|
| 文档版本 | V2.0 (Demo版) |
| 创建日期 | 2026-03-11 |
| 更新日期 | 2026-03-12 |
| 技术栈 | @line/bot-sdk + Express |
| 文档状态 | 待评审 |

---

## 1. 接口概述

### 1.1 接口规范

| 项目 | 规范 |
|------|------|
| 协议 | HTTPS |
| 数据格式 | JSON |
| 字符编码 | UTF-8 |
| 时间格式 | ISO 8601 (YYYY-MM-DDTHH:mm:ss.sssZ) |
| LINE SDK | @line/bot-sdk v7.x |
| Web框架 | Express v4.x |

### 1.2 基础URL

```
生产环境: https://your-domain.com
测试环境: http://localhost:3000 (配合ngrok)
```

### 1.3 LINE Messaging API 基础

本项目使用 LINE 官方 SDK `@line/bot-sdk` 进行开发，主要涉及以下 API：

| API | 用途 | SDK方法 |
|-----|------|---------|
| Webhook | 接收用户消息事件 | middleware + webhook handler |
| Reply Message | 回复用户消息 | `client.replyMessage()` |
| Push Message | 主动推送消息 | `client.pushMessage()` |
| Multicast | 批量推送消息 | `client.multicast()` |

### 1.4 通用响应格式

**成功响应：**
```json
{
  "code": 0,
  "message": "success",
  "data": { ... }
}
```

**错误响应：**
```json
{
  "code": 1001,
  "message": "参数错误",
  "errors": [
    {
      "field": "task_name",
      "message": "任务名称不能为空"
    }
  ]
}
```

### 1.5 错误码定义

| 错误码 | 说明 |
|--------|------|
| 0 | 成功 |
| 1001 | 参数错误 |
| 1002 | 资源不存在 |
| 2001 | 签名验证失败 |
| 3001 | 服务内部错误 |
| 3002 | 第三方服务错误 |

---

## 2. Webhook接口

### 2.1 LINE Webhook回调

接收LINE服务器推送的消息事件，使用 `@line/bot-sdk` 的中间件进行签名验证。

**请求信息：**

| 项目 | 说明 |
|------|------|
| URL | `POST /webhook` |
| 认证 | X-Line-Signature 签名验证 |
| 来源 | LINE服务器 |
| SDK | `middleware()` 自动验证签名 |

**Express 路由配置：**

```typescript
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

const app = express();

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!
};

const client = new Client(config);

app.post('/webhook', middleware(config), async (req, res) => {
  const events = req.body.events;
  
  try {
    await Promise.all(events.map(event => handleEvent(event)));
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ status: 'error' });
  }
});
```

**请求头：**

| Header | 类型 | 必填 | 说明 |
|--------|------|------|------|
| X-Line-Signature | string | 是 | 请求签名（SDK自动验证） |
| Content-Type | string | 是 | application/json |

**请求体（Webhook Event）：**
```json
{
  "destination": "U1234567890abcdef",
  "events": [
    {
      "type": "message",
      "replyToken": "nHuyWiB7yP5Zw52FIkcQobQuGDXCTA",
      "timestamp": 1462629479859,
      "source": {
        "type": "user",
        "userId": "U4af4980629..."
      },
      "message": {
        "id": "325708",
        "type": "text",
        "text": "今天天气怎么样"
      }
    }
  ]
}
```

**响应：**
```json
{
  "status": "ok"
}
```

### 2.2 消息事件处理

**事件类型：**

| 事件类型 | 说明 | SDK类型 |
|---------|------|---------|
| message | 消息事件 | MessageEvent |
| follow | 关注事件 | FollowEvent |
| unfollow | 取消关注 | UnfollowEvent |
| join | 加入群组 | JoinEvent |
| leave | 离开群组 | LeaveEvent |

**消息处理器实现：**

```typescript
import { 
  WebhookEvent, 
  MessageEvent, 
  TextMessage,
  Client 
} from '@line/bot-sdk';

async function handleEvent(event: WebhookEvent): Promise<void> {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const messageEvent = event as MessageEvent;
  const userMessage = messageEvent.message.text;
  const userId = messageEvent.source.userId;
  const replyToken = messageEvent.replyToken;

  const replyText = await generateReply(userId, userMessage);

  await client.replyMessage(replyToken, {
    type: 'text',
    text: replyText
  } as TextMessage);
}
```

---

## 3. 消息回复接口

### 3.1 Reply Message（回复消息）

使用 `replyToken` 回复用户消息，replyToken 有效期为30秒。

**SDK调用：**

```typescript
await client.replyMessage(replyToken, messages);
```

**消息类型：**

| 类型 | 说明 | 用途 |
|------|------|------|
| text | 文本消息 | 普通文本回复 |
| flex | Flex消息 | 富媒体消息 |
| image | 图片消息 | 图片展示 |
| sticker | 表情消息 | LINE表情 |

**文本消息示例：**

```typescript
const textMessage: TextMessage = {
  type: 'text',
  text: '你好！有什么可以帮助你的吗？'
};

await client.replyMessage(replyToken, textMessage);
```

**多消息回复示例：**

```typescript
await client.replyMessage(replyToken, [
  { type: 'text', text: '收到你的消息了！' },
  { type: 'text', text: '正在处理中...' }
]);
```

### 3.2 Push Message（主动推送）

主动向用户推送消息，无需用户先发送消息。

**SDK调用：**

```typescript
await client.pushMessage(userId, messages);
```

**推送示例：**

```typescript
await client.pushMessage('U1234567890abcdef', {
  type: 'text',
  text: '这是一条主动推送的消息'
});
```

### 3.3 Multicast（批量推送）

向多个用户同时推送相同消息。

**SDK调用：**

```typescript
await client.multicast(userIds, messages);
```

**批量推送示例：**

```typescript
const userIds = ['U1234567890', 'U0987654321'];

await client.multicast(userIds, {
  type: 'text',
  text: '群发消息内容'
});
```

---

## 4. 定时任务接口

### 4.1 任务配置文件格式

Demo版本使用 JSON 文件配置定时任务，配合 `node-cron` 执行。

**配置文件：`config/tasks.json`**

```json
{
  "tasks": [
    {
      "id": "weather-push",
      "name": "每日天气推送",
      "enabled": true,
      "schedule": "0 8 * * *",
      "api": {
        "url": "https://api.weather.com/v1/current",
        "method": "GET",
        "headers": {
          "Authorization": "Bearer ${WEATHER_API_KEY}"
        }
      },
      "template": "今日天气: {weather}, 温度: {temp}°C",
      "targets": ["U1234567890"]
    }
  ]
}
```

### 4.2 定时任务服务实现

```typescript
import cron from 'node-cron';
import { Client } from '@line/bot-sdk';
import axios from 'axios';

interface TaskConfig {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  api: {
    url: string;
    method: string;
    headers?: Record<string, string>;
  };
  template: string;
  targets: string[];
}

export class SchedulerService {
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  
  constructor(private client: Client) {}

  loadTasks(config: { tasks: TaskConfig[] }): void {
    for (const task of config.tasks) {
      if (!task.enabled) continue;
      
      const scheduledTask = cron.schedule(task.schedule, () => {
        this.executeTask(task);
      });
      
      this.tasks.set(task.id, scheduledTask);
      console.log(`Task loaded: ${task.name}`);
    }
  }

  private async executeTask(task: TaskConfig): Promise<void> {
    try {
      const response = await axios({
        method: task.api.method,
        url: task.api.url,
        headers: task.api.headers
      });

      const message = this.renderTemplate(task.template, response.data);
      
      await this.client.multicast(task.targets, {
        type: 'text',
        text: message
      });
      
      console.log(`Task executed: ${task.name}`);
    } catch (error) {
      console.error(`Task failed: ${task.name}`, error);
    }
  }

  private renderTemplate(template: string, data: Record<string, any>): string {
    return template.replace(/\{(\w+)\}/g, (_, key) => data[key] ?? '');
  }
}
```

### 4.3 手动触发任务（管理接口）

**请求信息：**

| 项目 | 说明 |
|------|------|
| URL | `POST /api/tasks/{task_id}/execute` |
| 认证 | Bearer Token（Demo版简化） |

**响应：**
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "task_id": "weather-push",
    "status": "executed"
  }
}
```

---

## 5. LLM对话接口

### 5.1 LangChain集成

使用 LangChain 1.x 的 `@langchain/core` 与 `@langchain/openai` 实现与大模型的对话交互。

**服务实现：**

```typescript
import { ChatOpenAI } from '@langchain/openai';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { config } from '../config';

export class LLMService {
  private readonly model = new ChatOpenAI({
    model: config.llmModel,
    temperature: 0.7,
    apiKey: config.llmApiKey,
    configuration: config.llmBaseUrl
      ? { baseURL: config.llmBaseUrl }
      : undefined,
  });
  private readonly memories: Map<string, BaseMessage[]> = new Map();
  private readonly maxContextMessages = 6;

  async chat(userId: string, message: string): Promise<string> {
    const history = this.memories.get(userId) ?? [];
    const response = await this.model.invoke([
      ...history,
      new HumanMessage(message),
    ]);
    const reply =
      typeof response.content === 'string' ? response.content : '';
    const nextHistory = [
      ...history,
      new HumanMessage(message),
      new AIMessage(reply),
    ].slice(-this.maxContextMessages);

    this.memories.set(userId, nextHistory);
    return reply;
  }
}
```

### 5.2 上下文管理

| 参数 | 默认值 | 说明 |
|------|--------|------|
| context_max_length | 3 | 保留最近N条对话 |
| memory_type | `Map<string, BaseMessage[]>` | 内存存储 |

---

## 6. 健康检查接口

### 6.1 健康检查

**请求信息：**

| 项目 | 说明 |
|------|------|
| URL | `GET /health` |
| 认证 | 无 |

**Express实现：**

```typescript
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      line_api: 'connected',
      llm: 'ready'
    }
  });
});
```

**响应：**
```json
{
  "status": "healthy",
  "timestamp": "2026-03-12T10:00:00.000Z",
  "services": {
    "line_api": "connected",
    "llm": "ready"
  }
}
```

### 6.2 就绪检查

**请求信息：**

| 项目 | 说明 |
|------|------|
| URL | `GET /ready` |
| 认证 | 无 |

**响应：**
```json
{
  "ready": true,
  "timestamp": "2026-03-12T10:00:00.000Z"
}
```

---

## 7. 完整服务入口

### 7.1 主入口文件

```typescript
import express from 'express';
import { middleware, Client, WebhookEvent } from '@line/bot-sdk';
import { LLMService } from './services/llm';
import { SchedulerService } from './services/scheduler';
import taskConfig from './config/tasks.json';

const app = express();
const port = process.env.PORT || 3000;

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!
};

const client = new Client(lineConfig);
const llmService = new LLMService();
const schedulerService = new SchedulerService(client);

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.post('/webhook', middleware(lineConfig), async (req, res) => {
  try {
    const events: WebhookEvent[] = req.body.events;
    
    await Promise.all(events.map(async (event) => {
      if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId!;
        const userMessage = event.message.text;
        const replyToken = event.replyToken;
        
        const reply = await llmService.chat(userId, userMessage);
        
        await client.replyMessage(replyToken, {
          type: 'text',
          text: reply
        });
      }
    }));
    
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ status: 'error' });
  }
});

schedulerService.loadTasks(taskConfig);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
```

---

## 8. 附录

### 8.1 LINE消息类型速查

| 类型 | 结构 | 用途 |
|------|------|------|
| TextMessage | `{ type: 'text', text: string }` | 文本消息 |
| ImageMessage | `{ type: 'image', originalContentUrl, previewImageUrl }` | 图片消息 |
| FlexMessage | `{ type: 'flex', altText, contents }` | Flex消息 |

### 8.2 Cron表达式说明

| 表达式 | 说明 |
|--------|------|
| `0 8 * * *` | 每天8:00 |
| `0 9,18 * * *` | 每天9:00和18:00 |
| `*/30 * * * *` | 每30分钟 |
| `0 0 * * 1` | 每周一0:00 |

### 8.3 环境变量配置

```bash
# .env
PORT=3000

# LINE配置
LINE_CHANNEL_SECRET=your-channel-secret
LINE_CHANNEL_ACCESS_TOKEN=your-access-token

# OpenAI配置
OPENAI_API_KEY=your-openai-api-key
```

### 8.4 修订历史

| 版本 | 日期 | 修订内容 |
|------|------|---------|
| V1.0 | 2026-03-11 | 初始版本 |
| V2.0 | 2026-03-12 | 更新为 @line/bot-sdk + Express 技术栈，精简为Demo版本 |

---

**文档评审意见：**

| 评审人 | 评审日期 | 评审意见 | 状态 |
|--------|---------|---------|------|
|        |         |         | 待评审 |
