import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { DaiiException } from './daii-exception';
import { httpStatusToCode } from './http-status-to-code';
import { RequestWithCorrelationId } from './correlation-id.middleware';

/**
 * Error / Response Contract — Stage 2 build-order item 13.
 * Daii/architecture/DAII_API_ARCHITECTURE.md §2, DAII_FOUNDATION_CROSSCUTTING_SPEC.md §6.
 *
 * The ONE place every error becomes a response, for every route in the
 * app — no controller formats its own error shape. Never leaks a stack
 * trace, internal error message, or raw DB error to the client
 * (DAII_SECURITY_ARCHITECTURE.md §5 discipline extended to error
 * responses) — unexpected errors are logged in full server-side and
 * returned to the client as a generic INTERNAL_ERROR only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithCorrelationId>();
    const correlationId = request.correlationId;

    if (exception instanceof DaiiException) {
      response.status(exception.getStatus()).json({
        success: false,
        error: { code: exception.code, message: exception.message, details: exception.details },
        meta: { correlationId },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string' ? body : ((body as { message?: string | string[] }).message ?? exception.message);
      response.status(status).json({
        success: false,
        error: { code: httpStatusToCode(status), message, details: undefined },
        meta: { correlationId },
      });
      return;
    }

    // Truly unexpected error — log everything server-side, leak nothing to the client.
    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : String(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', details: undefined },
      meta: { correlationId },
    });
  }
}
