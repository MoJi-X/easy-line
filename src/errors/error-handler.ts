import type { NextFunction, Request, Response } from 'express';

import { AppError } from './app-error';

export const notFoundHandler = (_req: Request, _res: Response, next: NextFunction): void => {
  next(new AppError(404, 'RESOURCE_NOT_FOUND', 'Resource not found.'));
};

export const errorHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
      data: null,
    });
    return;
  }

  const lineSignatureError =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: number }).status === 401;

  if (lineSignatureError) {
    res.status(401).json({
      code: 'SIGNATURE_VERIFICATION_FAILED',
      message: 'Invalid LINE webhook signature.',
      data: null,
    });
    return;
  }

  const malformedJsonError =
    error instanceof SyntaxError &&
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: number }).status === 400 &&
    'body' in error;

  if (malformedJsonError) {
    res.status(400).json({
      code: 'INVALID_ARGUMENT',
      message: 'Malformed JSON request body.',
      data: null,
    });
    return;
  }

  console.error('[app] unhandled error', error);

  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: 'Internal server error.',
    data: null,
  });
};
