# Agent 场景下的 API 与迭代治理开发规格

## 目标与边界
- 目标：为 Agent、任务仓储和天气调度建立统一的内部接口约定、错误处理、健康检查、日志和 Spec 驱动协作规则。
- 范围内：内部 JSON 响应格式、错误码最小集合、`/health`、日志字段、Spec/AGENTS 同步规则、延期项记录。
- 范围外：完整权限系统、细粒度审计、性能压测体系、企业级运维平台。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/需求规格说明书.md` | 2.2、4、5.2、8.1、8.2、9.2 | 开发原则、非功能要求、接口与延期项 |
| `docs/api/API接口设计文档.md` | 1、3、4、6、7 | 通用响应结构、错误码、`/chat`、任务接口、健康检查 |
| `docs/architecture/系统架构设计文档.md` | 6、7、8 | 路由职责、日志、部署边界 |
| `AGENTS.md` | 全文 | 快速迭代规则和协作约束 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| `specs/10-line-message.spec.md` | hard | `/health` 和 Webhook 主链路由应用入口承载 |
| `specs/20-agent-orchestrator.spec.md` | hard | 错误处理和日志需覆盖 Agent、Tavily 和上下文流程 |
| `specs/30-task-crud-persistence.spec.md` | hard | 内部任务接口和错误码需覆盖 CRUD、所有权和 JSON 持久化 |
| `specs/35-weather-scheduler-lifecycle.spec.md` | hard | 健康检查、执行日志和手动执行结果由 Scheduler 提供 |

## 任务拆分
### GOV-001 统一内部接口约定与错误码
- goal：冻结 `/chat`、`/api/tasks` CRUD、`/api/tasks/:taskId/execute` 的最小返回格式和错误码集合。
- inputs：需求文档 5.2、8.1；API 文档 1.2、1.3、3、4、6。
- outputs：内部接口返回规范、错误码表、Webhook 与内部接口的边界约束。
- dependencies：`specs/30-task-crud-persistence.spec.md` 的 TASK-002、TASK-003，`specs/35-weather-scheduler-lifecycle.spec.md` 的 SCH-003。
- implementation notes：`POST /webhook` 维持 LINE 回调风格 `{status:'ok'}`；内部接口统一使用 `code/message/data`；错误码最小集合至少覆盖参数错误、资源不存在、任务越权、签名失败、外部服务错误、内部错误。
- acceptance criteria：内部接口返回结构一致；错误路径稳定；Webhook 不被内部接口规范误伤。

### GOV-002 Demo 级错误处理、日志与健康检查
- goal：建立不会拖慢开发节奏的基础观测与故障定位能力。
- inputs：需求文档 4.1、4.2、4.3；API 文档 6、7；架构文档 7。
- outputs：统一错误处理中间件、`GET /health`、日志字段规范、模块级日志分类。
- dependencies：`specs/10-line-message.spec.md`、`specs/20-agent-orchestrator.spec.md`、`specs/30-task-crud-persistence.spec.md`、`specs/35-weather-scheduler-lifecycle.spec.md`。
- implementation notes：日志至少区分 `webhook`、`agent`、`tavily`、`task-repository`、`scheduler`；运行时 `INFO/WARN/ERROR` 写入 `logs/app.log`，Scheduler 继续写 `logs/scheduler.log`；敏感配置、完整消息正文和完整请求体不输出到日志；`/health` 需返回 agent ready、scheduler running、taskCount 等基础状态。
- acceptance criteria：服务启动后能通过 `/health` 判断基本状态；异常时日志足以定位失败模块；单个任务失败不拖垮整体服务。

### GOV-003 Spec 驱动协作与 AGENTS 同步规则
- goal：让新的 spec 体系和 `AGENTS.md` 成为后续实现的共同基线。
- inputs：需求文档 2.2、9.2；`AGENTS.md`；本次 spec 拆分结果。
- outputs：模块推进顺序、延期项记录方式、文档与 AGENTS 的同步规则。
- dependencies：无。
- implementation notes：所有新增范围、取舍和延期项先更新对应 spec；实施顺序固定为 10 -> 20 -> 30 -> 35 -> 40；`AGENTS.md` 中仍保留的“静态 JSON、不实现在线增删改全套能力”等旧约束，在进入 30 号 spec 实施前必须同步修订，避免协作基线冲突；安全和性能优化仅保留延期项说明，不在首轮实现中展开。
- acceptance criteria：开发任务可直接映射到五份 spec；范围变动能在 spec 中追踪；AGENTS 与 spec 不再出现关键边界冲突。

## 验收与测试
- 单元验证：错误码映射、统一响应包装、日志字段格式。
- 集成验证：`/health`、`/chat`、`/api/tasks` CRUD、`/api/tasks/:taskId/execute` 在正常与异常情况下都可返回稳定结构。
- 管理验收：五份 spec 能覆盖当前 Demo 的后续开发任务，团队按 spec 顺序推进不会出现职责重叠。

## 风险与回退
- 风险：若内部接口和 Webhook 混用同一响应规范，可能破坏 LINE 回调约定。
- 风险：若 AGENTS 仍保留旧的静态任务规则，后续协作会出现“需求允许、协作基线禁止”的冲突。
- 回退：治理项只保留最小集合；超出 Demo 范围的安全、性能和运维工作统一记录为延期项。

## 当前实现基线
- 当前代码已有统一错误处理中间件、`/health` 和基础日志落盘雏形。
- 下一步需要把错误码、健康检查和日志分类扩展到 Agent、任务仓储和天气调度的新边界，并同步收敛 AGENTS 与 spec 的差异。
