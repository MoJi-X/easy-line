# easy-line

## 环境要求
- Node.js 18+
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
- `OPENAI_API_KEY`：OpenAI API Key。
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
