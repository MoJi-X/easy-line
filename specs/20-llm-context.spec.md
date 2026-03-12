# LLM 对话与上下文开发规格

## 目标与边界
- 目标：在已跑通的 LINE 消息链路上接入 LangChain，实现按用户维度的智能对话和上下文记忆。
- 范围内：`src/services/llm.ts`、Webhook 与 LLM 的集成、降级回复策略、上下文内存约束。
- 范围外：知识库、向量检索、长期记忆、复杂 Prompt 平台。

## 关联文档
| 文档 | 章节 | 用途 |
| --- | --- | --- |
| `docs/需求规格说明书.md` | 3.2、5.1.2、6.1、8.1、9.1 | 权威 LLM 能力、上下文规则、技术选型、验收标准 |
| `docs/architecture/系统架构设计文档.md` | 4.3 | `LLMService` 职责与基础类设计 |
| `docs/architecture/数据库设计文档.md` | 1.1、2.1、5.1、6.4 | 内存存储策略、`BufferMemory`、按用户隔离上下文 |
| `docs/api/API接口设计文档.md` | 5.1、5.2、7.1 | LangChain 接入方式、上下文参数、入口调用方式 |

## 模块依赖
| 依赖项 | 类型 | 说明 |
| --- | --- | --- |
| `specs/10-line-message.spec.md` | hard | LLM 最终通过 Webhook 文本消息链路触发 |
| OpenAI API Key | hard | `OPENAI_API_KEY` 缺失时必须快速失败或进入固定降级 |
| 内存 `Map` + `BufferMemory` | hard | Demo 阶段不使用数据库持久化 |

## 任务拆分
### LLM-001 模型配置与服务骨架
- goal：建立 `LLMService`，统一封装模型初始化与调用入口。
- inputs：需求文档 3.2.1、6.1；架构文档 4.3；数据库文档 6.4；API 文档 5.1。
- outputs：`src/services/llm.ts`。
- dependencies：`specs/10-line-message.spec.md` 中的配置入口。
- implementation notes：使用 LangChain 和 `@langchain/openai`；模型按文档默认 `gpt-3.5-turbo`；保留固定温度和统一 `chat(userId, message)` 方法。
- acceptance criteria：服务可以成功创建模型实例；调用链路只暴露一个对外聊天入口；模型异常能被上层捕获。

### LLM-002 按用户管理上下文记忆
- goal：实现基于 `userId` 的上下文隔离，并严格控制记忆长度。
- inputs：需求文档 3.2.3；数据库文档 2.1、5.1；API 文档 5.2。
- outputs：内存管理逻辑、上下文截断策略。
- dependencies：LLM-001。
- implementation notes：按 `userId` 使用 `Map<string, BufferMemory>` 管理；需求文档规定只保留最近 3 轮对话，不能直接依赖无限增长的默认记忆；需要在接入点明确裁剪策略。
- acceptance criteria：不同用户上下文互不污染；同一用户最多保留最近 3 轮上下文；重启后上下文丢失符合 Demo 预期。

### LLM-003 Webhook 集成与降级回复
- goal：把 LLM 回复接入文本消息主链路，并提供失败时的兜底响应。
- inputs：需求文档 3.2.2、8.1；架构文档 3.1；API 文档 7.1。
- outputs：Webhook 到 LLM 的调用接点、统一 fallback 文本。
- dependencies：LLM-001、LLM-002、`specs/10-line-message.spec.md` 的 LINE-003。
- implementation notes：Webhook 处理器负责提取 `userId` 与文本，再调用 `LLMService`；OpenAI 调用失败时返回固定中文降级回复，保证演示不中断。
- acceptance criteria：LINE 文本消息能触发智能回复；上下文在连续对话中生效；外部 API 异常时仍能返回可读降级文本。

## 验收与测试
- 单元验证：`userId` 记忆映射、上下文裁剪、降级回复。
- 集成验证：真实 Webhook 文本消息触发 LangChain 调用并返回内容。
- 演示验收：连续提问能体现记忆效果；模型失败时不阻断消息回复。

## 风险与回退
- 风险：参考文档示例中的 `BufferMemory` 默认行为不等于“仅保留最近 3 轮”，实现时必须额外裁剪。
- 风险：OpenAI 接口不稳定会导致回复超时或失败。
- 回退：保留固定 fallback 回复；必要时先禁用上下文裁剪外的增强能力，只保留单轮对话。

## 迭代记录
- 2026-03-12：完成 LLM-001/LLM-002/LLM-003 的首个可运行切片，实现 `LLMService.chat`、按 `userId` 的 `Map<string, BufferMemory>` 记忆管理、3 轮上下文裁剪，以及 Webhook 文本链路降级回复。
- 当前阻塞点：缺少真实 LINE Developers 与 OpenAI 联调环境，暂无法完成端到端验收。
- 下一步：进入 `specs/30-scheduler-push.spec.md` 的定时推送链路实现。

- 2026-03-12（冲突修复）：移除启动阶段对 `OPENAI_API_KEY` 的强依赖，改为由 `LLMService` 在模型初始化时分类抛错，确保缺少 Key 时仍可走 Webhook 中文降级回复。
