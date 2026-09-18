import 'reflect-metadata';
import { join } from 'path';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './foundation/error-contract/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './foundation/error-contract/response-envelope.interceptor';
import { securityHeadersMiddleware } from './security-headers.middleware';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Security Assurance Gate — Track S12 (Deployment Hardening), found
  // 2026-09-08: Express sets `X-Powered-By: Express` on every response by
  // default; NestJS does not disable it. Minor information disclosure
  // (confirms the backend framework to any prober) — cheap, zero-risk to
  // remove, no functional cost.
  app.disable('x-powered-by');

  // API lives under /api; the frontend SPA is served as static files at the
  // root by Express directly (useStaticAssets bypasses Nest's router
  // entirely, so this doesn't need CORS or a second process/port).
  app.setGlobalPrefix('api');
  app.useStaticAssets(join(process.cwd(), 'public'));

  // Security fix F2 (Team B Security Baseline Audit, 2026-09-06): baseline
  // security headers per APPLICATION_SECURITY_STANDARD.md §6. Applied
  // directly (no new dependency — avoids touching the sensitive shared
  // package.json/package-lock.json without a Team A coordination pass) and
  // deliberately limited to headers with NO risk of breaking existing
  // behaviour: none of these affect what resources the SPA is allowed to
  // load. `Content-Security-Policy` and `Strict-Transport-Security` are
  // intentionally NOT set here — CSP needs a real audit of the frontend's
  // actual script/style/font sources first (a wrong policy would silently
  // break the live-adjacent SPA), and HSTS needs confirmation that TLS is
  // always terminated in front of this app in every deployment shape
  // (Cloud and On-Prem/LAN, ADR-019) before it's safe to force. Both are
  // logged as open follow-ups in TEAM_AB_CONSOLIDATED_FINAL_STATUS_REPORT.md,
  // not silently skipped.
  app.use(securityHeadersMiddleware);

  // SPA fallback (Hotfix 4 — was missing entirely). The frontend is a
  // client-side-routed React app: react-router-dom only takes over an
  // already-loaded page. A direct/full navigation to a client route (a
  // bookmark, a page refresh, or `window.open('/print/...', '_blank')`
  // opening a brand-new tab, as every print button does) is a REAL GET
  // request to this server, not a client-side route push. Without this,
  // any such path that isn't `/api/*` and isn't a real static file (JS/
  // CSS/image) fell through to Nest's own default 404 handling and came
  // back as this app's JSON error envelope instead of the SPA shell —
  // confirmed live: `GET /print/sales-order/:id` returned
  // `{"success":false,"error":{"code":"NOT_FOUND",...}}` instead of ever
  // reaching the React app, which is why Print appeared to "not work" —
  // the document page never loaded at all. Registered right after
  // `useStaticAssets`, the standard NestJS pattern for this: a real static
  // file or an `/api/*` controller route (bound earlier, during
  // `NestFactory.create()`) is still matched first; only a path matching
  // neither falls through to here and gets the SPA shell so
  // react-router-dom can render the right client route. `/api/*` paths
  // that don't match any real endpoint still fall through to Nest's own
  // JSON 404 unchanged (explicit `next()` below), not this HTML shell.
  const expressInstance = app.getHttpAdapter().getInstance() as import('express').Express;
  expressInstance.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(join(process.cwd(), 'public', 'index.html'));
  });

  // Global request validation (class-validator DTOs) — every controller
  // gets input validation for free, per DAII_FOUNDATION_CROSSCUTTING_SPEC.md's
  // "build once, consume everywhere" rule applied to validation.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  // Error / Response Contract — build-order item 13: one envelope, one
  // error taxonomy, for every route (DAII_API_ARCHITECTURE.md §2).
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  console.log(`Daii backend listening on port ${port} (API at /api, UI at /)`);
}

bootstrap();
