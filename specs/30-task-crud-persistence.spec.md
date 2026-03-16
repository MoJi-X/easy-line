# 动态任务 CRUD 与 JSON 持久化开发规格

## 目标与边界
- 目标：建立 `daily_weather` 任务模型，支持当前用户范围内的自然语言与 `/task` 命令 CRUD，并把运行时变更持久化回 `src/config/tasks.json`。
- 范围内：`src/services/task-repository.ts`、任务类型定义、任务工具、`src/routes/tasks.ts`、`src/config/tasks.json` 的加载与写回规则。
- 范围外：天气 API 拉取、定时执行、实际消息推送。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/需求规格说明书.md` | 3.3、4.2、5.2、8.1、8.2 | 动态任务、Slash Command、所有权和持久化规则 |
| `docs/architecture/系统架构设计文档.md` | 3.2、4.3、5.2、5.3 | Task Repository、任务 CRUD 流程、管理接口职责 |
| `docs/architecture/数据库设计文档.md` | 1.1、2.2、3、4、5.1 | 任务索引、任务字段、写回流程 |
| `docs/api/API接口设计文档.md` | 1.2、1.3、4、5 | 任务对象、管理接口、Slash Command 语义与错误码 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| `specs/10-line-message.spec.md` | hard | 提供统一配置入口和应用挂载点 |
| `specs/20-agent-orchestrator.spec.md` | hard | 任务工具需要通过 Tool Registry 向 Agent 暴露 |
| `src/config/tasks.json` | hard | 静态种子与运行时任务共用持久化文件 |
| `specs/35-weather-scheduler-lifecycle.spec.md` | downstream | Scheduler 依赖持久化后的任务集合和刷新契约 |
| `specs/40-api-governance.spec.md` | soft | 内部接口返回结构和错误码服从治理规范 |

## 任务拆分
### TASK-001 任务模型与仓储加载规则
- goal：冻结 `daily_weather` 任务模型，并建立 JSON 加载和写回入口。
- inputs：需求文档 3.3.2、3.3.5、7；数据库文档 3、4；架构文档 4.3。
- outputs：`src/services/task-repository.ts`、任务类型定义、`src/config/tasks.json` 读写逻辑。
- dependencies：`specs/10-line-message.spec.md` 的 LINE-001。
- implementation notes：字段至少覆盖 `id`、`type`、`name`、`ownerUserId`、`city`、`dailyTime`、`enabled`、`source`、`createdAt`、`updatedAt`；种子任务与运行时任务共存于同一文件；写回时以完整任务集合覆盖文件内容。
- acceptance criteria：启动时可加载有效任务；无效任务能被识别并记录；写回后的 JSON 结构稳定且可重载。

### TASK-002 所有权校验与 CRUD 服务
- goal：实现当前用户范围内的任务创建、查询、更新、删除。
- inputs：需求文档 3.3.2、3.3.3、5.2；架构文档 4.3、5.2；API 文档 4.2-4.6。
- outputs：任务 CRUD 服务、`src/routes/tasks.ts` 的 `GET/POST/PATCH/DELETE` 接口。
- dependencies：TASK-001。
- implementation notes：所有变更都基于 `userId` 限定当前用户；`dailyTime` 使用 `HH:mm`；不允许自定义 `ownerUserId`、任意 `targets`、自定义 Cron；任务不存在返回 `RESOURCE_NOT_FOUND`，越权返回 `FORBIDDEN_TASK_ACCESS`。
- acceptance criteria：当前用户只能看到并操作自己的任务；创建、更新、删除成功后持久化文件同步更新；错误路径返回可读原因。

### TASK-003 任务工具与 Slash Command 语义
- goal：把任务 CRUD 能力封装成 Agent 工具，并明确 `/task` 命令的确定性语义。
- inputs：需求文档 3.3.1、3.3.4、8.2；API 文档 5。
- outputs：`src/tools/task-tools.ts`、任务工具输入输出契约、Slash Command 解析规则。
- dependencies：TASK-001、TASK-002、`specs/20-agent-orchestrator.spec.md` 的 AGT-003。
- implementation notes：首轮工具固定为 `task.create`、`task.list`、`task.update`、`task.delete`；Slash Command 采用确定性参数格式；自然语言缺少城市或时间时，Agent 必须先追问补全，任务工具只处理补全后的结构化输入。
- acceptance criteria：`/task list`、`/task create`、`/task update`、`/task delete` 语义稳定；自然语言任务请求能映射到对应工具；工具结果可返回给 Agent 生成用户可读回复。

### TASK-004 与调度器的刷新契约
- goal：在任务持久化成功后，向下游调度器暴露统一刷新契约。
- inputs：需求文档 3.3.5、3.4.2；架构文档 4.4、5.2；数据库文档 4.2。
- outputs：仓储层 `reload` 回调或通知契约、任务变更事件说明。
- dependencies：TASK-001、TASK-002。
- implementation notes：仓储在写回成功后才能触发下游刷新；刷新契约只暴露“任务集合已更新”，不在本 spec 内实现天气执行逻辑；失败写回不得触发调度刷新。
- acceptance criteria：CRUD 成功后调度刷新入口可被调用；写回失败时不会留下内存与持久化不一致的伪成功状态。

## 验收与测试
- 单元验证：任务字段校验、`dailyTime` 格式、所有权校验、JSON 写回与重载。
- 集成验证：`/api/tasks` 的 `GET/POST/PATCH/DELETE` 和任务工具共用同一仓储结果。
- 演示验收：自然语言创建任务、`/task list` 列表查询、`/task update` 更新时间、`/task delete` 删除任务后都能在重启后保持一致。

## 风险与回退
- 风险：JSON 全量写回在单机 Demo 下可行，但后续并发写冲突需要专门治理。
- 风险：自然语言任务请求不完整时，如果追问策略不清会导致工具误创建任务。
- 回退：若自然语言链路阻塞，先保留 `/task` 命令和 `/api/tasks` CRUD，保证任务模型与持久化闭环可验证。

## 本轮实现记录
- scope：完成 `TASK-001`、`TASK-002`，并补到 `TASK-003` 的任务工具与确定性 `/task` 命令语义；未实现自然语言任务补全与 scheduler reload。
- decision：`/api/tasks` 与 `/task` 命令共用同一个 `TaskRepository`；`src/config/tasks.json` 已切换为 `daily_weather` 任务集合；本轮启动流程不再自动启动天气 Scheduler，避免旧版调度配置与新任务模型冲突。
- deferred：天气 API 调用、定时执行、手动 `/api/tasks/:taskId/execute`、自然语言任务意图映射与 scheduler reload 延后到 `specs/35-weather-scheduler-lifecycle.spec.md` 及后续切片。
- validation：执行 `npm run build`、`npm run verify:agent`、`npm run verify:tasks`，覆盖编译、现有 Tavily Agent 链路，以及任务仓储/API CRUD/`/task` 命令语义。

## 当前实现基线
- 当前代码已具备 `daily_weather` 任务模型、`TaskRepository`、当前用户范围内的 `GET/POST/PATCH/DELETE /api/tasks`、`src/config/tasks.json` 全量写回，以及 `/task create|list|update|delete` 的确定性语义。
- 下一步进入 `specs/35-weather-scheduler-lifecycle.spec.md`，补 scheduler 读取新任务模型、刷新契约、手动执行和天气推送链路。
