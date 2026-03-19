# 告警分析 Agent 状态机与确认链路开发规格

## 目标与边界
- 目标：在现有统一 Agent 之上增加“查告警 -> 选告警 -> 分析 -> 人机确认”的对话状态机，并保持 `/webhook` 与 `/chat` 行为一致。
- 范围内：`src/services/agent.ts` 的会话状态扩展、告警选择逻辑、确认状态、建单配置可用性检查与提示词约束。
- 范围外：Dify 工单创建的 HTTP 调用与结果解析。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/07_LangChain_Agent_告警分析到工单创建_集成开发指导.md` | 2、3.2、5、6、8、12、13、14 | 主链路执行顺序、确认节点、状态字段、system prompt 约束 |
| `docs/08_Flex_Message构建方案说明.md` | 4.2、4.3 | Flex Message 构建方式选择与降级策略 |
| `docs/08_告警分析与工单创建接入改造方案.md` | 3、4、5、6 | 当前仓库的文件级改造落点与全局建单配置策略 |
| `docs/需求规格说明书.md` | 3.1、3.2、4.1、4.3、5.2 | 统一 Agent 入口、上下文记忆、错误降级与 `/chat` 一致性 |
| `specs/20-agent-orchestrator.spec.md` | AGT-001、AGT-002、AGT-004 | 统一消息入口与用户级会话容器基线 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| `specs/20-agent-orchestrator.spec.md` | hard | 告警工作流建立在统一 Agent 与短期消息记忆之上 |
| `specs/25-alarm-integration-tools.spec.md` | hard | 状态机依赖告警 Tool 的稳定输入输出契约 |
| `specs/26.5-flex-message-builder.spec.md` | hard | 告警分析结果需转换为 Flex Message 展示给用户 |
| `specs/27-workorder-dispatch.spec.md` | downstream | 人机确认后的建单动作由下游 spec 完成 |
| `specs/40-api-governance.spec.md` | soft | `/chat` 入参、错误响应和日志规则需保持一致 |

## 任务拆分
### ALARM-WF-001 用户级会话容器扩展
- goal：把当前只保存消息历史的内存结构扩展为“消息 + 业务状态”的会话容器。
- inputs：07 文档 6.2、8.2；改造方案文档 4.2、4.3；需求文档 3.2.2。
- outputs：`AgentSessionContext` 或等价结构、按 `userId` 隔离的 `alarmWorkflow` 状态。
- dependencies：`specs/20-agent-orchestrator.spec.md` 的 AGT-002。
- implementation notes：至少包含 `alarmSessionId`、`alarmList`、`selectedAlarm`、`lastAnalysisMarkdown`、`pendingConfirmation`、`lastWorkOrderResult`；消息历史仍只保留最近 3 轮；告警工作流状态可与消息历史分开存储，但必须按 `userId` 统一归档；`tenant_id`、`pmms_authorization`、`user` 不写入会话状态。
- acceptance criteria：不同用户的告警状态互不污染；告警状态可在多轮对话中继续复用；消息裁剪规则不受破坏。

### ALARM-WF-002 告警意图路由与选中规则
- goal：让 Agent 能正确处理“看告警”“分析第 N 条告警”“分析这条告警”等意图。
- inputs：07 文档 3.2、8.1、8.3；需求文档 3.1.3、3.2.4。
- outputs：告警选择规则、编号到告警对象的映射逻辑、缺失状态时的追问语义。
- dependencies：ALARM-WF-001、`specs/25-alarm-integration-tools.spec.md` 的 ALARM-002、ALARM-003。
- implementation notes：当用户要求“查看告警”时先调用 `list_alarms`，默认沿用 Tool 的空字符串 `status`；当用户明确要求“查看当前未处理告警”时，必须显式传 `status='Untreated'`；当用户要求“分析第 2 条”时必须先从最近的 `alarmList` 取对应对象；没有候选列表时先提醒用户重新查询；不直接把 `/api/v1/chat` 作为主分析路径。
- acceptance criteria：用户在一次会话内可先看列表再分析指定项；没有上下文时 Agent 不会错误分析空对象或误选告警。

### ALARM-WF-003 人机确认节点与状态清理
- goal：把“是否建单”做成 Agent 确认节点，而不是伪 Tool。
- inputs：07 文档 2、5.1、8.1、8.2、8.3、13；改造方案文档 4.4。
- outputs：`pendingConfirmation` 状态规则、确认/取消/拒绝的回复策略。
- dependencies：ALARM-WF-001、ALARM-WF-002。
- implementation notes：`analyze_alarm` 完成后，Agent 只能发起确认，不能直接建单；用户明确回复“是/确认/建单”后才能进入下游 `create_work_order`；用户回复“否/先不建单/继续观察”时清理 `pendingConfirmation`；确认完成后必须同步清理状态，避免重复建单。
- acceptance criteria：分析后一定经过确认节点；用户未确认时不会触发建单；取消确认后同一条消息不会重复触发待确认动作。

### ALARM-WF-004 建单配置可用性检查与统一提示
- goal：在不引入数据库的前提下，通过全局配置为建单链路提供 `tenant_id`、`pmms_authorization` 和 Dify `user`。
- inputs：07 文档 6.2、8.1、10.2、14；改造方案文档 4.3、5；需求文档 5.2。
- outputs：Agent 侧的建单配置可用性检查规则、缺配置提示语义、与 `/chat`/Webhook 一致的行为约束。
- dependencies：ALARM-WF-001。
- implementation notes：Agent 不负责接收、保存或推导业务上下文；用户确认建单时，运行时只从 `config` 读取 `WORKORDER_TENANT_ID`、`WORKORDER_PMMS_AUTHORIZATION`、`WORKORDER_USER`；`/chat` 继续只承载 `userId` 与 `message`，Webhook 路由仍只负责桥接；缺少配置时必须明确提示“当前未配置全局建单上下文，暂时只能完成告警分析”。
- acceptance criteria：`/chat` 与 LINE Webhook 都能走同一 Agent 工作流；建单前只检查全局配置可用性，不引入额外输入来源；配置缺失时有稳定提示，不会伪造成功结果。

## 验收与测试
- 单元验证：会话状态读写、编号选中规则、待确认状态切换、全局建单配置可用性判断。
- 集成验证：`list_alarms -> analyze_alarm -> wait_user_confirmation` 能在 `/chat` 和 Webhook 两条链路中一致表现。
- 演示验收：用户可以连续完成“查看未处理告警”“分析第 2 条告警”“先别建单/确认建单”等多轮交互。

## 风险与回退
- 风险：当前 Agent 仅有消息记忆，若直接把业务状态与消息数组混写，后续维护会变复杂。
- 风险：确认意图判断过于宽松时，可能造成误建单。
- 回退：先用显式确认短语收敛语义，例如只接受“是，创建工单”“否，先观察”，等主链路稳定后再放宽自然语言识别。

## 本轮实现记录
- scope: 本轮实现 `ALARM-WF-001`、`ALARM-WF-002`、`ALARM-WF-003`、`ALARM-WF-004`，在 `AgentService` 中补齐用户级会话容器、告警意图路由、分析后的确认节点和全局建单配置检查。
- decision: 告警状态机收敛到 `src/services/agent.ts` 的显式编排层，优先拦截“查看告警”“分析第 N 条告警”“确认/取消建单”，其他消息继续走现有 LangChain Agent。
- decision: 告警列表意图不再依赖 `list_alarms` 的隐式默认过滤；只有用户明确要求“未处理告警”时才显式传 `status='Untreated'`，普通“查看告警”保持默认空字符串筛选。
- decision: 会话状态按 `userId` 统一归档为 `messages + alarmWorkflow`，其中仅保存 `alarmSessionId`、`alarmList`、`selectedAlarm`、`lastAnalysisMarkdown`、`pendingConfirmation`、`lastWorkOrderResult`，不落 `tenant_id`、`pmms_authorization`、`user`。
- decision: 用户确认建单时只检查 `config.workorderTenantId`、`config.workorderPmmsAuthorization`、`config.workorderUser`；若任一缺失，固定回复“当前未配置全局建单上下文，暂时只能完成告警分析”，且不伪造建单成功。
- deferred: 真实 `create_work_order` Tool、Dify Workflow Client、字段映射与结果回写已在 `specs/27-workorder-dispatch.spec.md` 落地；本 spec 继续只负责确认节点与全局建单配置检查，不重复下沉建单实现。
- validation: 新增 `src/scripts/verify-alarm-agent-workflow.ts`，通过本地 mock 告警 HTTP/SSE 服务验证 `/chat` 与 Webhook 共用的 `list_alarms -> analyze_alarm -> wait_user_confirmation` 主链路，以及跨用户隔离和缺失全局建单配置时的稳定提示。

## 当前实现基线
- 统一 Agent 已升级为用户级会话容器，消息历史仍只保留最近 3 轮，同时按 `userId` 挂载 `alarmWorkflow` 业务状态。
- “查看当前未处理告警”“分析第 N 条告警”“先不建单”“确认建单”已由 `AgentService` 显式编排，`/chat` 与 LINE Webhook 继续复用同一条消息处理链路。
- 告警分析完成后会进入 `pendingConfirmation=create_work_order` 的确认节点；取消或确认后都会清理状态，避免重复触发建单动作。
- 下游 `specs/27-workorder-dispatch.spec.md` 已完成真实 `create_work_order` 接入；当全局建单配置存在且用户确认后，会继续进入建单 Tool 并回写结构化结果。
