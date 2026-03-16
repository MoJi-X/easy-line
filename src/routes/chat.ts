import { Router, type Request, type Response, type NextFunction } from 'express';

import { AppError } from '../errors/app-error';
import { messageBridgeService } from '../services/message-bridge';

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
      const bridgeResult = await messageBridgeService.processUserMessage({
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
          reply: bridgeResult.replyText,
          handler: bridgeResult.handler,
          usedTools: bridgeResult.usedTools,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
