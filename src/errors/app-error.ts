export type AppErrorCode =
  | 'INVALID_ARGUMENT'
  | 'RESOURCE_NOT_FOUND'
  | 'FORBIDDEN_TASK_ACCESS'
  | 'INVALID_LINE_SIGNATURE'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'INTERNAL_ERROR';

export interface AppErrorDetail {
  field?: string;
  message: string;
}

export class AppError extends Error {
  readonly statusCode: number;

  readonly code: AppErrorCode;

  readonly details?: AppErrorDetail[];

  constructor(
    statusCode: number,
    code: AppErrorCode,
    message: string,
    details?: AppErrorDetail[],
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
