# LangChain Agent 集成开发指导

## 1. 目标

本文面向“现有 LangChain Agent 系统”集成当前项目的告警分析与工单创建能力，目标是把现有接口以 `tools` 的方式纳入框架，打通下面这条主链路：

1. 获取告警列表
2. 对话要求对获取到的告警进行分析
3. 根据分析结果，询问是否派单
4. 对话创建工单创建任务
5. 返回创建工单结果

本文只基于当前仓库已确认接口与现有接入文档，不假设额外中台能力。

## 2. 结论先行

对接这条链路，建议最少接入 4 类能力：

- `create_alarm_session`
- `list_alarms`
- `analyze_alarm`
- `create_work_order`

另外建议补 2 个辅助能力：

- `get_alarm_session`
- `override_alarm_decision`

其中第 3 步“询问是否派单”不建议做成真实后端 tool，而建议作为 LangChain agent 的人机确认节点：

- 由 agent 读取分析结果
- 生成结构化确认问题
- 等待用户明确回答“是/否”
- 用户确认后再调用 `create_work_order`

这样最稳，也最符合当前演示主链路。

## 3. 现有接口与流程映射

## 3.1 当前真实接口来源

当前链路并不是全部来自同一个服务：

- 告警列表、会话、告警分析、人工修正：当前 FastAPI 服务
- 工单创建：外部 Dify Workflow API

对应接口如下：

| 流程步骤 | 能力 | 实际接口 |
|------|------|------|
| 1 | 获取告警列表 | `GET /api/v1/alarms` |
| 2 | 告警分析 | `POST /api/v1/process_alarms` |
| 2-补充 | 会话初始化 | `POST /api/v1/new_session` |
| 3 | 是否派单确认 | 建议由 agent 自己完成，不走后端接口 |
| 4 | 创建工单 | `POST http://192.168.100.225:8088/v1/workflows/run` |
| 5 | 返回工单结果 | 解析 Dify Workflow 返回结果 |

补充辅助接口：

| 用途 | 接口 |
|------|------|
| 查询会话状态 | `GET /api/v1/session/{session_id}` |
| 人工修正 AI 决策 | `POST /api/v1/decision/override` |

## 3.2 推荐调用顺序

建议在 LangChain 里固定成下面的执行顺序：

1. 首次进入告警链路时调用 `create_alarm_session`
2. 调用 `list_alarms`
3. 让 agent 从用户表达中识别要分析的告警
4. 调用 `analyze_alarm`
5. agent 总结分析结果，并追问“是否创建工单”
6. 用户明确同意后，调用 `create_work_order`
7. agent 返回结构化工单结果

## 4. Tool 设计建议

## 4.1 推荐的 Tool 清单

### Tool 1: `create_alarm_session`

用途：

- 创建一次告警分析会话
- 为后续 `analyze_alarm` 提供 `session_id`

后端接口：

- `POST /api/v1/new_session`

输入建议：

```json
{}
```

输出建议：

```json
{
  "session_id": "uuid"
}
```

### Tool 2: `list_alarms`

用途：

- 获取当前告警列表
- 给 agent 提供候选告警集

后端接口：

- `GET /api/v1/alarms`

输入建议：

```json
{
  "status": "",
  "page": 1,
  "page_size": 20
}
```

补充说明：

- `status` 默认传空字符串，表示不过滤处理状态。
- 只有当用户明确要求“查看当前未处理告警”时，才显式传 `status="Untreated"`。

输出建议：

```json
{
  "total": 2,
  "page": 1,
  "page_size": 20,
  "alarms": [
    {
      "id": 101,
      "device_sn": "INV-0001",
      "site_name": "Bangkok PV Site",
      "alarm_code": "130",
      "processing_status": "Untreated",
      "created_at": "2026-03-16 09:20:00"
    }
  ]
}
```

封装建议：

- 在 tool 层把接口原始返回的 `data` 改名成 `alarms`
- 只保留 agent 必须用的核心字段
- 原始完整响应可放在 `raw` 字段里备用

### Tool 3: `analyze_alarm`

用途：

- 对指定告警执行流式分析
- 输出面向 agent 的结构化分析结论

后端接口：

- `POST /api/v1/process_alarms`

输入建议：

```json
{
  "session_id": "uuid",
  "alarm": {
    "id": 101,
    "device_sn": "INV-0001",
    "deviceName": "Inverter-1",
    "siteName": "Bangkok PV Site",
    "alarmType": "Offline",
    "alarmTypeName": "Device Offline",
    "alarmTime": "2026-03-16 09:20:00",
    "currentStatus": "InAlarm",
    "processingStatus": "Untreated"
  },
  "mode": "standard",
  "business_type": "device_alarm",
  "force_reanalyze": false,
  "language": "zh"
}
```

输出建议：

