import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export interface RequestWithCorrelationId extends Request {
  correlationId: string;
}

/**
 * Error / Response Contract — Stage 2 build-order item 13.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §19 (Observability).
 *
 * Every request gets a correlation ID — reused from an inbound
 * `x-correlation-id` header if the caller already has one (useful for a
 * mobile client retrying a request), otherwise generated fresh. Threads
 * through the Error Contract's response envelope and (once a domain
 * wires it in) the Audit Engine's `correlationId` field.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-correlation-id'];
    const correlationId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
    (req as RequestWithCorrelationId).correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    next();
  }
}
