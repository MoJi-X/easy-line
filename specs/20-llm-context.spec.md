# LLM 对话与上下文开发规格

## 目标与边界
- 目标：在已跑通的 LINE 消息链路上接入 LangChain，实现按用户维度的智能对话和上下文记忆。
- 范围内：`src/services/llm.ts`、Webhook 与 LLM 的集成、`POST /chat` 调试入口、降级回复策略、上下文内存约束。
- 范围外：知识库、向量检索、长期记忆、复杂 Prompt 平台。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/需求规格说明书.md` | 3.2、5.1.2、6.1、8.1、9.1 | 权威 LLM 能力、上下文规则、技术选型、验收标准 |
| `docs/architecture/系统架构设计文档.md` | 4.3 | `LLMService` 职责与基础类设计 |
| `docs/architecture/数据库设计文档.md` | 1.1、2.1、5.1、6.4 | 内存存储策略、LangChain 消息历史、按用户隔离上下文 |
| `docs/api/API接口设计文档.md` | 5.1、5.2、7.1 | LangChain 接入方式、上下文参数、入口调用方式 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| `specs/10-line-message.spec.md` | hard | LLM 最终通过 Webhook 文本消息链路触发 |
| LLM API Key | hard | `LLM_API_KEY` 缺失时必须快速失败或进入固定降级 |
| 内存 `Map` + LangChain 消息对象 | hard | Demo 阶段不使用数据库持久化 |

## 任务拆分
### LLM-001 模型配置与服务骨架
- goal：建立 `LLMService`，统一封装模型初始化与调用入口。
- inputs：需求文档 3.2.1、6.1；架构文档 4.3；数据库文档 6.4；API 文档 5.1。
- outputs：`src/services/llm.ts`。
- dependencies：`specs/10-line-message.spec.md` 中的配置入口。
- implementation notes：使用官方最新 LangChain 1.x 组合 `@langchain/core@1.1.32` 与 `@langchain/openai@1.2.13`；模型默认 `gpt-3.5-turbo`，但通过 `LLM_MODEL` 可配置；自定义 `LLM_BASE_URL` 时仅支持 OpenAI-compatible 接口；保留固定温度和统一 `chat(userId, message)` 方法，继续避免依赖会触发 npm optional peer 冲突的 `langchain` 元包。
- acceptance criteria：服务可以成功创建模型实例；调用链路只暴露一个对外聊天入口；模型异常能被上层捕获；`LLM_BASE_URL` 非法时在配置加载阶段快速失败。

### LLM-002 按用户管理上下文记忆
- goal：实现基于 `userId` 的上下文隔离，并严格控制记忆长度。
- inputs：需求文档 3.2.3；数据库文档 2.1、5.1；API 文档 5.2。
- outputs：内存管理逻辑、上下文截断策略。
- dependencies：LLM-001。
- implementation notes：按 `userId` 使用 `Map<string, BaseMessage[]>` 管理；需求文档规定只保留最近 3 轮对话，不能直接依赖无限增长的默认记忆；需要在接入点明确裁剪策略，并在调用模型前后显式维护消息历史。
- acceptance criteria：不同用户上下文互不污染；同一用户最多保留最近 3 轮上下文；重启后上下文丢失符合 Demo 预期。

### LLM-003 Webhook 集成与降级回复
- goal：把 LLM 回复接入文本消息主链路，并提供失败时的兜底响应。
- inputs：需求文档 3.2.2、8.1；架构文档 3.1；API 文档 7.1。
- outputs：Webhook 到 LLM 的调用接点、统一 fallback 文本。
- dependencies：LLM-001、LLM-002、`specs/10-line-message.spec.md` 的 LINE-003。
- implementation notes：Webhook 处理器负责提取 `userId` 与文本，再调用 `LLMService`；OpenAI 调用失败时返回固定中文降级回复，保证演示不中断。
- acceptance criteria：LINE 文本消息能触发智能回复；上下文在连续对话中生效；外部 API 异常时仍能返回可读降级文本。

### LLM-004 `/chat` 调试入口
- goal：提供一个不依赖 LINE Webhook 的本地验证入口，直接验证 LLM 调用和按 `userId` 隔离的上下文。
- inputs：需求文档 3.2、8.1；治理文档对内部 JSON 接口与错误结构的约束。
- outputs：`POST /chat` 路由、请求体验证、LLM 错误到 HTTP 错误码的映射。
- dependencies：LLM-001、LLM-002。
- implementation notes：请求体固定为 `userId` 与 `message`；成功时返回 `code/message/data`；失败时不走降级回复，而是返回 JSON 错误，便于调试；同一 `userId` 连续请求应复用现有 3 轮上下文。
- acceptance criteria：可通过普通 HTTP 请求验证 LLM 主流程；不同 `userId` 上下文互不污染；参数错误和 LLM 错误都返回稳定 JSON 结构。

## 验收与测试
- 单元验证：`userId` 记忆映射、上下文裁剪、降级回复。
- 集成验证：真实 Webhook 文本消息触发 LangChain 调用并返回内容。
- 集成验证：`POST /chat` 可在本地直接触发 LangChain 调用并返回内容。
- 演示验收：连续提问能体现记忆效果；模型失败时不阻断消息回复。

## 风险与回退
- 风险：LangChain 元包在 npm 11 下会触发 optional peer 自动解析，若继续依赖 `langchain` 可能导致安装失败。
- 风险：即使改为直接维护消息历史，也必须显式裁剪，不能放任上下文无限增长。
- 风险：OpenAI 接口不稳定会导致回复超时或失败。
- 回退：保留固定 fallback 回复；必要时先禁用上下文裁剪外的增强能力，只保留单轮对话。

## 迭代记录
- 2026-03-12：回滚冲突提交后重新实现 LLM-001~LLM-003，目标是在现有基线代码上完成可运行切片并降低后续合入冲突。
- 2026-03-12（重做落地）：完成 `src/services/llm.ts`、`src/routes/webhook.ts`、`src/services/line.ts` 与 `src/index.ts` 集成，支持按 `userId` 的 3 轮记忆裁剪、分类异常、LLM 失败中文降级。
- 2026-03-13：为解决 `npm install` 在 npm 11 下的 LangChain peer 冲突，改为直接使用 `@langchain/openai` + `@langchain/core/messages` 维护 3 轮上下文，移除 `langchain` 元包依赖。
- 2026-03-13：LangChain 依赖升级到官方最新 `@langchain/core@1.1.32` 与 `@langchain/openai@1.2.13`，并确认当前 `ChatOpenAI.invoke()` + `BaseMessage[]` 方案可继续兼容。
- 2026-03-13：新增 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL` 运行时配置，支持 OpenAI-compatible endpoint 与自定义模型名，取消旧的 `OPENAI_*` 变量命名。
- 2026-03-13：新增 `POST /chat` 调试入口，用于在无法联调 LINE `/webhook` 时验证 LLM 调用、上下文隔离与错误返回。
- 2026-03-13：修复 `src/routes/webhook.ts` 未接入 `LLMService` 的缺口，文本消息现已走真实 LLM 调用，并在模型异常时返回固定中文降级回复。
- 当前阻塞点：待补真实 LINE Webhook 与 OpenAI-compatible 服务联调验证。
- 下一步：推进 `specs/30-scheduler-push.spec.md`。

