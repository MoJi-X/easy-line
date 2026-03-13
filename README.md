# easy-line

## 环境要求
- Node.js 20+
- npm 9+

## 启动步骤
1. 安装依赖：
   ```bash
   npm install
   ```
2. 复制环境变量模板并填写真实值：
   ```bash
   cp .env.example .env
   ```
3. 开发模式启动：
   ```bash
   npm run dev
   ```
4. 生产构建并启动：
   ```bash
   npm run build
   npm run start
   ```

## 环境变量说明
- `LINE_CHANNEL_SECRET`：LINE Messaging API Channel Secret。
- `LINE_CHANNEL_ACCESS_TOKEN`：LINE Messaging API Channel Access Token。
- `LLM_API_KEY`：OpenAI-compatible 大模型服务 API Key。
- `LLM_BASE_URL`：可选，自定义 OpenAI-compatible 服务地址。
- `LLM_MODEL`：可选，模型名，默认 `gpt-3.5-turbo`。
- `PORT`：服务监听端口（默认 `3000`）。

## 健康检查
服务启动后，可通过以下接口确认状态：

```bash
curl http://localhost:3000/health
```

返回 `200` 与 JSON：

```json
{"status":"ok"}
```

## Chat 调试接口
可通过 `POST /chat` 在不依赖 LINE Webhook 的情况下验证 LLM 调用流程。

请求体：

```json
{
  "userId": "u1",
  "message": "你好"
}
```

示例：

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"u1\",\"message\":\"你好\"}"
```

成功时返回：

```json
{
  "code": "OK",
  "message": "ok",
  "data": {
    "userId": "u1",
    "message": "你好",
    "reply": "..."
  }
}
```
