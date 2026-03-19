# 动态任务 CRUD 与 JSON 持久化开发规格

## 目标与边界

- 目标：建立“获取告警信息”的定时任务模型，支持当前用户范围内通过自然语言与 `/task` 命令两种方式创建、查询任务，并把运行时变更持久化回 `src/config/tasks.json`。
- 范围内：`src/services/task-repository.ts`、任务类型定义、任务工具、`src/routes/tasks.ts`、`src/config/tasks.json` 的加载与写回规则。
- 范围外：告警定时拉取执行、实际消息推送、复杂调度编排。

## 关联文档

| 文档                                    | 章节                         | 用途                                           |
| --------------------------------------- | ---------------------------- | ---------------------------------------------- |
| `docs/需求规格说明书.md`                | 3.3、3.4、4.2、5.2、8.1、8.2 | 动态任务、Slash Command、所有权和持久化规则    |
| `docs/architecture/系统架构设计文档.md` | 3.2、4.3、4.4、5.2、5.3      | Task Repository、任务 CRUD 流程、调度刷新契约  |
| `docs/architecture/数据库设计文档.md`   | 1.1、2.2、3、4、5.1          | 任务索引、任务字段、写回流程                   |
| `docs/api/API接口设计文档.md`           | 1.2、1.3、4、5               | 任务对象、管理接口、Slash Command 语义与错误码 |

## 模块依赖

| 依赖项                                       | 类型       | 说明                                         |
| -------------------------------------------- | ---------- | -------------------------------------------- |
| `specs/10-line-message.spec.md`              | hard       | 提供统一配置入口和应用挂载点                 |
| `specs/20-agent-orchestrator.spec.md`        | hard       | 任务工具需要通过 Tool Registry 向 Agent 暴露 |
| `src/config/tasks.json`                      | hard       | 静态种子与运行时任务共用持久化文件           |
| `specs/35-alarm-scheduler-lifecycle.spec.md` | downstream | Scheduler 依赖持久化后的任务集合和刷新契约   |
| `specs/40-api-governance.spec.md`            | soft       | 内部接口返回结构和错误码服从治理规范         |

## 任务拆分

### TASK-001 任务模型与仓储加载规则

- goal：冻结“获取告警信息”定时任务模型，并建立 JSON 加载和写回入口。
- inputs：需求文档 3.3.2、3.3.5、7；数据库文档 3、4；架构文档 4.3。
- outputs：`src/services/task-repository.ts`、任务类型定义、`src/config/tasks.json` 读写逻辑。
- dependencies：`specs/10-line-message.spec.md` 的 LINE-001。
- implementation notes：字段至少覆盖 `id`、`type`、`name`、`ownerUserId`、`alertScope`、`cron`、`enabled`、`source`、`createdAt`、`updatedAt`；其中 `type` 固定为 `alarm_info_fetch`；`alertScope` 用于表达告警来源或过滤范围；`cron` 固定采用 6 字段格式；种子任务与运行时任务共存于同一文件；写回时以完整任务集合覆盖文件内容。
- acceptance criteria：启动时可加载有效任务；无效任务能被识别并记录；写回后的 JSON 结构稳定且可重载。

### TASK-002 所有权校验与 CRUD 服务

- goal：实现当前用户范围内的告警定时任务创建、查询、更新、删除。
- inputs：需求文档 3.3.2、3.3.3、5.2；架构文档 4.3、5.2；API 文档 4.2-4.6。
- outputs：任务 CRUD 服务、`src/routes/tasks.ts` 的 `GET/POST/PATCH/DELETE` 接口。
- dependencies：TASK-001。
- implementation notes：所有变更都基于 `userId` 限定当前用户；`cron` 必须通过 6 字段校验，例如 `0 0 8 * * *`；不允许自定义 `ownerUserId`、任意 `targets` 或非 6 字段 cron；任务不存在返回 `RESOURCE_NOT_FOUND`，越权返回 `FORBIDDEN_TASK_ACCESS`；创建与查询接口需覆盖告警任务必要字段回显，保证后续 `/task` 与自然语言链路复用同一结果结构。
- acceptance criteria：当前用户只能看到并操作自己的任务；创建、更新、删除成功后持久化文件同步更新；错误路径返回可读原因。

### TASK-003 任务工具与 Slash Command 语义

