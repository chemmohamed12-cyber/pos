import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { EntityNotFoundError } from 'typeorm';
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

    // Multi-Company UI acceptance (2026-10-05): a `findOneOrFail`/`findOneByOrFail`
    // miss — notably a record id that belongs to ANOTHER Company's database,
    // which the caller's own Company connection simply cannot see — surfaced as
    // a 500. A missing or inaccessible record is a 404 and must look identical
    // either way (non-disclosing), so it is mapped here once, centrally. The
    // body is deliberately generic: TypeORM's own message names the entity and
    // the lookup criteria, which must never reach the client.
    if (exception instanceof EntityNotFoundError) {
      this.logger.warn(`Entity not found (mapped to 404): ${exception.message.split('\n')[0]}`);
      response.status(HttpStatus.NOT_FOUND).json({
        success: false,
        error: { code: httpStatusToCode(HttpStatus.NOT_FOUND), message: 'Not Found', details: undefined },
        meta: { correlationId },
      });
      return;
    }

    // Security Assurance Gate — Track S6 (Input Fuzzing), found 2026-09-08:
    // body-parser/raw-body errors (oversized payload → `PayloadTooLargeError`,
    // malformed JSON syntax → a `SyntaxError`) are thrown BELOW the Nest
    // pipeline, as plain `Error` instances carrying their own `status`/
    // `statusCode` (413/400) — never a NestJS `HttpException` — so they
    // fell through to the generic 500 branch below, miscategorizing a
    // routine client mistake (or a deliberate oversized-body attack) as a
    // server fault. No information was ever leaked either way (the old
    // 500 branch's message was already generic) — this fixes the STATUS
    // CODE only, so monitoring/alerting isn't polluted with client errors
    // disguised as 500s, and so 4xx/5xx semantics stay correct for any
    // proxy/cache/client that relies on them.
    const rawStatus = (exception as { status?: unknown })?.status ?? (exception as { statusCode?: unknown })?.statusCode;
    if (typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 500) {
      this.logger.warn(`Client error (${rawStatus}): ${exception instanceof Error ? exception.message : String(exception)}`);
      response.status(rawStatus).json({
        success: false,
        error: { code: httpStatusToCode(rawStatus), message: 'The request could not be processed.', details: undefined },
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
