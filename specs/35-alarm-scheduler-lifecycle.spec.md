# 告警信息定时任务执行与生命周期开发规格

## 目标与边界
- 目标：基于已持久化的 `alarm_info_fetch` 任务完成调度注册、刷新、告警任务触发、执行记录和生命周期管理。
- 范围内：`src/services/scheduler.ts`、`node-cron` 注册逻辑、直连告警服务拉取、摘要渲染、任务执行日志、调度状态快照与健康检查所需的基础信息。
- 范围外：任务字段编辑、自然语言意图解析、把任意工具编排进定时任务。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/需求规格说明书.md` | 3.4、4.1、5.1、5.2、8.1、8.2 | 调度刷新、告警执行、验收标准 |
| `docs/architecture/系统架构设计文档.md` | 3.1、4.4、5.3、7 | Scheduler 职责、刷新机制、执行流程、日志 |
| `docs/architecture/数据库设计文档.md` | 2.3、4.2、5.2 | 执行记录、写回后刷新、调度数据流 |
| `docs/api/API接口设计文档.md` | 4.6、6.1、7.3 | 手动执行、健康检查、告警服务约束 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| `specs/10-line-message.spec.md` | hard | 复用 `LineService.pushMessage()` 完成主动推送 |
| `specs/30-task-crud-persistence.spec.md` | hard | Scheduler 从任务仓储获取任务集合并响应刷新契约 |
| `node-cron` | hard | 注册和执行 6 字段 cron 任务 |
| `specs/40-api-governance.spec.md` | soft | 调度状态、执行日志和健康检查最终服从统一响应结构 |

## 任务拆分
### SCH-001 调度器加载与刷新生命周期
- goal：建立 Scheduler 的启动、停止、加载与刷新流程。
- inputs：需求文档 3.4.1、3.4.2；架构文档 4.4；数据库文档 4.2、5.1。
- outputs：`src/services/scheduler.ts` 的调度注册、停止和刷新逻辑。
- dependencies：`specs/30-task-crud-persistence.spec.md` 的 TASK-004。
- implementation notes：启动时读取当前有效任务；统一直接消费持久化中的 6 字段 `cron`；刷新时先停旧任务再重建；仅注册 `enabled=true` 的 `alarm_info_fetch` 任务；调度实现固定使用 `node-cron`；调度语义固定为服务器时区；示例基线 `0 0 8 * * *` 表示每天 08:00:00，`* * * * * *` 表示每秒。
- acceptance criteria：启动可加载全部有效任务；CRUD 成功后可刷新注册状态；重复启动、重复停止、重复刷新都有稳定行为和日志。

### SCH-002 告警任务触发与执行记录
- goal：把单个告警定时任务的触发闭环跑通。
- inputs：需求文档 3.4.2、3.4.3、5.1；架构文档 5.4；API 文档 7.3。
- outputs：调度触发回调、执行日志、最近执行记录缓存。
- dependencies：SCH-001。
- implementation notes：执行体围绕“获取告警信息”任务语义命名，不再保留天气逻辑；Scheduler 直接调用告警服务的列表接口，根据任务 `alertScope` 映射查询状态，先生成文本摘要再通过 `LineService.pushMessage()` 主动推送，并把同一批 `alarmList` 写回用户会话状态，供后续直接“分析第 N 条告警”继续处理，不再经过通用 Agent；执行记录至少保存 `taskId`、`taskName`、`ownerUserId`、`cron`、`status`、`triggeredBy`、`executedAt`、`durationMs`、`message`；单任务失败不得影响其他任务继续运行。
- acceptance criteria：启用任务可按 `cron` 注册并被触发；执行开始、完成、失败都有可读日志；最近执行记录可供后续接口读取。

### SCH-003 调度状态与健康摘要
- goal：提供调试和演示所需的调度状态摘要。
- inputs：需求文档 3.4.2、4.1、5.2、8.1；API 文档 4.6、6.1。
- outputs：刷新快照、任务计数、最近执行记录访问入口。
- dependencies：SCH-001、SCH-002。
- implementation notes：Scheduler 需要暴露最近一次刷新快照与启用任务计数；状态摘要用于 `/health` 或管理接口扩展，不要求本切片内完成全部对外路由。
- acceptance criteria：调度器可报告最近刷新动作、总任务数、启用任务数；任务更新后状态摘要随刷新更新。

## 验收与测试
- 单元验证：6 字段 `cron` 注册、任务重载、执行记录截断。
- 集成验证：启动自动加载任务、仓储刷新后调度器可重载、更新任务 `cron` 后旧 job 被移除且新 job 被重建。
- 演示验收：至少一个告警定时任务能被 `node-cron` 成功注册；任务更新时间后刷新生效；单任务失败不拖垮整体服务。

## 风险与回退
- 风险：服务器时区与用户期望不一致，会导致时间展示与实际执行产生偏差。
- 风险：执行体依赖告警服务返回结构，外部返回字段波动会影响任务结果渲染稳定性。
- 回退：先保留最小告警任务执行记录与日志，确保调度生命周期和注册重载链路可验证，再补真实告警拉取与主动推送适配。

## 当前实现基线
- 当前代码基线要求 Scheduler 依赖任务仓储、告警客户端和 `LineService`，显式使用 `node-cron`、支持 `reload` 语义，并把执行目标固定到告警信息获取任务。
- 当前调度链路不再通过 `AgentService`，而是直接拉取告警列表、生成摘要文本并推送给任务所属用户。
- 下一步可在当前生命周期框架上补齐健康检查详情与更丰富的执行摘要，而不再回退到天气任务模型。
