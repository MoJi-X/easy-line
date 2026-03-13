# 定时推送开发规格

## 目标与边界
- 目标：基于静态 JSON 配置和 `node-cron` 完成定时任务加载、第三方 API 拉取、模板渲染和主动推送。
- 范围内：`src/config/tasks.json`、`src/services/scheduler.ts`、最小任务状态查询与手动触发能力。
- 范围外：任务在线增删改后台、复杂工作流编排、持久化执行队列。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/需求规格说明书.md` | 3.3、5.1.1、6.1、7、8.1、9.1 | 权威任务功能、JSON 示例、推送能力、技术选型与验收标准 |
| `docs/architecture/系统架构设计文档.md` | 3.2、4.2、5.2、5.3、6.1-6.4 | `SchedulerService`、管理接口、启动流程、Webhook/API 路由参考 |
| `docs/architecture/数据库设计文档.md` | 1.1、2.2、3.1-3.3、5.2、6.5 | 静态 JSON、任务内存索引、模板变量、执行流程 |
| `docs/api/API接口设计文档.md` | 3.2、3.3、4.1-4.3 | Push/Multicast、任务格式、SchedulerService、手动触发接口 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| `specs/10-line-message.spec.md` | hard | 复用 `LineService` 的 `pushMessage` / `multicast` 能力 |
| `axios` | hard | 用于拉取第三方 API 数据 |
| `node-cron` | hard | 用于注册和执行定时任务 |
| `src/config/tasks.json` | hard | Demo 阶段的唯一任务配置来源 |
| `specs/40-api-governance.spec.md` | soft | 内部管理接口最终服从统一响应格式 |

## 任务拆分
### SCH-001 任务配置文件与加载规则
- goal：固定任务配置格式并建立加载入口。
- inputs：需求文档 3.3.2、3.3.4、7；数据库文档 3.1-3.3、4.2；API 文档 4.1。
- outputs：`src/config/tasks.json`、任务配置类型定义、加载函数。
- dependencies：`specs/10-line-message.spec.md` 的配置入口。
- implementation notes：路径采用需求文档中的 `src/config/tasks.json`；字段至少覆盖 `id`、`name`、`enabled`、`schedule`、`api`、`template`、`targets`；支持环境变量占位符但不做复杂模板引擎。
- acceptance criteria：任务配置可在启动时读取；无效任务能被识别并记录；启用与禁用状态可区分。

### SCH-002 SchedulerService 与执行链路
- goal：实现任务注册、Cron 调度、数据获取、模板渲染与主动推送。
- inputs：需求文档 3.3.1、3.3.2；架构文档 4.2、6.1、6.2；数据库文档 5.2、6.5；API 文档 4.2。
- outputs：`src/services/scheduler.ts`。
- dependencies：SCH-001、`specs/10-line-message.spec.md` 的 LINE-002。
- implementation notes：应用启动时仅加载 `enabled=true` 的任务；先校验 Cron；调用外部 API 后进行字符串模板替换；单播走 `pushMessage`，多目标走 `multicast`；调度器需同时输出控制台日志和 `logs/scheduler.log` 文件日志，覆盖任务注册、启动、停止、执行开始、执行成功、执行失败等关键节点。
- acceptance criteria：启用任务能按时间执行；第三方 API 数据能填充到模板；用户能收到主动推送消息；失败任务会被记录但不影响其他任务运行；应用启动与退出时可看到调度器启动/停止日志，任务执行信息可同时在控制台和日志文件中追踪。

### SCH-003 最小管理接口与调试能力
- goal：提供 Demo 调试必需的任务状态查询和手动触发，不扩展为完整任务后台。
- inputs：架构文档 5.2、6.4；API 文档 4.3、6.1。
- outputs：`GET /api/tasks`、`POST /api/tasks/:taskId/execute`、最近执行日志查询。
- dependencies：SCH-002、`specs/40-api-governance.spec.md` 的 GOV-001 为软依赖。
- implementation notes：接口只服务 Demo 调试；不实现创建、编辑、删除任务的全套管理；执行日志保留最近一次或最近若干次结果即可。
- acceptance criteria：能查看当前已加载任务；能手动触发指定任务；接口失败时返回可读错误信息。

## 验收与测试
- 单元验证：Cron 表达式校验、模板变量替换、任务加载过滤。
- 集成验证：启动后自动加载任务；手动触发接口可执行一次任务。
- 演示验收：至少一个定时任务能成功推送；至少一个外部 API 数据可被模板渲染；`logs/scheduler.log` 中可查看调度器启动、停止和任务执行结果。

## 风险与回退
- 风险：参考文档中任务配置路径存在差异，若误用 `config/tasks.json` 会和需求文档不一致。
- 风险：第三方 API 返回结构不稳定会导致模板变量为空。
- 回退：先保留单个示例任务和固定模板；若接口不稳定，可临时用 mock 数据完成 Demo 演示。

## 实现进展
- 本次提交完成：SCH-001、SCH-002、SCH-003 的最小可运行切片（静态任务配置、SchedulerService、任务查询与手动触发接口），并补齐调度器生命周期与执行日志落盘。
- 当前阻塞：暂无功能阻塞；需在真实环境补齐可用 target userId 与外部 API 凭据后再做联调。
- 下一步建议：衔接 `specs/40-api-governance.spec.md`，补齐统一错误码覆盖与异常路径验收用例。
