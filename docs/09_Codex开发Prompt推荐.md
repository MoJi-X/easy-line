# Codex 开发 Prompt 推荐

## 1. 使用目的

本文档用于后续和 Codex 协作时，提供一套可直接复制的 Prompt 模板，尽量减少来回补充上下文的成本。

适用范围：

- 继续推进当前 LINE Bot Demo
- 按现有 `specs/*.spec.md` 实现单个可运行切片
- 补齐告警分析到工单创建链路
- 做 review、联调、文档同步和问题排查

## 2. 使用前的固定约束

每次发给 Codex 的 Prompt，建议都明确下面几点：

1. 文档冲突时以 `docs/需求规格说明书.md` 为准。
2. 先维护 spec，再按依赖顺序编码。
3. 一次只推进一个 spec 对应的可运行切片。
4. 不引入数据库、中间件平台或额外高成本抽象。
5. 外部 API 必须有超时、错误处理和日志脱敏。
6. 完成后执行自检、`git status`，并创建一次 commit。

推荐附带的固定说明：

```text
请先阅读 AGENTS.md、docs/需求规格说明书.md、specs/00-overall-plan.spec.md，以及本次点名的 spec 文件。
文档冲突时以 docs/需求规格说明书.md 为准；如果 AGENTS.md 与当前 spec 冲突，请先同步修订 AGENTS.md 再继续。
一次只推进一个可运行切片，完成后请做自检、执行 git status，并创建一次 Conventional Commits 提交。
```

## 3. 当前阶段最推荐的 Prompt

### Prompt 1：先修订 AGENTS 与新 spec 顺序冲突

用途：

- 当前 `AGENTS.md` 里的固定迭代顺序还没有纳入 `25/26/27` 这三个告警/工单 spec
- 在继续编码前，先把协作基线修平

```text
请先处理协作基线冲突，不要直接写业务代码。

目标：
把 AGENTS.md 中的开发流程、固定迭代顺序，与当前 specs/00-overall-plan.spec.md 里新增的告警分析与工单创建链路保持一致。

请执行：
1. 阅读 AGENTS.md、docs/需求规格说明书.md、specs/00-overall-plan.spec.md、docs/08_告警分析与工单创建接入改造方案.md。
2. 找出 AGENTS.md 与当前 spec 的冲突点，尤其是迭代顺序和模块范围。
3. 只修改 AGENTS.md，保持其余文件不动。
4. 完成后说明本次修订消除了哪些冲突。
5. 做自检、执行 git status，并创建一次 commit。

约束：
- 不进入业务代码实现
- 不扩展 spec 范围
- 保持 UTF-8 编码
```

### Prompt 2：实现 `specs/25-alarm-integration-tools.spec.md`

用途：

- 打通告警域 HTTP Client、Tool 封装、SSE 聚合
- 这是告警链路最适合先落地的一个切片

```text
请按 specs/25-alarm-integration-tools.spec.md 实现一个完整可验证切片。

本次只做：
- ALARM-001
- ALARM-002
- ALARM-003

请先阅读：
- AGENTS.md
- docs/需求规格说明书.md
- specs/00-overall-plan.spec.md
- specs/20-agent-orchestrator.spec.md
- specs/25-alarm-integration-tools.spec.md
- docs/08_告警分析与工单创建接入改造方案.md
- docs/07_LangChain_Agent_告警分析到工单创建_集成开发指导.md

实现目标：
1. 在 TypeScript 中新增 alarm HTTP client。
2. 接入 create_alarm_session、list_alarms、analyze_alarm 三个 tool。
3. analyze_alarm 负责消费 SSE，并输出结构化 analysis_markdown，而不是把原始 SSE 直接暴露给 Agent。
4. 外部调用必须设置超时、错误处理和可读日志。

本次不要做：
- Agent 状态机
- 人机确认节点
- create_work_order
- Dify 联调

交付要求：
- 修改必要的 spec 实现记录
- 给出最小验证方式
- 执行自检、git status，并创建一次 commit
```

### Prompt 3：实现 `specs/26-alarm-agent-workflow.spec.md`

用途：

- 在已有 Agent 基础上补告警状态机和确认节点
- 明确只从全局配置检查建单可用性，不做上下文注入

```text
请按 specs/26-alarm-agent-workflow.spec.md 实现一个完整可验证切片。

本次只做：
- ALARM-WF-001
- ALARM-WF-002
- ALARM-WF-003
- ALARM-WF-004

关键约束：
1. Agent 会话状态不能保存 tenant_id、pmms_authorization、user。
2. /chat 继续只承载 userId 和 message，不新增 context。
3. 当用户确认建单时，运行时只从全局 config 检查 WORKORDER_TENANT_ID、WORKORDER_PMMS_AUTHORIZATION、WORKORDER_USER。
4. 如果缺少配置，只能提示“当前未配置全局建单上下文，暂时只能完成告警分析”，不能假装建单成功。

请先阅读：
- AGENTS.md
- docs/需求规格说明书.md
- specs/20-agent-orchestrator.spec.md
- specs/25-alarm-integration-tools.spec.md
- specs/26-alarm-agent-workflow.spec.md
- specs/27-workorder-dispatch.spec.md
- docs/08_告警分析与工单创建接入改造方案.md

本次不要做：
- Dify workorder client
- create_work_order 真正落地

完成后：
- 补充最小回归验证
- 执行自检、git status，并创建一次 commit
```

### Prompt 4：实现 `specs/27-workorder-dispatch.spec.md`

