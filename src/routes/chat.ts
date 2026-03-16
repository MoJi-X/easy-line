import { Router, type Request, type Response, type NextFunction } from 'express';

import { AppError } from '../errors/app-error';
import { agentService, mapAgentErrorToAppError } from '../services/agent';

interface ChatRequestBody {
  userId?: unknown;
  message?: unknown;
}

const router = Router();

const getRequiredTextField = (
  value: unknown,
  fieldName: 'userId' | 'message',
): string => {
  if (typeof value !== 'string') {
    throw new AppError(400, 'INVALID_ARGUMENT', `${fieldName} must be a non-empty string.`);
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw new AppError(400, 'INVALID_ARGUMENT', `${fieldName} must be a non-empty string.`);
  }

  return normalizedValue;
};

router.post(
  '/chat',
  async (
    req: Request<unknown, unknown, ChatRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userId = getRequiredTextField(req.body?.userId, 'userId');
      const message = getRequiredTextField(req.body?.message, 'message');
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
      if (error instanceof AppError) {
        next(error);
        return;
      }

      next(mapAgentErrorToAppError(error));
    }
  },
);

export default router;
