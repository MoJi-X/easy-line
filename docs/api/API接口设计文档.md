# API 接口设计文档

## 文档信息

| 项目名称 | LINE Bot 智能消息处理系统 |
|---------|-------------------------|
| 文档版本 | V3.0（Agent + 动态任务版） |
| 创建日期 | 2026-03-11 |
| 更新日期 | 2026-03-16 |
| 技术栈 | `@line/bot-sdk` + Express + LangChain Agent |
| 文档状态 | 待评审 |

---

## 1. 接口概述

### 1.1 设计原则

- `POST /webhook` 保持 LINE 回调约定，仅返回 `{ "status": "ok" }`
- 内部接口统一返回 JSON
- `/chat` 与 LINE 消息必须走同一 Agent 流程
- 内部任务管理接口只操作“当前用户自己的任务”

### 1.2 通用响应格式

**成功响应**

```json
{
  "code": "OK",
  "message": "ok",
  "data": {}
}
```

**错误响应**

```json
{
  "code": "INVALID_ARGUMENT",
  "message": "dailyTime must use HH:mm format.",
  "errors": [
    {
      "field": "dailyTime",
      "message": "Expected HH:mm."
    }
  ]
}
```

### 1.3 错误码定义

| 错误码 | 说明 |
|--------|------|
| `OK` | 成功 |
| `INVALID_ARGUMENT` | 参数错误 |
| `RESOURCE_NOT_FOUND` | 资源不存在 |
| `FORBIDDEN_TASK_ACCESS` | 无权操作当前任务 |
| `INVALID_LINE_SIGNATURE` | Webhook 签名校验失败 |
| `EXTERNAL_SERVICE_ERROR` | LLM、Tavily、天气 API 等外部服务错误 |
| `INTERNAL_ERROR` | 服务内部错误 |

---

## 2. Webhook 接口

### 2.1 LINE Webhook 回调

| 项目 | 说明 |
|------|------|
| URL | `POST /webhook` |
| 认证 | `X-Line-Signature` 签名校验 |
| 来源 | LINE 服务器 |
| 处理方式 | 快速确认后异步进入 Agent 链路 |

**响应**

```json
{
  "status": "ok"
}
```

### 2.2 文本消息处理约束

- 仅文本消息进入 Agent 业务处理。
- 当前用户由 `event.source.userId` 决定。
- Slash Command 与自然语言都通过 Agent 统一解析。
- 非文本消息直接跳过，不返回业务错误。

---

## 3. Agent 调试接口

### 3.1 `POST /chat`

用于在不依赖 LINE Webhook 的情况下验证同一 Agent 流程。

**请求体**

```json
{
  "userId": "U1234567890",
  "message": "每天早上 8 点给我推送北京天气"
}
```

**成功响应**

```json
{
  "code": "OK",
  "message": "ok",
  "data": {
    "userId": "U1234567890",
    "message": "每天早上 8 点给我推送北京天气",
    "reply": "好的，我已经为你创建了每天 08:00 推送北京天气的任务。",
    "usedTools": [
      "task.create"
    ]
  }
}
```

**行为要求**

- 与 LINE 文本消息共用同一 Agent 入口
- 支持自然语言任务管理
- 支持 Slash Command 测试
- 支持 Tavily 搜索自动决策

---

## 4. 任务管理接口

### 4.1 任务对象

```json
{
  "id": "weather-001",
  "type": "daily_weather",
  "name": "北京天气提醒",
  "ownerUserId": "U1234567890",
  "city": "北京",
  "dailyTime": "08:00",
  "enabled": true,
  "source": "natural_language",
  "createdAt": "2026-03-16T08:00:00.000Z",
  "updatedAt": "2026-03-16T08:00:00.000Z"
}
```

### 4.2 `GET /api/tasks`

查询当前用户任务。

**查询参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `userId` | string | 是 | 当前用户 ID |

**示例**

`GET /api/tasks?userId=U1234567890`

**成功响应**

