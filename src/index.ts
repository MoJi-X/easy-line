import express from "express";

import { config } from "./config";

const app = express();

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
});
