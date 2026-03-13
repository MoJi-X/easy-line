# Demo 开发总览

## 输入基线
- 权威文档：`docs/需求规格说明书.md`
- 参考文档：`docs/architecture/系统架构设计文档.md`
- 参考文档：`docs/architecture/数据库设计文档.md`
- 参考文档：`docs/api/API接口设计文档.md`
- 开发原则：核心优先、快速迭代、精简架构、优先成熟框架、暂缓重型优化

## 统一取舍
- 文档冲突时以《需求规格说明书》为准。
- 环境变量命名采用 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`、`PORT`。
- Demo 存储采用内存 `Map<string, BaseMessage[]>`、`src/config/tasks.json`，不引入正式数据库。
- 安全和性能只保留 Demo 必需项：Webhook 签名校验、环境变量管理、基础错误处理、基础健康检查。
- 定时任务的运行时配置以静态 JSON 为主，不做完整后台配置平台。

## 模块拆分
| Spec | 模块 | 核心职责 | 明确不负责 |
| --- | --- | --- | --- |
| `specs/10-line-message.spec.md` | 启动与 LINE 消息链路 | 应用入口、配置加载、Webhook、文本消息回复、LINE SDK 封装 | LLM 记忆策略、定时任务调度 |
| `specs/20-llm-context.spec.md` | LLM 对话与上下文 | LangChain 集成、按用户维度记忆、降级回复、Webhook 对接 | 定时任务、后台配置 |
| `specs/30-scheduler-push.spec.md` | 定时推送与任务运行 | `tasks.json`、`node-cron`、第三方 API 拉取、模板渲染、主动推送 | 正式数据库、复杂任务编排 |
| `specs/40-api-governance.spec.md` | 共享接口约束与迭代治理 | 通用响应格式、错误处理、健康检查、延期项治理、Spec 驱动协作 | 企业级鉴权、性能调优体系 |

## 依赖顺序
| 顺序 | Spec | 依赖 | 说明 |
| --- | --- | --- | --- |
| 1 | `specs/10-line-message.spec.md` | 无 | 先把服务启动、Webhook、消息回复跑通 |
| 2 | `specs/20-llm-context.spec.md` | `specs/10-line-message.spec.md` | 在已跑通的消息链路中接入智能回复 |
| 3 | `specs/30-scheduler-push.spec.md` | `specs/10-line-message.spec.md` | 复用 LINE 推送能力完成定时消息 |
| 4 | `specs/40-api-governance.spec.md` | `specs/10-line-message.spec.md`、`specs/20-llm-context.spec.md`、`specs/30-scheduler-push.spec.md` | 统一内部接口、错误处理、文档与收尾规则 |

## 实施节奏
1. 先完成可启动的 Express 服务、环境变量加载、`POST /webhook` 和基础回复。
2. 再接入 LangChain 与按 `userId` 管理的上下文记忆，保证聊天主链路可演示。
3. 在主链路稳定后实现 `src/config/tasks.json`、`node-cron`、API 拉取和主动推送。
4. 最后统一内部接口格式、日志、健康检查、延期项与协作规则。

## 覆盖摘要
| 需求章节 | 对应 Spec | 覆盖内容 |
| --- | --- | --- |
| 2.1 / 2.2 / 2.3 | `specs/00-overall-plan.spec.md` | Demo 目标、开发原则、运行环境、取舍结论 |
| 3.1 | `specs/10-line-message.spec.md` | Webhook、签名校验、消息解析、Reply Message |
| 3.2 | `specs/20-llm-context.spec.md` | LangChain、对话生成、上下文保留、降级回复 |
| 3.3 | `specs/30-scheduler-push.spec.md` | 任务 JSON、Cron 调度、模板渲染、Push/Multicast |
| 4.1 / 4.2 | `specs/10-line-message.spec.md`、`specs/20-llm-context.spec.md`、`specs/40-api-governance.spec.md` | 小规模性能目标、最低安全基线 |
| 5.x | `specs/10-line-message.spec.md`、`specs/30-scheduler-push.spec.md`、`specs/40-api-governance.spec.md` | 外部接口、内部管理接口、响应与错误处理 |
| 6.x / 7.x | 全部模块 Spec | 技术栈、目录结构、文件归属 |
| 8.x | 全部模块 Spec | 功能验收与 Demo 演示验收 |

## 延期项
- 完整后台鉴权与权限控制
- 高级限流、熔断、审计平台
- PostgreSQL / Redis 正式持久化
- 针对性能与并发的专项优化
