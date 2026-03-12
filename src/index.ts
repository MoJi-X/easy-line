import express from "express";

import { config } from "./config";
import webhookRouter from "./routes/webhook";

const app = express();

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use(webhookRouter);

app.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
});
