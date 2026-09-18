import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigurationModule } from '../foundation/configuration/configuration.module';
import { AppConfigService } from '../foundation/configuration/app-config.service';

/**
 * Stage 2 build-order item 3 (PostgreSQL Foundation), now consuming the
 * real Configuration Engine (item 4) instead of reading process.env
 * directly — closes the temporary shortcut noted when this module was
 * first built.
 */
@Module({
  imports: [
    ConfigurationModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigurationModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        type: 'postgres' as const,
        ...config.database,
        entities: [`${__dirname}/../**/*.entity{.ts,.js}`],
        // Per-module migration partitioning (ADR-025, P6) — one subdir per
        // tag, `<tag>/[0-9]*` keeps the digit-anchor guarantee per dir (see
        // ../data-source.ts). The running app never auto-runs migrations
        // (`synchronize:false`, no `migrationsRun`) — this glob only loads
        // classes into metadata — so it globs every tag unconditionally;
        // an un-run migration for a table this Edition doesn't have is inert.
        migrations: ['core', 'sales', 'inventory', 'logistics', 'finance', 'hr', 'accounting'].map(
          (tag) => `${__dirname}/migrations/${tag}/[0-9]*{.ts,.js}`,
        ),
        // Forward-only migrations only — never auto-sync (ADR-003 §5, ADR-020 §5).
        synchronize: false,
        logging: false,
      }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
