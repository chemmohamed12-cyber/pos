import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { RequestWithCorrelationId } from './correlation-id.middleware';

/**
 * Error / Response Contract — Stage 2 build-order item 13.
 *
 * Wraps any controller's success response into the shared envelope
 * automatically, so a new Business Domain controller doesn't have to
 * remember to shape `{success, data, meta}` by hand every time — closes
 * exactly the "every module reinvents this" risk ADR-017 named.
 * Controllers that already return `{success: true, ...}` (existing
 * milestones' controllers, written before this interceptor existed) are
 * passed through unchanged rather than double-wrapped.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithCorrelationId>();
    return next.handle().pipe(
      map((data: unknown) => {
        if (data && typeof data === 'object' && 'success' in data) {
          return data;
        }
        return { success: true, data, meta: { correlationId: request.correlationId } };
      }),
    );
  }
}
