# API 与迭代治理开发规格

## 目标与边界
- 目标：为 Demo 项目统一内部接口约定、错误处理、基础健康检查和 Spec 驱动的迭代方式。
- 范围内：内部 JSON 响应格式、错误码最小集合、`/health`、延期项记录、Spec/AGENTS 同步规则。
- 范围外：完整权限系统、细粒度审计、性能压测体系、企业级运维平台。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/需求规格说明书.md` | 2.2、4.1、4.2、8.1、8.2 | 开发原则、性能目标、最低安全要求、功能与演示验收 |
| `docs/api/API接口设计文档.md` | 1.1、1.4、1.5、4.3、6.1、6.2 | 通用响应结构、错误码、手动触发接口、健康检查 |
| `docs/architecture/系统架构设计文档.md` | 5.2、5.4、6.2、6.4 | 任务管理接口、健康检查、启动与 API 路由 |
| `AGENTS.md` | 全文 | 快速迭代规则和协作约束 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| `specs/10-line-message.spec.md` | hard | `/health` 与 Webhook 主链路由应用入口承载 |
| `specs/20-llm-context.spec.md` | hard | 错误处理和降级策略要覆盖 LLM 调用 |
| `specs/30-scheduler-push.spec.md` | hard | 任务状态接口与执行日志由 Scheduler 提供 |

## 任务拆分
### GOV-001 统一 Demo 内部接口约定
- goal：冻结内部管理接口的最小返回格式和错误码集合。
- inputs：API 文档 1.4、1.5、4.3、6.1；架构文档 5.2、5.4。
- outputs：内部接口返回规范、错误码表、路由约束。
- dependencies：`specs/30-scheduler-push.spec.md` 的 SCH-003。
- implementation notes：`POST /webhook` 维持 LINE 回调风格 `{status: 'ok'}`；内部接口如 `/api/tasks`、`/api/tasks/:taskId/execute` 以及调试入口 `/chat` 可采用通用 `code/message/data` 结构；错误码仅保留参数错误、资源不存在、签名失败、内部错误、第三方服务错误这组最小集合。
- acceptance criteria：内部接口返回格式一致；错误路径有稳定结构；Webhook 不被内部管理接口规范误伤。

### GOV-002 Demo 级错误处理与健康检查
- goal：建立不会拖慢开发节奏的基础观测与故障定位能力。
- inputs：需求文档 4.1、4.2；API 文档 6.1、6.2；架构文档 5.4、6.2。
- outputs：统一错误处理中间件、`GET /health`、基础日志字段。
- dependencies：`specs/10-line-message.spec.md`、`specs/20-llm-context.spec.md`、`specs/30-scheduler-push.spec.md`。
- implementation notes：保留 Demo 最低能力即可；`/ready` 可作为可选项，不阻塞首版；日志必须能区分 Webhook、LLM、Scheduler 三类错误来源；运行时 `INFO/WARN/ERROR` 写入 `logs/app.log`，Scheduler 继续写 `logs/scheduler.log`；敏感配置、完整消息正文和完整请求体不输出到日志。
- acceptance criteria：服务启动后能通过 `/health` 判断基本状态；异常时有足够日志定位失败模块；不会因为单个任务失败拖垮整体服务。

### GOV-003 Spec 驱动的快速迭代机制
- goal：让 `*.spec.md` 和 `AGENTS.md` 真正作为 Codex 的开发管理基线。
- inputs：需求文档 2.2、8.2；`AGENTS.md`；用户给定开发原则。
- outputs：模块推进顺序、延期项记录方式、文档同步规则。
- dependencies：无。
- implementation notes：所有新增范围、取舍和延期项先更新对应 spec；迭代优先级固定为聊天主链路、LLM 记忆、定时推送、治理收尾；安全和性能优化仅保留占位说明，不在首轮实现中展开。
- acceptance criteria：开发任务可以直接映射到四份 spec；范围变动能在 spec 中追踪；延期项不会混入当前实现任务。

## 验收与测试
- 单元验证：错误码映射、统一响应包装、日志字段格式。
- 集成验证：`/health`、`/chat`、`/api/tasks`、`/api/tasks/:taskId/execute` 在正常与异常情况下都可返回稳定结构。
- 管理验收：四份 spec 可以覆盖当前 Demo 开发任务，团队按 spec 顺序推进不会出现模块责任重叠。

## 风险与回退
- 风险：若过早引入完整鉴权、限流、审计，会偏离“核心优先、快速迭代”的目标。
- 风险：若内部接口和 Webhook 混用同一响应规范，可能破坏 LINE 回调约定。
- 回退：治理项只保留最小集合；超出 Demo 范围的安全、性能和运维工作统一记录为延期项。

## 实现进展
- 本次提交完成：GOV-001、GOV-002 的最小集合（`code/message/data` 响应结构、错误处理中间件、`/health`、`/chat` 与内部接口共存）。
- 2026-03-13：补充通用运行时日志落盘，新增 `logs/app.log` 记录应用启动、Webhook、LLM、HTTP 错误和进程级异常，`logs/scheduler.log` 保持调度器专用。
- 当前阻塞：签名失败与第三方错误的自动化测试尚未补齐，仅完成运行时错误映射。
- 下一步建议：推进 GOV-003，补充 Spec 驱动流程中的延期项模板与验收脚本。
