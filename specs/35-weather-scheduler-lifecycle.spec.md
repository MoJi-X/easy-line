# 天气调度执行与任务生命周期开发规格

## 目标与边界
- 目标：基于已持久化的 `daily_weather` 任务完成调度注册、刷新、天气查询、消息渲染、主动推送和执行记录。
- 范围内：`src/services/scheduler.ts`、天气 API 客户端、任务执行日志、手动执行入口、健康检查所需的调度状态。
- 范围外：任务字段编辑、自然语言意图解析、任意工具编排为定时任务。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/需求规格说明书.md` | 3.4、4.1、5.1、5.2、8.1、8.2 | 调度刷新、天气执行、手动执行、验收标准 |
| `docs/architecture/系统架构设计文档.md` | 3.1、4.4、5.3、7 | Scheduler 职责、刷新机制、执行流程、日志 |
| `docs/architecture/数据库设计文档.md` | 2.3、4.2、5.2 | 执行记录、写回后刷新、调度数据流 |
| `docs/api/API接口设计文档.md` | 4.6、6.1、7.3 | 手动执行、健康检查、天气 API 约束 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| `specs/10-line-message.spec.md` | hard | 复用 `LineService.pushMessage()` 完成主动推送 |
| `specs/30-task-crud-persistence.spec.md` | hard | Scheduler 从任务仓储获取任务集合并响应刷新契约 |
| `axios` | hard | 调用天气 API |
| `node-cron` | hard | 注册和执行每日任务 |
| `specs/40-api-governance.spec.md` | soft | 手动执行与健康检查接口最终服从统一响应结构 |

## 任务拆分
### SCH-001 调度器加载与刷新生命周期
- goal：建立 Scheduler 的启动、停止、加载与刷新流程。
- inputs：需求文档 3.4.1、3.4.2；架构文档 4.4；数据库文档 4.2、5.1。
- outputs：`src/services/scheduler.ts` 的 `start()`、`stop()`、`reload()` 和任务注册逻辑。
- dependencies：`specs/30-task-crud-persistence.spec.md` 的 TASK-004。
- implementation notes：启动时读取当前有效任务；根据 `dailyTime` 推导每日执行计划；刷新时先停旧任务再重建；仅注册 `enabled=true` 的 `daily_weather` 任务；调度语义固定为服务器时区。
- acceptance criteria：启动可加载全部有效任务；CRUD 成功后可刷新注册状态；重复启动、重复停止、重复刷新都有稳定行为和日志。

### SCH-002 天气数据获取、消息渲染与主动推送
- goal：把单个任务执行闭环跑通。
- inputs：需求文档 3.4.2、3.4.3、5.1；架构文档 5.4；API 文档 7.3。
- outputs：天气 API 调用逻辑、固定天气消息渲染、主动推送执行函数。
- dependencies：SCH-001、`specs/10-line-message.spec.md` 的 LINE-002。
- implementation notes：天气 API 必须设置超时；输入最少使用 `city`；消息模板为系统固定文本，不允许用户自定义；执行成功后通过 `pushMessage()` 推送给 `ownerUserId`；单任务失败不得影响其他任务继续运行。
- acceptance criteria：启用任务能按计划执行；天气数据可被渲染为文本消息；任务所属用户可收到主动推送；外部 API 失败时有清晰日志。

### SCH-003 手动执行、执行记录与健康状态
- goal：提供调试和演示所需的手动执行与执行结果查询能力。
- inputs：需求文档 3.4.2、4.1、5.2、8.1；API 文档 4.6、6.1。
- outputs：`POST /api/tasks/:taskId/execute`、执行记录缓存、调度状态摘要。
- dependencies：SCH-001、SCH-002。
- implementation notes：手动执行仍需要当前用户所有权约束；执行记录至少保存最近若干次结果；`/health` 需要暴露调度器运行状态和任务计数；调度器日志继续写入 `logs/scheduler.log`。
- acceptance criteria：可手动执行指定任务；执行结果可被查询；`/health` 能反映调度器和任务数量的基本状态。

## 验收与测试
- 单元验证：`dailyTime` 到调度计划的转换、天气消息渲染、执行记录截断。
- 集成验证：启动自动加载任务、仓储刷新后调度器可重载、手动执行可触发一次天气推送。
- 演示验收：至少一个动态任务能成功推送每日天气；任务更新时间后刷新生效；单任务失败不拖垮整体服务。

## 风险与回退
- 风险：服务器时区与用户期望不一致，会导致时间展示与实际执行产生偏差。
- 风险：天气 API 返回结构波动会影响消息渲染稳定性。
- 回退：先保留手动执行和 mock 天气数据，确保调度生命周期和消息推送链路可验证，再补真实天气 API 适配。

## 当前实现基线
- 当前代码已有基于静态 `schedule` 字段的调度与手动执行雏形。
- 下一步需要把调度器改为依赖任务仓储、支持 `reload()` 和 `dailyTime` 语义，并把执行目标固定到 `ownerUserId`。