用途：

- 落地建单配置解析、Dify client、`fault_desc` 清洗、mock/live 分支

```text
请按 specs/27-workorder-dispatch.spec.md 实现一个完整可验证切片。

必须遵守的实现口径：
1. tenant_id、pmms_authorization、Dify user 只从全局配置读取。
2. 配置项固定为：
   - WORKORDER_TENANT_ID
   - WORKORDER_PMMS_AUTHORIZATION
   - WORKORDER_USER
   - WORKORDER_WORKFLOW_URL
   - WORKORDER_WORKFLOW_API_KEY
   - WORKORDER_WORKFLOW_TIMEOUT_MS
   - MOCK_CREATE_WORK_ORDER
3. 缺少 WORKORDER_TENANT_ID / WORKORDER_PMMS_AUTHORIZATION / WORKORDER_USER 时，应用可启动，但 create_work_order 必须返回 missing_business_context。
4. create_work_order 不接受 tool 入参覆盖这些字段，也不从 LINE userId 推导。
5. Dify 请求体中的 user 固定取 config.workorderUser。

请先阅读：
- AGENTS.md
- docs/需求规格说明书.md
- specs/26-alarm-agent-workflow.spec.md
- specs/27-workorder-dispatch.spec.md
- docs/08_告警分析与工单创建接入改造方案.md
- docs/07_LangChain_Agent_告警分析到工单创建_集成开发指导.md

输出要求：
- 实现 config 解析、workorder client、tool、错误映射、mock/live 分支
- 给出配置完整与缺配置两种验证结果
- 执行自检、git status，并创建一次 commit
```

## 4. 常用辅助 Prompt

### Prompt 5：只补 spec，不动代码

```text
请不要写代码，只补文档和 spec。

目标：
根据当前实现状态，更新对应 spec 的“本轮实现记录 / 当前实现基线 / 风险与回退 / 延期项”，让 spec 与现状一致。

请先阅读：
- AGENTS.md
- docs/需求规格说明书.md
- specs/00-overall-plan.spec.md
- 本次点名的 spec 文件

要求：
- 不修改业务代码
- 只修正文档与 spec 的事实不一致
- 完成后执行 git status，并创建一次 commit
```

### Prompt 6：请 Codex 做 review

```text
请对当前工作区做一次代码 review，按“发现问题优先”的方式输出。

要求：
1. 先阅读 AGENTS.md、docs/需求规格说明书.md，以及本次相关 spec。
2. 重点检查：
   - 是否偏离 spec
   - 是否引入未批准的复杂度
   - 外部调用是否缺少超时、日志和错误处理
   - 是否泄露敏感配置
   - /chat 与 /webhook 行为是否分叉
3. 先列 findings，按严重程度排序。
4. 每条 finding 要附文件路径和行号。
5. 如果没有发现问题，要明确说明没有发现 findings，并补充剩余风险。
```

### Prompt 7：联调 Dify / 告警后端

```text
请帮我做一次联调与排障，不要先改代码，先定位问题。

联调目标：
- 告警后端接口：new_session / alarms / process_alarms
- 或工单 Dify workflow

请执行：
1. 先阅读相关 spec 和 config 代码。
2. 先检查配置项是否齐全、命名是否一致。
3. 用非破坏方式验证请求路径、超时、响应结构和错误返回。
4. 如果确认需要改代码，再给出最小修复方案并实施。

要求：
- 优先确认真实阻塞点
- 说明是配置问题、接口问题、字段映射问题，还是 SSE / Dify 返回结构问题
- 完成后给出下一步建议
```

### Prompt 8：生成回归测试清单

```text
请不要直接写业务代码，先基于当前 spec 和实现，生成一份最小回归测试清单。

请覆盖：
- /webhook 与 /chat 主链路一致性
- alarm tools
- 人机确认节点
- create_work_order 的缺配置阻断
- mock/live 建单分支
- 错误码与日志脱敏

输出格式：
- 按 spec 编号分组
- 每条用“前置条件 / 操作 / 预期结果”描述
```

## 5. 推荐的提问方式

为了让 Codex 更稳，建议你在 Prompt 里补这些信息：

- 这次只做哪个 spec、哪个 task 编号
- 哪些文件可以改，哪些不要动
- 这次是否允许改 `AGENTS.md`
- 是“先补 spec”还是“直接实现代码”
- 是否要求 commit

最稳妥的表达模板：

```text
请按 [spec 文件名] 实现 [task 编号]，只推进这一轮可运行切片。
先阅读 AGENTS.md、docs/需求规格说明书.md、specs/00-overall-plan.spec.md 和本次点名的 spec。
文档冲突时以 docs/需求规格说明书.md 为准；如果 AGENTS.md 与当前 spec 冲突，请先同步修订 AGENTS.md。
不要扩展范围，不要引入数据库或复杂中间件。
完成后请做自检、执行 git status，并创建一次 Conventional Commits 提交。
```

## 6. 当前最建议的下一步

如果要继续推进当前仓库，推荐优先级如下：

1. 先用 Prompt 1 修正 `AGENTS.md` 与新增告警/工单 spec 的顺序冲突。
2. 再用 Prompt 2 落地 `specs/25-alarm-integration-tools.spec.md`。
3. 然后用 Prompt 3 落地 `specs/26-alarm-agent-workflow.spec.md`。
4. 最后用 Prompt 4 落地 `specs/27-workorder-dispatch.spec.md`。

这样最符合当前文档基线，也最容易保持一次一个可运行切片。
