# 工单创建与派单结果回写开发规格

## 目标与边界
- 目标：在用户完成确认后，基于选中的告警对象和分析摘要创建工单，并将结果结构化回写到 Agent 会话中。
- 范围内：`src/clients/workorder-client.ts`、`src/tools/workorder-tools.ts`、建单入参映射、`fault_desc` 清洗、mock/live 切换、结果归一与错误模型。
- 范围外：告警列表查询、SSE 分析聚合、天气任务调度。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/07_LangChain_Agent_告警分析到工单创建_集成开发指导.md` | 3.1、4.1 Tool 4、6、7.4、8、9、10.2、11、12.2、12.4、13、14 | 工单创建接口、字段映射、上下文校验、mock 建议与最小落地路径 |
| `docs/08_告警分析与工单创建接入改造方案.md` | 4.3、4.4、5、6、7、8 | 全局建单配置来源、摘要清洗和实施顺序 |
| `docs/需求规格说明书.md` | 3.2、4.1、4.2、4.3、5.1 | Tool 扩展、超时、日志脱敏与外部服务边界 |
| `specs/26-alarm-agent-workflow.spec.md` | ALARM-WF-003、ALARM-WF-004 | 建单前确认状态与全局建单配置来源 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| `specs/25-alarm-integration-tools.spec.md` | hard | 建单请求需要复用选中的告警对象与分析结果 |
| `specs/26-alarm-agent-workflow.spec.md` | hard | 只有确认节点通过后才允许进入建单动作 |
| `axios` | hard | 调用 Dify Workflow API |
| `specs/40-api-governance.spec.md` | soft | 错误模型、日志脱敏与 mock 标识需保持一致 |

## 任务拆分
### WORKORDER-001 工单 Client 与配置约束
- goal：建立 Dify Workflow 的统一 Client、配置和超时控制。
- inputs：07 文档 3.1、4.1 Tool 4、10.2、11；改造方案文档 5。
- outputs：`src/clients/workorder-client.ts`、工单相关配置解析、外部调用日志。
- dependencies：`specs/10-line-message.spec.md` 的 LINE-001。
- implementation notes：至少支持阻塞式 `runWorkflow()`；`src/config/index.ts` 负责解析 `WORKORDER_TENANT_ID`、`WORKORDER_PMMS_AUTHORIZATION`、`WORKORDER_USER`、`WORKORDER_WORKFLOW_URL`、`WORKORDER_WORKFLOW_API_KEY`、`WORKORDER_WORKFLOW_TIMEOUT_MS`、`MOCK_CREATE_WORK_ORDER`；外部调用必须设置超时；日志只保留状态码、请求 ID、字段摘要，不输出完整 token；Dify 请求体中的 `user` 固定取 `config.workorderUser`。
- acceptance criteria：真实建单调用可由单一 Client 发起；网络异常、超时和 Dify 非 2xx 响应可被统一包装。

### WORKORDER-002 告警到工单的字段映射与 `fault_desc` 清洗
- goal：把告警对象和分析结果转换为 Dify Workflow 所需输入。
- inputs：07 文档 9.1、9.2、12.2、14；改造方案文档 4.4。
- outputs：告警字段归一规则、`fault_desc` 摘要生成器、Dify `inputs` 映射函数。
- dependencies：WORKORDER-001、`specs/25-alarm-integration-tools.spec.md` 的 ALARM-003。
- implementation notes：优先映射 `device_type`、`device_sn`、`alarm_id`、`alarm_category`、`alarm_type`、`alarm_type_name`、`fault_code`、`site_name`；其中 `device_sn` 需优先从 `alarm.raw_data.externalId` / `alarm.raw_data.external_id` 回填，`site_name`、`alarm_type`、`alarm_type_name` 需优先从 `alarm.raw_data` 中同名字段或 camelCase 字段回填，顶层字段作为回退；`fault_desc` 只保留告警对象、核心结论、建议动作和重要原因，长度控制在 100 到 400 字；缺省字段允许按 Demo 规则降级，例如 `device_type` 缺省为 `inverter`。
- acceptance criteria：建单输入结构与 Dify 接口要求一致；超长 Markdown 不会原样透传到工作流。

### WORKORDER-003 `create_work_order` Tool、配置校验与 mock/live 切换
- goal：在 Tool 层完成全局建单配置校验，并支持 Dify 不可达时的 Demo 兜底。
- inputs：07 文档 7.4、8.1、10.2、11、13、14；改造方案文档 4.3、5、8。
- outputs：`create_work_order` Tool、`missing_business_context` 等错误类型、`MOCK_CREATE_WORK_ORDER` 开关语义。
- dependencies：WORKORDER-001、WORKORDER-002、`specs/26-alarm-agent-workflow.spec.md` 的 ALARM-WF-003、ALARM-WF-004。
- implementation notes：建单前必须同时校验 `pendingConfirmation === create_work_order`、`config.workorderTenantId` 已存在、`config.workorderPmmsAuthorization` 已存在、`config.workorderUser` 已存在；`create_work_order` 只从全局配置读取这 3 个字段，不接受 Tool 入参覆盖，也不从 LINE `userId` 推导；缺配置时沿用 `missing_business_context` 错误语义，并固定提示“缺少全局建单配置”；mock 模式返回的数据结构必须显式标记 `mock: true`，避免被误认为真实业务建单；live 模式调用 Dify 时，`tenant_id`、`pmms_authorization`、`user` 全部来自全局配置；如果 Dify 返回异常，需要保留状态码、原始响应摘要和解析失败信息。
- acceptance criteria：未确认或缺少全局建单配置时一定阻断建单；mock/live 返回结构保持兼容；Dify 请求中的 `tenant_id`、`pmms_authorization`、`user` 全部来自全局配置；错误信息足以定位失败原因。

### WORKORDER-004 建单结果回写与用户可读回复
- goal：把成功或失败的建单结果写回 Agent 会话，并生成适合用户阅读的结果摘要。
- inputs：07 文档 8.3、10.2、13；改造方案文档 7。
- outputs：`lastWorkOrderResult` 写回规则、建单成功/失败的统一结果对象、用户结果摘要模板。
- dependencies：WORKORDER-003。
- implementation notes：成功结果至少返回 `workflow_run_id`、`work_order_id`、`work_order_no`、`title`、`level`、`status`、`assignee`、`acceptor`、`start_time`、`end_time`；成功或失败后都要清理 `pendingConfirmation`；成功时把结构化结果写回会话，失败时把错误摘要写回日志与上下文。
- acceptance criteria：用户确认后能收到清晰的建单结果；建单完成后不会因为旧的确认状态重复触发第二次建单。

## 验收与测试
- 单元验证：字段归一、`fault_desc` 长度控制、缺少全局建单配置的阻断、mock/live 分支。
- 集成验证：在真实配置可用时，`analyze_alarm -> confirm -> create_work_order` 能闭环执行。
- 演示验收：用户确认建单后，Agent 能返回工单编号、标题、等级、负责人和时间窗口；Dify 不可达时可切换到显式 mock 模式继续演示。

## 风险与回退
- 风险：Dify Workflow 入参格式或返回字段不稳定，会导致结果解析脆弱。
- 风险：`pmms_authorization` 的真实格式若与当前文档不一致，需要额外联调。
- 回退：若 live 建单迟迟不可用，先保留真实告警分析 + 显式 mock 建单，确保整条对话链路可演示。

## 当前实现基线
- 当前仓库已接入 `src/clients/workorder-client.ts`、`src/tools/workorder-tools.ts`、全局建单配置解析、mock/live 切换和结果归一。
- `AgentService` 已在确认节点通过后调用 `create_work_order`，并把成功/失败结果写回 `lastWorkOrderResult`。
- 验证脚本已覆盖缺配置阻断、mock 分支和本地 Dify stub 的 live 分支。

## 本轮实现口径
- 仅实现 `specs/27-workorder-dispatch.spec.md` 的工单配置、Client、Tool、mock/live 切换、结果回写和验证，不混入任务 CRUD、天气调度等其他模块。
- `tenant_id`、`pmms_authorization`、Dify `user` 统一只从全局配置读取；`create_work_order` 不接收这些字段的 Tool 入参覆盖，也不从 LINE `userId` 推导。
- 应用启动阶段允许缺少 `WORKORDER_TENANT_ID`、`WORKORDER_PMMS_AUTHORIZATION`、`WORKORDER_USER`，但 `create_work_order` 必须稳定返回 `missing_business_context`，且不能影响告警查询与分析链路。

## 本轮实现记录
- scope: 本轮完成 `WORKORDER-001`、`WORKORDER-002`、`WORKORDER-003`、`WORKORDER-004`，落地全局建单配置、Dify Workflow Client、字段映射、`fault_desc` 清洗、mock/live 分支、Agent 结果回写与验证脚本。
- decision: `create_work_order` Tool 的输入只保留 `alarm` 和 `analysis_markdown`；`tenant_id`、`pmms_authorization`、`user` 统一从 `config` 读取，Dify 请求体中的 `user` 固定取 `config.workorderUser`。
- decision: `fault_desc` 通过“告警上下文 + 清洗后的分析摘要 + 补充建议”生成，并强制截断在 100 到 400 字，避免把长 Markdown 原样透传到工作流。
- decision: 缺少 `WORKORDER_TENANT_ID`、`WORKORDER_PMMS_AUTHORIZATION`、`WORKORDER_USER` 时，应用仍允许启动；Tool 直接返回 `missing_business_context`，Agent 侧保持固定用户提示“当前未配置全局建单上下文，暂时只能完成告警分析”。
- deferred: Dify 真实联调字段稳定性、正式环境下的 `pmms_authorization` 格式约束和更细的业务错误码继续保留为后续联调项，本轮仅保证 Demo 必需级别的错误映射与验证闭环。
- validation: 新增 `src/scripts/verify-workorder-dispatch.ts`，覆盖 `create_work_order` 缺配置阻断、mock 成功返回、live 请求体字段映射、`fault_desc` 长度约束以及 Agent 确认后建单成功回写。
