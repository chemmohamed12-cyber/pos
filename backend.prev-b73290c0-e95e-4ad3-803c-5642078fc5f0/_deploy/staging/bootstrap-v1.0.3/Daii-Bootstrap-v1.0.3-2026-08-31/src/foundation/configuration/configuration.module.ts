import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configurationValidationSchema } from './configuration.schema';
import { AppConfigService } from './app-config.service';

/**
 * Wraps the Joi schema instead of passing it as `validationSchema` so the
 * thrown error is unambiguous about *where* the fault is. Production
 * incident 2026-08-27 (Daii/PRODUCTION_DEPLOYMENT_GUIDE.md "Troubleshooting"):
 * a bare "X is required" message was repeatedly misread during a live
 * outage as a database problem, when it was actually the hosting layer
 * (cPanel/Passenger) not yet delivering configured env vars to this
 * process — several hours were spent on the wrong layer before that
 * became clear. This message says so explicitly, on every failure.
 */
function validate(config: Record<string, unknown>): Record<string, unknown> {
  const { error, value } = configurationValidationSchema.validate(config, {
    abortEarly: false,
    allowUnknown: true,
  });
  if (error) {
    const details = error.details.map((d) => `  - ${d.message}`).join('\n');
    throw new Error(
      'Daii startup aborted: required runtime environment configuration is missing or invalid.\n' +
        'This is a DEPLOYMENT/ENVIRONMENT problem, not a database problem — the process has not attempted ' +
        'a Postgres connection yet. Confirm these variables are actually reaching THIS process (not just ' +
        'configured in cPanel/hosting-panel UI) — see PRODUCTION_DEPLOYMENT_GUIDE.md "Troubleshooting".\n\n' +
        `Details:\n${details}`,
    );
  }
  return value as Record<string, unknown>;
}

/**
 * Configuration Engine — Stage 2 build-order item 4.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §8.
 *
 * Validates all required environment values at startup and fails fast
 * (throws before the app finishes bootstrapping) if anything required is
 * missing or invalid — per this milestone's "clear startup failure"
 * requirement. Global so every Foundation/Domain module can inject
 * AppConfigService without re-importing this module everywhere.
 *
 * BUG FOUND & FIXED during first live-database boot (not caught by unit
 * tests, which mock every dependency and never exercise the real Nest DI
 * graph): this class's own comment always claimed "global" but the
 * module was never actually decorated @Global() — AuthenticationModule's
 * AuthService needs AppConfigService and failed to resolve it at real
 * bootstrap. Exactly the class of gap only integration/e2e boot
 * verification catches — the reason this session got a real Postgres
 * instance running rather than stopping at unit-test coverage.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class ConfigurationModule {}
