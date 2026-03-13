import type { NextFunction, Request, Response } from 'express';

import { AppError } from './app-error';
import { createAppLogger } from '../utils/app-logger';

const httpLogger = createAppLogger('http');

const getRequestContext = (req: Request) => {
  return {
    method: req.method,
    path: req.originalUrl,
  };
};

export const notFoundHandler = (_req: Request, _res: Response, next: NextFunction): void => {
  next(new AppError(404, 'RESOURCE_NOT_FOUND', 'Resource not found.'));
};

export const errorHandler = (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
  if (error instanceof AppError) {
    const context = {
      ...getRequestContext(req),
      statusCode: error.statusCode,
      errorCode: error.code,
    };

    if (error.statusCode >= 500) {
      httpLogger.error('request failed with application error', context, error);
    } else {
      httpLogger.warn('request failed with application error', context);
    }

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
    httpLogger.warn('request failed because LINE webhook signature verification failed', {
      ...getRequestContext(req),
      statusCode: 401,
      errorCode: 'SIGNATURE_VERIFICATION_FAILED',
    });

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
    httpLogger.warn('request failed because JSON body is malformed', {
      ...getRequestContext(req),
      statusCode: 400,
      errorCode: 'INVALID_ARGUMENT',
    });

    res.status(400).json({
      code: 'INVALID_ARGUMENT',
      message: 'Malformed JSON request body.',
      data: null,
    });
    return;
  }

  httpLogger.error('request failed with unexpected error', getRequestContext(req), error);

  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: 'Internal server error.',
    data: null,
  });
};
