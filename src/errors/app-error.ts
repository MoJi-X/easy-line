export type AppErrorCode =
  | 'INVALID_ARGUMENT'
  | 'RESOURCE_NOT_FOUND'
  | 'SIGNATURE_VERIFICATION_FAILED'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly statusCode: number;

  readonly code: AppErrorCode;

  constructor(statusCode: number, code: AppErrorCode, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}