- goal：把告警定时任务的创建与查询能力封装成 Agent 工具，并明确 `/task` 命令和自然语言入口的可验证语义。
- inputs：需求文档 3.3.1、3.3.4、8.2；API 文档 5。
- outputs：`src/tools/task-tools.ts`、任务工具输入输出契约、Slash Command 解析规则。
- dependencies：TASK-001、TASK-002、`specs/20-agent-orchestrator.spec.md` 的 AGT-003。
- implementation notes：首轮工具固定为 `task.create`、`task.list`、`task.update`、`task.delete`；本切片验收优先关注 `task.create` 与 `task.list`；Slash Command 采用确定性参数格式，并支持 `cron="0 0 8 * * *"` 这类带引号值；自然语言缺少告警范围或时间时，Agent 必须先追问补全，再把简单每日时间表达转换为 6 字段 cron；同一个仓储结果必须同时支撑 `/task` 和自然语言回复，避免两套查询口径。
- implementation notes：首轮工具固定为 `task.create`、`task.list`、`task.update`、`task.delete`；本切片验收优先关注 `task.create` 与 `task.list`；Slash Command 采用确定性参数格式，并支持 `cron="0 0 8 * * *"` 这类带引号值；自然语言缺少告警范围或时间时，Agent 必须先追问补全，再把简单每日时间表达转换为 6 字段 cron；同一个仓储结果必须同时支撑 `/task` 和自然语言回复，避免两套查询口径；显式任务编排仍优先，但对于未命中显式规则的多语言或自由表达任务请求，允许 runtime agent 调用 `task.*` Tool 兜底。
- acceptance criteria：`/task create` 与 `/task list` 能稳定创建和查询“获取告警信息”定时任务；自然语言创建任务请求和查询任务请求都能映射到对应工具或同一仓储服务；若本轮未完成 update/delete，自然语言与命令链路的 create/list 仍须完整可验。

### TASK-004 与调度器的刷新契约

- goal：在任务持久化成功后，向下游调度器暴露统一刷新契约。
- inputs：需求文档 3.3.5、3.4.2；架构文档 4.4、5.2；数据库文档 4.2。
- outputs：仓储层刷新通知契约、任务变更事件说明。
- dependencies：TASK-001、TASK-002。
- implementation notes：仓储在写回成功后才能触发下游刷新；刷新契约只暴露“任务集合已更新”，由 `specs/35-alarm-scheduler-lifecycle.spec.md` 内的 Scheduler 使用 `node-cron` 重建启用任务；失败写回不得触发调度刷新。
- acceptance criteria：CRUD 成功后调度刷新入口可被调用；写回失败时不会留下内存与持久化不一致的伪成功状态。

## 验收与测试

- 单元验证：任务字段校验、6 字段 `cron` 校验、`alertScope` 必填校验、所有权校验、JSON 写回与重载。
- 集成验证：`/api/tasks` 的 `GET/POST/PATCH` 与任务工具共用同一仓储结果；`/task create`、`/task list` 与自然语言创建/查询都落到同一任务服务。
- 演示验收：通过 `/task create alertScope=当前未处理告警 cron="0 0 8 * * *"` 创建任务后，`/task list` 能查到同一任务；通过自然语言“每天早上 8 点获取当前未处理告警信息”创建任务后，再用自然语言或 `/task list` 都能查到，且任务持久化值为 `0 0 8 * * *`；服务重启后任务仍可从 `src/config/tasks.json` 重载并查询成功。

## 风险与回退

- 风险：JSON 全量写回在单机 Demo 下可行，但后续并发写冲突需要专门治理。
- 风险：自然语言任务请求不完整时，如果追问策略不清会导致工具误创建告警任务，或查询结果与命令口径不一致。
- 回退：若自然语言链路阻塞，先保留 `/task create`、`/task list` 和 `/api/tasks` 的创建/查询闭环，保证“创建并查询告警定时任务”的主验收路径可验证。

## 本轮实现记录

- scope：本轮目标为完成 `TASK-001`、`TASK-002`，并优先补齐 `TASK-003` 中“通过 `/task` 与自然语言创建、查询告警定时任务”的能力；update/delete 与完整执行链路不作为本轮主验收阻塞项。
- decision：`/api/tasks`、`/task` 命令与自然语言任务入口共用同一个 `TaskRepository` 和任务服务；`src/config/tasks.json` 统一切换为告警任务集合；持久化与对外接口统一使用 6 字段 `cron`。
- decision：runtime agent 恢复 `task.create`、`task.list`、`task.update`、`task.delete` 的可见性，用于英文或自由表达下的任务 Tool 兜底；但显式任务编排与 `/task` 命令仍是优先入口，避免影响现有中文规则链路。
- deferred：告警定时任务的实际拉取、主动推送、复杂筛选、手动 `/api/tasks/:taskId/execute`、执行记录详情延后到 `specs/35-alarm-scheduler-lifecycle.spec.md` 及后续切片。
- validation：本轮验证以 `npm run build`、任务仓储/API 创建查询验证、`/task create`/`/task list` 验证、自然语言创建/查询验证为主，确保显式任务编排与 runtime `task.*` 兜底都能落到同一持久化结果。

## 当前实现基线

- 当前 spec 基线要求代码至少具备“获取告警信息”任务模型、`TaskRepository`、当前用户范围内的 `GET/POST/PATCH /api/tasks`、`src/config/tasks.json` 全量写回，以及 `/task create|list` 与自然语言创建/查询的统一语义。
- 下一步进入 `specs/35-alarm-scheduler-lifecycle.spec.md`，补告警定时任务的 scheduler 读取、`node-cron` 注册、刷新契约、执行记录和主动推送闭环。
