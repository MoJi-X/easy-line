import { Router, type Request, type Response, type NextFunction } from 'express';

import { AppError } from '../errors/app-error';
import { LLMService, LLMServiceError } from '../services/llm';

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

const mapLLMServiceError = (error: LLMServiceError): AppError => {
  switch (error.type) {
    case 'MISSING_API_KEY':
    case 'MODEL_INIT_FAILED':
      return new AppError(500, 'INTERNAL_ERROR', error.message);
    case 'MODEL_CALL_FAILED':
      return new AppError(502, 'EXTERNAL_SERVICE_ERROR', error.message);
    default:
      return new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
  }
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
      const reply = await LLMService.chat(userId, message);

      res.json({
        code: 'OK',
        message: 'ok',
        data: {
          userId,
          message,
          reply,
        },
      });
    } catch (error) {
      if (error instanceof LLMServiceError) {
        next(mapLLMServiceError(error));
        return;
      }

      next(error);
    }
  },
);

export default router;
