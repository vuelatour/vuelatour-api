import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
  timestamp: string;
  path: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'string') {
        message = response;
      } else if (response && typeof response === 'object') {
        const r = response as Record<string, unknown>;
        message = (r.message as string) ?? exception.message;
        code = (r.error as string) ?? exception.name;
        details = r.details;
      }
      code = code.toUpperCase().replace(/\s+/g, '_');
    } else if (exception instanceof Error) {
      message = exception.message;
      code = exception.name.toUpperCase();
    }

    const body: ErrorBody = {
      statusCode: status,
      code,
      message,
      details,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      path: req.originalUrl,
    };

    if (status >= 500) {
      this.logger.error({ err: exception, requestId: req.requestId }, message);
    }

    res.status(status).json(body);
  }
}
