# Demo 开发总览

## 输入基线
- 权威文档：`docs/需求规格说明书.md`
- 参考文档：`docs/动态任务与Agent重构需求变更说明.md`
- 参考文档：`docs/architecture/系统架构设计文档.md`
- 参考文档：`docs/architecture/数据库设计文档.md`
- 参考文档：`docs/api/API接口设计文档.md`
- 开发原则：核心优先、快速迭代、精简架构、先 spec 后编码

## 统一取舍
- 文档冲突时以《需求规格说明书》为准。
- 环境变量命名采用 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`、`TAVILY_API_KEY`、`WEATHER_API_KEY`、`PORT`。
- Demo 存储采用内存 `Map<string, BaseMessage[]>`、内存任务索引和 `src/config/tasks.json` 写回，不引入正式数据库。
- 统一消息处理入口为 Agent；`POST /webhook` 与 `POST /chat` 共用同一业务链路。
- 动态任务仅支持当前用户自己的 `daily_weather` 任务；频率固定为每天一次，使用服务器时区。
- 工具首批范围固定为任务 CRUD 与 Tavily 搜索，不开放任意工具编排为定时任务。
- 安全和性能只保留 Demo 必需项：Webhook 签名校验、外部调用超时、基础错误处理、日志脱敏、基础健康检查。

## 模块拆分
| Spec | 模块 | 核心职责 | 明确不负责 |
| --- | --- | --- | --- |
| `specs/10-line-message.spec.md` | 启动与 LINE 消息桥接 | 应用入口、配置加载、Webhook、LineService、消息桥接接口 | Agent 推理、任务 CRUD、天气调度 |
| `specs/20-agent-orchestrator.spec.md` | Agent 编排与工具框架 | `createAgent()`、上下文记忆、Tool Registry、Tavily、`/chat` 一致性 | JSON 持久化、天气任务执行 |
| `specs/30-task-crud-persistence.spec.md` | 动态任务 CRUD 与持久化 | 任务模型、所有权校验、自然语言/命令任务工具、`src/config/tasks.json` 回写、任务管理接口 | 实际天气拉取与定时推送 |
| `specs/35-weather-scheduler-lifecycle.spec.md` | 天气调度执行与生命周期 | 任务加载与刷新、天气 API 调用、消息渲染、Push、执行日志 | 用户意图解析、任务字段编辑 |
| `specs/40-api-governance.spec.md` | 共享接口约束与迭代治理 | 通用响应结构、错误码、健康检查、日志、Spec/AGENTS 同步规则 | 企业级鉴权、性能调优体系 |

## 依赖顺序
| 顺序 | Spec | 依赖 | 说明 |
| --- | --- | --- | --- |
| 1 | `specs/10-line-message.spec.md` | 无 | 先把服务启动、Webhook、LINE SDK 和消息桥接跑通 |
| 2 | `specs/20-agent-orchestrator.spec.md` | `specs/10-line-message.spec.md` | 在稳定的消息桥接上接入统一 Agent、上下文与 Tavily |
| 3 | `specs/30-task-crud-persistence.spec.md` | `specs/10-line-message.spec.md`、`specs/20-agent-orchestrator.spec.md` | 冻结任务模型、所有权、JSON 持久化与任务工具 |
| 4 | `specs/35-weather-scheduler-lifecycle.spec.md` | `specs/10-line-message.spec.md`、`specs/30-task-crud-persistence.spec.md` | 复用 LineService 和任务仓储完成天气推送闭环 |
| 5 | `specs/40-api-governance.spec.md` | `specs/10-line-message.spec.md`、`specs/20-agent-orchestrator.spec.md`、`specs/30-task-crud-persistence.spec.md`、`specs/35-weather-scheduler-lifecycle.spec.md` | 统一内部接口、错误处理、健康检查与协作规则 |

## 实施节奏
1. 先完成可启动的 Express 服务、环境变量加载、`POST /webhook` 和 `LineService`。
2. 再把消息主链路切到 Agent，统一 `/webhook` 与 `/chat` 的行为，并接入 Tavily 搜索。
3. 然后实现任务模型、任务工具、自然语言与 `/task` 命令的 CRUD，以及 `src/config/tasks.json` 写回。
4. 在任务持久化稳定后实现调度加载、刷新、天气 API 拉取和主动推送。
5. 最后统一响应、错误码、日志、健康检查与 Spec 驱动的迭代规则。

## 覆盖摘要
| 需求章节 | 对应 Spec | 覆盖内容 |
| --- | --- | --- |
| 2.1 / 2.2 / 2.3 | `specs/00-overall-plan.spec.md` | Demo 目标、开发原则、运行环境、统一取舍 |
| 3.1 | `specs/10-line-message.spec.md`、`specs/20-agent-orchestrator.spec.md` | Webhook、签名校验、消息桥接、统一 Agent 入口 |
| 3.2 | `specs/20-agent-orchestrator.spec.md` | Agent、Tool Registry、上下文记忆、错误降级 |
| 3.3 | `specs/30-task-crud-persistence.spec.md` | 动态任务 CRUD、Slash Command、JSON 持久化、所有权 |
| 3.4 | `specs/35-weather-scheduler-lifecycle.spec.md` | 调度刷新、天气拉取、消息推送、执行日志 |
| 3.5 | `specs/20-agent-orchestrator.spec.md` | Tavily 搜索工具与自动决策 |
| 4.x / 5.x | `specs/10-line-message.spec.md`、`specs/20-agent-orchestrator.spec.md`、`specs/30-task-crud-persistence.spec.md`、`specs/35-weather-scheduler-lifecycle.spec.md`、`specs/40-api-governance.spec.md` | 非功能要求、接口、错误处理、健康检查 |
| 6.x / 7.x | 全部模块 Spec | 技术栈、目录结构、文件归属 |
| 8.x | 全部模块 Spec | 功能验收与 Demo 演示验收 |

## 延期项
- 跨用户代管任务与共享任务池
- 复杂周期、Cron 自定义、任务编排平台
- PostgreSQL / Redis 正式持久化
- 完整鉴权、限流、审计与性能专项优化