```json
{
  "code": "OK",
  "message": "ok",
  "data": {
    "tasks": [
      {
        "id": "weather-001",
        "type": "daily_weather",
        "name": "北京天气提醒",
        "ownerUserId": "U1234567890",
        "city": "北京",
        "dailyTime": "08:00",
        "enabled": true,
        "source": "natural_language",
        "createdAt": "2026-03-16T08:00:00.000Z",
        "updatedAt": "2026-03-16T08:00:00.000Z"
      }
    ],
    "recentExecutions": []
  }
}
```

### 4.3 `POST /api/tasks`

创建当前用户任务。

**请求体**

```json
{
  "userId": "U1234567890",
  "city": "北京",
  "dailyTime": "08:00",
  "enabled": true,
  "source": "api"
}
```

**约束**

- `type` 固定为 `daily_weather`
- `dailyTime` 使用 `HH:mm`
- `ownerUserId` 由 `userId` 推导
- 不支持自定义 Cron 或自定义推送目标

### 4.4 `PATCH /api/tasks/:taskId`

更新当前用户任务。

**请求体**

```json
{
  "userId": "U1234567890",
  "city": "上海",
  "dailyTime": "09:00",
  "enabled": true
}
```

**约束**

- 仅允许更新 `city`、`dailyTime`、`enabled`
- 若任务不属于当前 `userId`，返回 `FORBIDDEN_TASK_ACCESS`

### 4.5 `DELETE /api/tasks/:taskId`

删除当前用户任务。

**查询参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `userId` | string | 是 | 当前用户 ID |

**示例**

`DELETE /api/tasks/weather-001?userId=U1234567890`

**成功响应**

```json
{
  "code": "OK",
  "message": "ok",
  "data": {
    "taskId": "weather-001",
    "deleted": true
  }
}
```

### 4.6 `POST /api/tasks/:taskId/execute`

手动执行任务，用于调试和演示。

**请求体**

```json
{
  "userId": "U1234567890"
}
```

**成功响应**

```json
{
  "code": "OK",
  "message": "ok",
  "data": {
    "taskId": "weather-001",
    "message": "Task executed successfully."
  }
}
```

---

## 5. Slash Command 语义

这些命令由 Agent 在消息链路中解析，不直接作为 HTTP 管理接口。

| 命令 | 示例 | 说明 |
|------|------|------|
| `/task list` | `/task list` | 列出当前用户所有任务 |
| `/task create` | `/task create city=北京 time=08:00 enabled=true` | 创建任务 |
| `/task update` | `/task update taskId=weather-001 time=09:00` | 更新任务 |
| `/task delete` | `/task delete taskId=weather-001` | 删除任务 |

缺少必要参数时，Agent 返回命令用法说明，不直接写入任务。

---

## 6. 健康检查接口

### 6.1 `GET /health`

**成功响应**

```json
{
  "code": "OK",
  "message": "ok",
  "data": {
    "status": "ok",
    "timestamp": "2026-03-16T10:00:00.000Z",
    "services": {
      "agent": "ready",
      "scheduler": "running",
      "taskCount": 3
    }
  }
}
```

---

## 7. 外部依赖接口约束

### 7.1 LLM

- 通过 LangChain Agent 调用 OpenAI-compatible 模型
- 使用 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL` 配置

### 7.2 Tavily

- 使用 `TAVILY_API_KEY`
- 仅用于实时外部信息查询

### 7.3 天气 API

- 请求必须设置超时
- 输入至少包含城市或可映射到城市的查询参数
- 响应转换为文本消息时，不直接暴露原始敏感返回头

---

## 8. 修订历史

| 版本 | 日期 | 修订内容 |
|------|------|---------|
| V1.0 | 2026-03-11 | 初始版本 |
| V2.0 | 2026-03-12 | 精简为 Demo 版本 |
| V3.0 | 2026-03-16 | 新增 Agent 调试、动态任务 CRUD 与 Slash Command 语义 |

---

**文档评审意见：**

| 评审人 | 评审日期 | 评审意见 | 状态 |
|--------|---------|---------|------|
|        |         |         | 待评审 |