```json
{
  "session_id": "uuid",
  "analysis_markdown": "### 分析结论\n...",
  "should_offer_dispatch": true,
  "recommended_action_hint": "create_work_order",
  "raw_events": []
}
```

关键说明：

- 后端实际返回是 SSE，不是普通 JSON
- Tool 封装层需要负责消费 SSE，并拼接出最终 `analysis_markdown`
- 不建议把原始 SSE 直接暴露给 LangChain agent

关于 `should_offer_dispatch`：

- 这是 tool 封装层的辅助字段，不是后端原始字段
- 建议根据分析文本做保守提取
- 例如命中“派单 / 工单 / dispatch / work order”时返回 `true`
- 如果判断不稳，宁可返回 `null`，由 agent 自己决定是否发起确认

### Tool 4: `create_work_order`

用途：

- 结合当前告警与分析结果，创建工单

后端接口：

- `POST http://192.168.100.225:8088/v1/workflows/run`

当前接入方式：

- Dify Workflow API

输入建议：

```json
{
  "tenant_id": "123456",
  "pmms_authorization": "token",
  "alarm": {
    "id": "A20260311001",
    "device_sn": "SN123456",
    "device_type": "inverter",
    "site_name": "XX PV Site",
    "alarm_category": "AlarmWorkOrder",
    "alarm_type": "ArcFail",
    "alarm_type_name": "Arc Fault",
    "fault_code": 1001
  },
  "analysis_markdown": "设备离线超过 4 小时，建议派单排查",
  "user": "langchain-agent"
}
```

Tool 内部应转换成 Dify 请求：

```json
{
  "inputs": {
    "tenant_id": "123456",
    "device_type": "inverter",
    "device_sn": "SN123456",
    "alarm_id": "A20260311001",
    "alarm_category": "AlarmWorkOrder",
    "alarm_type": "ArcFail",
    "alarm_type_name": "Arc Fault",
    "fault_code": 1001,
    "fault_desc": "设备离线超过 4 小时，建议派单排查",
    "site_name": "XX PV Site",
    "pmms_authorization": "token"
  },
  "response_mode": "blocking",
  "user": "langchain-agent"
}
```

输出建议：

```json
{
  "success": true,
  "workflow_run_id": "xxx",
  "work_order_id": "WO20260311008",
  "work_order_no": "GD-20260311-008",
  "title": "XX站点逆变器故障处理",
  "level": "HIGH",
  "status": "created",
  "assignee": "iRunDo",
  "acceptor": "iRunDo",
  "description": "根据告警分析自动建单",
  "start_time": "2026-03-12 11:25:38",
  "end_time": "2026-03-19 11:25:38",
  "raw": {}
}
```

### Tool 5: `get_alarm_session`

用途：

- 查询当前会话是否有效
- 方便 agent 在长对话中做恢复

后端接口：

- `GET /api/v1/session/{session_id}`

### Tool 6: `override_alarm_decision`

用途：

- 如果用户明确要求“改成观察 / 改成派单 / 改成关闭”
- 可把人工判断回写到当前系统

后端接口：

- `POST /api/v1/decision/override`

说明：

- 这不是主链路必需 tool
- 但如果 LangChain 系统想保留“人工二次决策”，这个 tool 很有价值

## 5. 哪些步骤不建议做成后端 Tool

## 5.1 “是否派单”不要做成真实执行型 tool

你的第 3 步本质上是一个“人机确认节点”，不是真正的数据服务。

因此不建议设计成：

- `ask_if_dispatch_tool`

更推荐这样处理：

- `analyze_alarm` 返回分析结论
- agent 根据分析结果组织一句确认话术
- 将状态写入对话上下文，例如 `pending_confirmation=create_work_order`
- 等用户明确回复“是，建单”后，再调用 `create_work_order`

这样可以避免：

- agent 在没有用户确认时误建工单
- tool 语义不清，既不查数也不执行，只负责发问

## 5.2 不建议直接用 `POST /api/v1/chat` 替代主分析 tool

虽然当前系统有 `/api/v1/chat`，但对于你这条主链路不建议把它当成核心 tool：

- 主链路已经有更明确的 `process_alarms`
- `chat` 更像开放式问答入口
- 工程上更难做稳定结构化输出

建议：

- 主链路分析优先使用 `analyze_alarm -> /api/v1/process_alarms`
- `/api/v1/chat` 只作为扩展问答能力，不作为闭环主入口

## 6. LangChain 中的职责拆分

## 6.1 推荐架构

建议把能力分成三层：

### 第一层：HTTP Client 层

职责：

- 发起真实 HTTP 请求
- 处理鉴权、超时、重试
- 处理 SSE
- 返回原始结果

示例模块：

- `alarm_agent_client.py`
- `workorder_client.py`

