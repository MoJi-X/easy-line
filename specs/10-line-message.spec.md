# LINE 启动与消息桥接开发规格

## 目标与边界
- 目标：完成 Express 启动、LINE Webhook 接收、签名校验、文本事件提取和统一消息桥接接口。
- 范围内：`src/index.ts`、`src/config/index.ts`、`src/routes/webhook.ts`、`src/services/line.ts`、基础 `/health`。
- 范围外：Agent 推理、Tavily 搜索、任务 CRUD、天气调度执行。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/需求规格说明书.md` | 3.1、4.2、5.1、5.2、6.1、7、8.1、9.1 | 权威消息链路需求、接口、技术选型、验收与环境配置 |
| `docs/architecture/系统架构设计文档.md` | 3.1、3.2、4.1、6、7 | 主链路、LineService、路由职责与健康检查 |
| `docs/api/API接口设计文档.md` | 2.1、2.2、6.1 | Webhook 约束、文本消息处理约束、健康检查 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| 环境变量加载 | hard | Webhook、LINE SDK、Agent 配置都依赖统一配置入口 |
| `@line/bot-sdk` | hard | 负责签名校验、Reply、Push |
| `specs/20-agent-orchestrator.spec.md` | soft | Webhook 的业务处理最终通过 Agent 服务实现 |
| `specs/35-weather-scheduler-lifecycle.spec.md` | downstream | Scheduler 复用 `LineService` 的主动推送能力 |

## 任务拆分
### LINE-001 应用入口与配置装配
- goal：创建可启动的 Express 入口和统一配置加载。
- inputs：需求文档 5.1、6.1、9.1；架构文档 2、6；API 文档 1.1、7。
- outputs：`src/index.ts`、`src/config/index.ts`、`.env.example`。
- dependencies：无。
- implementation notes：环境变量名称以需求文档为准，至少覆盖 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`、`TAVILY_API_KEY`、`WEATHER_API_KEY`、`PORT`；缺少关键 LINE 配置时快速失败，其余外部能力配置可选但要有格式校验。
- acceptance criteria：应用可在本地启动；`GET /health` 返回 200；关键环境变量缺失时有明确报错。

### LINE-002 LINE SDK 封装与 Webhook 路由
- goal：封装 `LineService` 并接入 `POST /webhook`。
- inputs：需求文档 3.1、5.1；架构文档 3.2、4.1；API 文档 2.1。
- outputs：`src/services/line.ts`、`src/routes/webhook.ts`。
- dependencies：LINE-001。
- implementation notes：使用 `middleware()` 完成签名校验；统一封装 `replyMessage`、`pushMessage`、`multicast`；Webhook 必须快速返回 `{status:'ok'}`，后续业务处理异步转交桥接接口；发往 LINE 的文本消息发送前要转成纯文本友好格式，避免 Markdown 标记原样透出；一对一文本消息进入异步处理后优先触发 Loading Indicator API，失败仅记录日志，不阻断主回复。
- acceptance criteria：Webhook 可接收 LINE 回调；签名校验连通；Reply 与 Push 能力对下游模块可复用。

### LINE-003 文本消息提取与业务桥接
- goal：从 Webhook 中提取文本事件、`userId`、`replyToken` 并转交统一消息处理入口。
- inputs：需求文档 3.1、8.1；架构文档 5.1；API 文档 2.2。
- outputs：消息桥接 DTO、Webhook 事件过滤逻辑、默认回复回退接口。
- dependencies：LINE-002；对 `specs/20-agent-orchestrator.spec.md` 为软依赖。
- implementation notes：Webhook 路由只负责事件过滤、去重、日志和桥接，不直连单一 LLM `chat()`；为后续 Agent 接入预留单一 `processUserMessage()` 调用点，未接入前允许使用固定 fallback 保证链路可演示；本轮切片同步让 `POST /chat` 复用同一桥接入口，确保调试链路不再依赖旧 LLM 主链路。
- acceptance criteria：文本消息能进入统一桥接入口；非文本消息安全跳过；异常不会导致服务退出。

## 验收与测试
- 单元验证：配置解析、`LineService` 包装函数、文本事件过滤与 DTO 提取逻辑。
- 集成验证：本地 Express + ngrok + LINE Developers Webhook 联调。
- 演示验收：Webhook 可访问、消息可接收、消息桥接可触发、异常路径可恢复。

## 风险与回退
- 风险：环境变量命名如果与需求文档不一致，会直接导致启动失败。
- 风险：Webhook 过慢或未快速确认会触发 LINE 重投，干扰后续 Agent 行为。
- 回退：若 Agent 接入阻塞，先保留固定回复适配器，确保 LINE 基础链路可演示。

## 当前实现基线
- 已有 `src/index.ts`、`src/routes/webhook.ts`、`src/services/line.ts` 的最小运行基础。
- 下一步需要把当前 Webhook 内的业务处理进一步抽象为统一桥接接口，避免继续耦合到旧的 LLM 流程。
- 当前增量补充：Webhook 文本链路需要在进入 Agent 前触发 loading 动画，且所有发往 LINE 的文本回复都需保持纯文本显示效果。
