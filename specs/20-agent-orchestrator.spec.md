# Agent 编排与工具框架开发规格

## 目标与边界
- 目标：基于 LangChain `createAgent()` 建立统一 Agent 入口，承接 `/webhook` 与 `/chat` 的全部用户消息，并完成短期上下文、Tool Registry、Tavily 搜索与降级回复。
- 范围内：`src/services/agent.ts`、`src/routes/chat.ts`、`src/tools/index.ts`、`src/tools/tavily-search.ts`、Agent 上下文内存和统一消息处理接口。
- 范围外：任务 JSON 持久化、任务所有权校验、天气调度执行。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/需求规格说明书.md` | 3.1、3.2、3.5、4.1、5.2、6.1、8.1、8.2 | Agent、工具、上下文、`/chat` 一致性与验收标准 |
| `docs/architecture/系统架构设计文档.md` | 3.1、4.1、4.2、4.5、5.1、5.5 | Agent Orchestrator、Tool Registry、Tavily 流程 |
| `docs/api/API接口设计文档.md` | 1.2、1.3、3.1、5、7 | `/chat` 返回结构、错误码、Slash Command 语义、外部依赖 |
| `docs/architecture/数据库设计文档.md` | 1.1、2.1、6.1 | 上下文内存存储基线 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| `specs/10-line-message.spec.md` | hard | Agent 最终通过 Webhook 消息桥接和 `/chat` 路由触发 |
| `langchain` | hard | 使用官方 `createAgent()` 统一入口 |
| `@langchain/openai` | hard | 提供 OpenAI-compatible 模型接入 |
| `@langchain/tavily` | hard | 提供实时搜索工具 |
| `specs/30-task-crud-persistence.spec.md` | soft | 任务工具最终由任务模块注入 Tool Registry |

## 任务拆分
### AGT-001 Agent 服务骨架与统一入口
- status: completed
- goal：建立 `AgentService`，统一封装模型初始化、Agent 创建与消息处理入口。
- inputs：需求文档 3.1、3.2、6.1；架构文档 4.1；API 文档 3.1、7.1。
- outputs：`src/services/agent.ts`。
- dependencies：`specs/10-line-message.spec.md` 的 LINE-003。
- implementation notes：使用官方 `createAgent()`；对外暴露单一 `processUserMessage({ userId, message, channel })` 方法；封装 LLM 初始化、工具注册和错误映射；返回结果至少包含 `reply` 和 `usedTools` 摘要。
- acceptance criteria：Webhook 与 `/chat` 都可通过同一 Agent 入口处理消息；模型异常可被统一捕获并映射。

### AGT-002 上下文记忆与消息标准化
- status: completed
- goal：实现按 `userId` 隔离的短期上下文，并规范来自 Webhook 与 `/chat` 的消息输入。
- inputs：需求文档 3.2.2、3.2.5、4.1；数据库文档 2.1；架构文档 4.1。
- outputs：上下文内存管理逻辑、消息标准化层。
- dependencies：AGT-001。
- implementation notes：使用 `Map<string, BaseMessage[]>` 保存最近 3 轮消息；对 Webhook 和 `/chat` 输入统一归一化；Slash Command 仍作为普通文本进入 Agent，但要保留命令原文以便下游任务工具判断。
- acceptance criteria：不同用户上下文互不污染；同一用户最多保留最近 3 轮；`/chat` 与 LINE 文本消息共享同一上下文和处理逻辑。

### AGT-003 Tool Registry 与 Tavily 搜索工具
- goal：建立统一 Tool Registry，并先接入 Tavily 搜索工具。
- inputs：需求文档 3.2.3、3.2.4、3.5；架构文档 4.2、4.5；API 文档 7.2。
- outputs：`src/tools/index.ts`、`src/tools/tavily-search.ts`、工具注册接口。
- dependencies：AGT-001。
- implementation notes：Tool Registry 负责注册工具名称、输入输出契约和错误语义；首轮至少可注册 Tavily 搜索工具，并为后续任务工具预留注入点；Tavily 搜索需设置超时并对失败返回可读错误。
- acceptance criteria：实时信息问题可触发 `search.tavily`；搜索结果可被整理为文本回复；搜索失败不暴露密钥。

### AGT-004 `/chat` 调试入口与一致性校验
- goal：让 `/chat` 成为真实消息链路的等价调试入口。
- inputs：需求文档 3.1.1、5.2、8.1、8.2；API 文档 3.1。
- outputs：`src/routes/chat.ts`、请求体验证、错误到响应结构的映射。
- dependencies：AGT-001、AGT-002、AGT-003。
- implementation notes：请求体固定为 `userId` 和 `message`；成功时返回 `code/message/data`；失败时返回统一错误结构；不得绕过 Agent 或单独调用旧的 `LLMService.chat()`。
- acceptance criteria：`/chat` 与 LINE 文本消息的工具调用和降级行为一致；参数错误与外部服务错误都返回稳定 JSON。

## 验收与测试
- 单元验证：Agent 输入标准化、上下文裁剪、工具注册、Tavily 错误映射。
- 集成验证：真实 Webhook 文本消息与 `POST /chat` 都可触发同一 Agent 流程。
- 演示验收：普通问题可得到 Agent 回复；实时信息问题可自动使用 Tavily；搜索失败时有可读降级。

## 本轮实现记录
- scope: 仅实现 `AGT-001` 与 `AGT-002`，建立统一 `AgentService` 入口和按 `userId` 管理的最近 3 轮上下文。
- deferred: `AGT-003` Tavily Tool Registry、任务工具、JSON 持久化、任务所有权校验、天气调度执行均延期到后续 spec 切片。
- decision: `/webhook` 与 `/chat` 必须直接复用同一个 `AgentService.processUserMessage()`，不再保留旧的“直接 LLM 主链路”作为正式路径。
- validation: 本轮补最小自检脚本，重点覆盖输入标准化、上下文裁剪，以及 `/webhook`、`/chat` 共用服务入口。

## 风险与回退
- 风险：`createAgent()` 与当前直接模型调用方式差异较大，若边界不清会导致 `/webhook` 与 `/chat` 行为分叉。
- 风险：Tavily 或模型接口超时会拖慢整条消息链路。
- 回退：保留单一 Agent 外壳和固定 fallback 回复；必要时先禁用 Tavily 工具，仅验证统一入口与上下文能力。

## 当前实现基线
- 已完成统一 `AgentService`，`/webhook` 与 `/chat` 复用同一个 `processUserMessage()` 入口。
- 已按 `userId` 落地最近 3 轮上下文内存，旧的“直接 LLM 主链路”不再作为正式路径保留。
- 下一步进入 `AGT-003`，补 Tool Registry 与 Tavily 搜索工具接入。