### 第二层：Tool 封装层

职责：

- 对 HTTP 层做参数清洗
- 统一输入输出 schema
- 生成适合 LangChain 使用的结构化结果

示例模块：

- `tools/alarm_tools.py`
- `tools/workorder_tools.py`

### 第三层：Agent 编排层

职责：

- 决定什么时候查告警
- 决定分析哪一条
- 决定何时发起用户确认
- 在确认后调用工单创建 tool

## 6.2 推荐状态字段

建议在 agent state 中维护以下字段：

| 字段 | 说明 |
|------|------|
| `alarm_session_id` | 当前告警分析会话 ID |
| `alarm_list` | 最近一次查询到的告警列表 |
| `selected_alarm` | 当前选中的告警 |
| `last_analysis_markdown` | 最近一次分析结果 |
| `pending_confirmation` | 当前等待用户确认的动作 |
| `last_work_order_result` | 最近一次建单结果 |
| `tenant_id` | 业务租户 ID |
| `pmms_authorization` | 业务 token |

## 7. 推荐 Tool Schema

下面给出一份适合 LangChain 的 tool schema 设计建议。

## 7.1 `create_alarm_session`

```python
{
  "name": "create_alarm_session",
  "description": "Create a session for alarm analysis workflow.",
  "args_schema": {
    "type": "object",
    "properties": {},
    "additionalProperties": False
  }
}
```

## 7.2 `list_alarms`

```python
{
  "name": "list_alarms",
  "description": "List current alarms from the alarm agent backend.",
  "args_schema": {
    "type": "object",
    "properties": {
      "status": {"type": "string", "default": ""},
      "page": {"type": "integer", "default": 1},
      "page_size": {"type": "integer", "default": 20}
    },
    "additionalProperties": False
  }
}
```

## 7.3 `analyze_alarm`

```python
{
  "name": "analyze_alarm",
  "description": "Analyze a specific alarm and return structured analysis text.",
  "args_schema": {
    "type": "object",
    "properties": {
      "session_id": {"type": "string"},
      "alarm": {"type": "object"},
      "mode": {"type": "string", "default": "standard"},
      "business_type": {"type": "string", "default": "device_alarm"},
      "force_reanalyze": {"type": "boolean", "default": False},
      "language": {"type": "string", "default": "zh"}
    },
    "required": ["session_id", "alarm"],
    "additionalProperties": False
  }
}
```

## 7.4 `create_work_order`

```python
{
  "name": "create_work_order",
  "description": "Create a work order from the selected alarm and analysis result.",
  "args_schema": {
    "type": "object",
    "properties": {
      "tenant_id": {"type": "string"},
      "pmms_authorization": {"type": "string"},
      "alarm": {"type": "object"},
      "analysis_markdown": {"type": "string"},
      "user": {"type": "string", "default": "langchain-agent"}
    },
    "required": ["tenant_id", "pmms_authorization", "alarm", "analysis_markdown"],
    "additionalProperties": False
  }
}
```

## 8. 工具调用策略

## 8.1 建议的 system prompt 约束

建议给 LangChain agent 加上下面几条硬约束：

1. 当用户要求“查看告警”时，先调用 `list_alarms`
2. 当用户要求“分析某条告警”时，必须先确认或选定 `selected_alarm`
3. 当分析完成后，不能直接创建工单，必须先询问用户是否派单
4. 只有在用户明确确认后，才能调用 `create_work_order`
5. 如果缺少 `tenant_id` 或 `pmms_authorization`，禁止建单，并明确告知缺少业务上下文

## 8.2 推荐对话状态机

```text
START
  -> list_alarms
  -> select_alarm
  -> analyze_alarm
  -> wait_user_confirmation
  -> create_work_order
  -> return_work_order_result
END
```

## 8.3 典型对话示例

### 用户说：查看当前未处理告警

agent 行为：

1. 调用 `list_alarms(status="Untreated")`
2. 返回编号化列表
3. 引导用户指定分析对象

### 用户说：分析第 2 条告警

agent 行为：

1. 从 state 中取第 2 条告警
2. 若没有 `alarm_session_id`，先调用 `create_alarm_session`
3. 调用 `analyze_alarm`
4. 总结分析结论
5. 询问“是否创建工单”

### 用户说：是，创建工单

agent 行为：

1. 校验 `pending_confirmation == create_work_order`
2. 校验 `tenant_id` 和 `pmms_authorization` 是否存在
3. 调用 `create_work_order`
4. 返回工单编号、标题、等级、负责人、时间窗口等核心字段

## 9. 入参映射建议

## 9.1 从告警对象映射到工单 tool 入参

建议映射如下：

