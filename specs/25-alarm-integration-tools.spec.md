# 告警域 HTTP Client 与 Tool 封装开发规格

## 目标与边界
- 目标：把告警后端的会话、列表、分析和决策修正能力封装成可供 LangChain Agent 调用的标准化 Tool。
- 范围内：`src/clients/alarm-agent-client.ts`、`src/tools/alarm-tools.ts`、告警接口配置、SSE 聚合、结构化输出与错误模型。
- 范围外：Agent 对话状态机、是否建单确认节点、Dify 工单创建。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/07_LangChain_Agent_告警分析到工单创建_集成开发指导.md` | 1、2、3、4、6、7、9、10、11、12、13、14 | 告警域接口、Tool 设计、SSE 处理、错误模型与最小落地方案 |
| `docs/需求规格说明书.md` | 3.2、4.1、4.2、4.3、5.1、6.1 | Tool Registry、外部调用超时、日志脱敏与技术栈边界 |
| `specs/20-agent-orchestrator.spec.md` | AGT-001、AGT-003 | 统一 Agent 入口与 Tool Registry 接入基线 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| `specs/10-line-message.spec.md` | hard | 提供统一配置加载与应用启动基线 |
| `specs/20-agent-orchestrator.spec.md` | hard | 告警 Tool 最终需要通过统一 Tool Registry 接入 Agent |
| `axios` | hard | 负责告警 HTTP 请求与流式响应读取 |
| `specs/26-alarm-agent-workflow.spec.md` | downstream | Agent 状态机依赖本 spec 的 Tool 契约 |
| `specs/40-api-governance.spec.md` | soft | 错误码、日志与外部服务异常映射需服从治理约束 |

## 任务拆分
### ALARM-001 告警域配置与 HTTP Client 骨架
- goal：建立告警后端的配置解析与统一 HTTP Client。
- inputs：07 文档 3.1、4.1、6.1、10.1、11；需求文档 4.1、4.2、5.1。
- outputs：`src/clients/alarm-agent-client.ts`、`src/config/index.ts` 的告警相关配置、基础请求日志。
- dependencies：`specs/10-line-message.spec.md` 的 LINE-001。
- implementation notes：至少支持 `createSession()`、`listAlarms()`、`processAlarmsSse()`、`getSession()`、`overrideDecision()`；外部调用必须设置超时；不在日志中输出完整 token、完整请求体或原始 SSE 文本。
- acceptance criteria：告警域接口可由单一 Client 调用；超时、网络异常和非 2xx 响应可被统一拦截并结构化返回。

### ALARM-002 `create_alarm_session` 与 `list_alarms` Tool
- goal：先落地稳定、非流式的告警初始化与列表查询能力。
- inputs：07 文档 4.1 的 Tool 1、Tool 2、7.1、7.2、8.3；需求文档 3.2.3、5.1。
- outputs：`create_alarm_session`、`list_alarms` Tool schema 与结构化结果对象。
- dependencies：ALARM-001。
- implementation notes：`list_alarms` 需要把原始响应中的 `data` 归一成 `alarms`；首轮仅保留 Agent 必需字段，例如 `id`、`device_sn`、`site_name`、`alarm_code`、`processing_status`、`created_at`；允许把完整原始响应放入 `raw` 字段备用。
- acceptance criteria：用户请求“查看告警”时，Agent 可以拿到编号化、可读且字段稳定的告警列表。

### ALARM-003 `analyze_alarm` SSE 聚合与分析结果清洗
- goal：把 `POST /api/v1/process_alarms` 的 SSE 响应转成 Agent 可消费的结构化分析结果。
- inputs：07 文档 4.1 的 Tool 3、5.2、6.1、7.3、8、9.2、10.1、14。
- outputs：`analyze_alarm` Tool、SSE 聚合器、`analysis_markdown`/`raw_events`/`should_offer_dispatch` 字段约定。
- dependencies：ALARM-001。
- implementation notes：Tool 层负责消费 SSE、拼接最终 Markdown、保留原始事件数组；不把原始 SSE 直接暴露给 Agent；`should_offer_dispatch` 只做保守提示，无法稳定判断时返回 `null` 而不是误导性布尔值；流式中断时返回 `partial_analysis`。
- acceptance criteria：Agent 可稳定拿到分析文本；SSE 中断时有清晰错误结构；原始事件和最终结论都能被保留用于排障。

### ALARM-004 辅助 Tool 与错误模型补齐
- goal：补齐告警会话查询、人工修正和统一错误语义。
- inputs：07 文档 4.1 的 Tool 5、Tool 6、10.1、14；需求文档 4.3。
- outputs：`get_alarm_session`、`override_alarm_decision` Tool，以及 `alarm_list_failed`、`alarm_analysis_failed` 等错误类型。
- dependencies：ALARM-001、ALARM-002、ALARM-003。
- implementation notes：`get_alarm_session` 和 `override_alarm_decision` 不是首轮主链路必需，但接口层与 Tool 层要预留干净扩展点；错误结构至少包含 `success`、`error_type`、`message`，必要时保留原始响应摘要。
- acceptance criteria：主链路所需的最小 4 个 Tool 可先独立验收；辅助 Tool 加入后不会破坏既有契约。

## 验收与测试
- 单元验证：告警列表字段归一、SSE 事件聚合、分析文本清洗、错误类型映射。
- 集成验证：在配置可用时，`create_alarm_session -> list_alarms -> analyze_alarm` 能连通真实后端。
- 演示验收：用户查询未处理告警后，Agent 能返回编号化列表，并对指定告警输出结构化分析结论。

## 风险与回退
- 风险：SSE 事件格式不稳定时，分析结论提取会受到影响。
- 风险：告警对象字段可能存在多套命名，例如 `device_sn` / `deviceSn` / `externalId`，需要在归一层处理。
- 回退：若 SSE 聚合阻塞，先保留 `list_alarms` 和 mock `analyze_alarm` 输出，验证 Tool Registry 与后续状态机接口。

## 当前实现基线
- 当前仓库尚未落地外部域 HTTP Client，也没有告警 Tool。
- 下一步应先完成 ALARM-001 到 ALARM-003，确保告警查询与分析结果可被 Agent 稳定消费。
