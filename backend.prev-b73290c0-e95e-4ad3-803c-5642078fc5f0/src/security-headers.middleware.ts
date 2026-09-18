import type { NextFunction, Request, Response } from 'express';

/**
 * Security fix F2 (Team B Security Baseline Audit, 2026-09-06) —
 * APPLICATION_SECURITY_STANDARD.md §6 baseline headers. Deliberately
 * limited to headers that cannot break existing resource loading (see
 * main.ts's comment for why Content-Security-Policy and
 * Strict-Transport-Security are intentionally excluded here).
 */
export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}
