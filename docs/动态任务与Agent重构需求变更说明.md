# 动态任务与Agent重构需求变更说明

## 文档信息

| 项目名称 | LINE Bot 智能消息处理系统 Demo         |
| -------- | -------------------------------------- |
| 文档版本 | V1.0                                   |
| 创建日期 | 2026-03-16                             |
| 文档用途 | 评审增量需求，不替代正式需求规格说明书 |
| 文档状态 | 待评审                                 |

---

## 1. 变更背景

当前 Demo 已具备基础聊天、静态 `tasks.json` 调度和手动执行能力，但仍存在以下问题：

- 消息主链路仍以“Webhook 直连 LLM 回复”为核心，不是统一 Agent 入口
- 工具调用缺少标准化抽象，难以继续扩展
- 任务仍以静态配置为主，无法由用户在运行时直接管理
- `/chat`、`/api/tasks` 与 LINE Webhook 的能力边界不够统一

因此，本轮先补齐文档基线，为后续按新边界拆分 spec 和实现做准备。

---

## 2. 本次增量变化

### 2.1 统一 Agent 入口

- 消息处理从“直接 LLM 回复”改为“统一 Agent 入口处理所有用户消息”。
- `POST /webhook` 与 `POST /chat` 复用同一 Agent 流程。
- Agent 路径采用 LangChain 官方 `createAgent()`。

### 2.2 工具标准化封装

- 新增 Tool Registry 设计，所有工具都必须标准化注册。
- 首批工具组固定为：
  - 任务管理工具：`task.create`、`task.list`、`task.update`、`task.delete`
  - 搜索工具：`search.tavily`
- 第三方工具调用由 Agent 自动决策。

### 2.3 动态任务管理

- 任务从“静态 JSON 配置”升级为“静态种子 + 运行时动态 CRUD + JSON 持久化回写”。
- 动态任务仅支持“每日天气推送”。
- 任务仅归当前用户所有，推送目标固定为当前用户本人。
- 任务调度固定为“每天一次”，按服务器时区解释执行时间。

### 2.4 双轨交互方式

- 自然语言为主路径。
- 保留显式命令备用路径：
  - `/task create`
  - `/task list`
  - `/task update`
  - `/task delete`

---

## 3. 已锁定取舍

| 主题       | 结论                                            |
| ---------- | ----------------------------------------------- |
| 任务类型   | 仅支持 `daily_weather`                          |
| 任务范围   | 完整 CRUD                                       |
| 交互模式   | 自然语言为主，`/task` 命令为备用                |
| 任务归属   | 仅当前用户管理自己的任务                        |
| 推送目标   | 固定为任务所属用户本人                          |
| 调度语义   | 每天一次，服务器时区                            |
| 存储策略   | 运行时内存索引 + `src/config/tasks.json` 持久化 |
| Agent 路线 | LangChain 官方 `createAgent()`                  |
| 搜索集成   | `@langchain/tavily`                             |

---

## 4. 非目标与延期项

- 不支持跨用户代管任务
- 不支持复杂周期、Cron 自定义、批量编排
- 不把任意第三方工具开放成定时任务执行目标
- 不引入 PostgreSQL、Redis 或其他正式数据库
- 不在本轮补完整权限系统、限流、审计和性能专项优化

---

## 5. 评审重点场景

1. 用户发送“每天早上 8 点给我推送北京天气”时，系统应识别为创建任务，而不是普通聊天回复。
2. 用户发送 `/task list`、`/task update`、`/task delete` 时，应具备确定性命令语义，且仅作用于当前用户自己的任务。
3. 用户缺少城市或时间时，Agent 应先追问补全，再创建或修改任务。
4. 用户询问实时外部信息时，Agent 可自动调用 Tavily 搜索工具。
5. 服务重启后，已创建任务可从 `src/config/tasks.json` 重新加载。
6. `/chat` 与 LINE 消息链路必须保持一致，不能出现两套行为逻辑。

---

## 6. 评审问题

请重点确认以下问题：

1. 是否接受 v1 任务类型固定为“每日天气推送”，不开放任意工具调度？
2. 是否接受 v1 调度语义固定为“每天一次 + 服务器时区”？
3. 是否接受运行时任务与静态种子任务共用同一个 `src/config/tasks.json` 文件？
4. 是否接受自然语言与 `/task` 命令双轨并存，而不是只保留一种交互方式？
5. 是否接受 Tavily 作为首批外部搜索工具，而不是后续再补？

---

## 7. Spec 拆分结果

本次评审后已按以下主线完成 spec 拆分：

1. `specs/20-agent-orchestrator.spec.md`
2. `specs/30-task-crud-persistence.spec.md`
3. `specs/35-alarm-scheduler-lifecycle.spec.md`

同时保留并更新：

1. `specs/10-line-message.spec.md`
2. `specs/40-api-governance.spec.md`
3. `specs/00-overall-plan.spec.md`

---

## 8. 参考资料

- LangChain Agents: <https://docs.langchain.com/oss/javascript/langchain/agents>
- LangChain JS install guide: <https://docs.langchain.com/oss/javascript/langchain/install>
- Tavily API Docs: <https://docs.tavily.com/>
- LangChain JS Tavily integration: <https://js.langchain.com/docs/integrations/tools/tavily_search/>
