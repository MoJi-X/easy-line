import { Router, type Request, type Response, type NextFunction } from 'express';

import { AppError } from '../errors/app-error';
import { agentService, mapAgentErrorToAppError } from '../services/agent';

interface ChatRequestBody {
  userId?: unknown;
  message?: unknown;
}

const router = Router();

const getChatBodyField = (value: unknown): string => {
  return typeof value === 'string' ? value : '';
};

router.post(
  '/chat',
  async (
    req: Request<unknown, unknown, ChatRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userId = getChatBodyField(req.body?.userId);
      const message = getChatBodyField(req.body?.message);
      const agentResult = await agentService.processUserMessage({
        channel: 'chat_api',
        userId,
        message,
      });

      res.json({
        code: 'OK',
        message: 'ok',
        data: {
          userId,
          message,
          reply: agentResult.reply,
          usedTools: agentResult.usedTools,
        },
      });
    } catch (error) {
      next(error instanceof AppError ? error : mapAgentErrorToAppError(error));
    }
  },
);

export default router;