| 工单字段 | 来源 |
|------|------|
| `tenant_id` | 上下文透传 |
| `pmms_authorization` | 上下文透传 |
| `device_type` | `alarm.device_type`，缺省可降级为 `inverter` |
| `device_sn` | `alarm.device_sn` / `alarm.deviceSn` / `alarm.externalId` |
| `alarm_id` | `alarm.id` |
| `alarm_category` | 结合 `alarm.alarmCategory` 或按规则归一 |
| `alarm_type` | `alarm.alarmType` |
| `alarm_type_name` | `alarm.alarmTypeName` |
| `fault_code` | `alarm.alarm_code` 或等价字段 |
| `fault_desc` | `analysis_markdown` 清洗后的摘要 |
| `site_name` | `alarm.siteName` / `alarm.station_name` |

## 9.2 `fault_desc` 的生成建议

不要把超长原始 Markdown 直接塞给工单工作流。

建议先清洗成一段 100 到 400 字以内的摘要，保留：

- 告警对象
- 核心结论
- 建议动作
- 重要原因

例如：

```text
设备 INV-0001 于 2026-03-16 09:20 发生离线告警，当前状态仍未恢复。结合告警类型与持续时间，建议派单排查通信链路、电源状态和数据采集设备。
```

## 10. 错误处理建议

## 10.1 告警接口

### `list_alarms`

失败时建议统一返回：

```json
{
  "success": false,
  "error_type": "alarm_list_failed",
  "message": "Failed to fetch alarms."
}
```

### `analyze_alarm`

如果 SSE 中途失败，建议返回：

```json
{
  "success": false,
  "error_type": "alarm_analysis_failed",
  "message": "Alarm analysis stream failed.",
  "partial_analysis": "..."
}
```

## 10.2 工单接口

### 缺少业务上下文

如果缺少 `tenant_id` 或 `pmms_authorization`，直接在 tool 层拦截：

```json
{
  "success": false,
  "error_type": "missing_business_context",
  "message": "tenant_id or pmms_authorization is missing."
}
```

### Dify 返回失败

如果 Dify 返回异常，建议完整保留：

- HTTP 状态码
- 原始响应
- 解析失败信息

不要只返回“创建失败”。

## 11. Live / Mock 建议

当前链路状态建议明确区分：

- 告警列表与告警分析：当前仓库内 live 接口
- 工单创建：外部 Dify Workflow，当前为 live 接入配置

如果 LangChain 环境中暂时无法访问工单 Dify，可以加一个 `mock_create_work_order` 开关，但必须让上层响应明确写出：

- 当前结果来自 mock
- 非真实业务建单

## 12. 推荐实现骨架

下面给一份推荐目录结构：

```text
langchain_app/
  clients/
    alarm_agent_client.py
    workorder_client.py
  tools/
    alarm_tools.py
    workorder_tools.py
  agents/
    alarm_workflow_agent.py
  state/
    alarm_state.py
```

## 12.1 `alarm_agent_client.py`

职责：

- `create_session()`
- `list_alarms()`
- `process_alarms_sse()`
- `get_session()`
- `override_decision()`

## 12.2 `workorder_client.py`

职责：

- `create_work_order_via_dify()`

## 12.3 `alarm_tools.py`

职责：

- 暴露 `create_alarm_session`
- 暴露 `list_alarms`
- 暴露 `analyze_alarm`
- 暴露 `get_alarm_session`
- 暴露 `override_alarm_decision`

## 12.4 `workorder_tools.py`

职责：

- 暴露 `create_work_order`

## 13. 最小可落地方案

如果你现在时间紧，建议先只做下面 4 个 tool：

1. `create_alarm_session`
2. `list_alarms`
3. `analyze_alarm`
4. `create_work_order`

然后在 agent 层手工加一条确认逻辑：

- 分析完成后，固定输出“是否需要为这条告警创建工单？”
- 用户确认后再建单

这样就已经能完整覆盖你现在要的 5 步闭环。

## 14. 当前共识与风险

### 已确认共识

- 告警分析主入口应优先走 `POST /api/v1/process_alarms`
- 工单创建应走外部 Dify Workflow
- `fault_desc` 应由告警分析结果清洗后传入工单工作流
- `tenant_id` 与 `pmms_authorization` 必须透传

### 已实现状态

- 告警列表接口已在当前项目中提供
- 告警分析接口已在当前项目中提供，且为 SSE
- 工单工作流接入信息已存在于现有文档
- 前端工作台已证明这条链路可跑通

### 当前阻塞点

- 工单 Dify 在 LangChain 环境里是否可直连
- 工单 workflow 内部对 `pmms_authorization` 的格式要求是否完全稳定
- SSE 分析结果如何在 tool 层清洗成稳定结构

### 下一步最值得做的事

先在 LangChain 项目里落 4 个最小 tool，并优先打通：

`list_alarms -> analyze_alarm -> 人工确认 -> create_work_order`
