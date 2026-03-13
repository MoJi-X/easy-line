# LINE 消息链路开发规格

## 目标与边界
- 目标：以最小可运行链路完成 Express 启动、LINE Webhook 接收、文本消息解析和回复。
- 范围内：`src/index.ts`、`src/config/index.ts`、`src/routes/webhook.ts`、`src/services/line.ts`、基础 `/health`。
- 范围外：复杂会话状态、定时任务、正式管理后台、完整安全体系。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/需求规格说明书.md` | 3.1、5.1.1、6.1、7、8.1、9.1-9.3 | 权威功能需求、技术选型、项目结构、验收标准、环境配置 |
| `docs/architecture/系统架构设计文档.md` | 3.1、4.1、5.1、6.3、7.1 | `LineService` 职责、Webhook 路由设计、环境配置 |
| `docs/api/API接口设计文档.md` | 1.3、2.1、2.2、3.1、6.1、7.1 | Webhook、事件处理、回复消息、健康检查、入口实现 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| 环境变量加载 | hard | Webhook、LINE SDK、OpenAI 配置都依赖统一配置入口 |
| `@line/bot-sdk` | hard | 负责签名校验、Reply/Push/Multicast |
| `specs/20-llm-context.spec.md` | soft | 智能回复依赖 LLM；未接入前允许使用固定 fallback 保证链路跑通 |
| `specs/30-scheduler-push.spec.md` | downstream | Scheduler 复用 `LineService` 的主动推送能力 |

## 任务拆分
### LINE-001 应用入口与配置装配
- goal：创建可启动的 Express 入口和统一配置加载。
- inputs：需求文档 6.1、7、9.1；架构文档 7.1；API 文档 8.3。
- outputs：`src/index.ts`、`src/config/index.ts`、`.env.example`。
- dependencies：无。
- implementation notes：环境变量名称以需求文档为准，使用 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`、`PORT`；缺少关键 LINE 配置时快速失败，LLM 配置可选且在提供时执行格式校验。
- acceptance criteria：应用可在本地启动；`GET /health` 返回 200；关键环境变量缺失时能明确报错。

### LINE-002 LINE SDK 封装与 Webhook 路由
- goal：封装 `LineService` 并接入 `POST /webhook`。
- inputs：需求文档 3.1.2、5.1.1；架构文档 4.1、5.1、6.3；API 文档 2.1。
- outputs：`src/services/line.ts`、`src/routes/webhook.ts`。
- dependencies：LINE-001。
- implementation notes：使用 `middleware()` 进行签名校验；统一封装 `replyMessage`、`pushMessage`、`multicast`；非文本事件直接跳过，不返回业务错误。
- acceptance criteria：Webhook 路由可接收 LINE 回调；签名校验已经连通；事件处理采用批量并发处理但不会导致服务崩溃。

### LINE-003 文本消息解析与回复链路
- goal：完成文本事件解析、`userId`/`replyToken` 提取和消息回复。
- inputs：需求文档 3.1.2、8.1；架构文档 3.1；API 文档 2.2、3.1。
- outputs：文本消息处理函数、默认回复策略、错误兜底日志。
- dependencies：LINE-002；对 `specs/20-llm-context.spec.md` 为软依赖。
- implementation notes：先保证文本消息能回复；LLM 未接入时可先回固定文本；接入 LLM 后保持同一调用入口，避免二次改造 Webhook 主链路。
- acceptance criteria：文本消息能收到回复；异常消息不会让服务退出；正常演示情况下响应时间满足需求文档 `< 10 秒` 目标。

## 验收与测试
- 单元验证：配置解析、`LineService` 包装函数、文本事件过滤逻辑。
- 集成验证：本地 Express + ngrok + LINE Developers Webhook 联调。
- 演示验收：Webhook 可访问、消息可接收、消息可回复、异常路径可恢复。

## 风险与回退
- 风险：环境变量命名在参考文档中存在不一致，若按错命名会导致启动失败。
- 风险：Webhook URL 或签名校验错误会直接阻断聊天链路。
- 回退：若 LLM 接入阻塞，先保留固定回复或 Echo 回复，确保 LINE 基础链路可演示。
