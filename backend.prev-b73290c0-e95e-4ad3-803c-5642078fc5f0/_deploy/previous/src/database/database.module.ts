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
        migrations: [`${__dirname}/migrations/*{.ts,.js}`],
        // Forward-only migrations only — never auto-sync (ADR-003 §5, ADR-020 §5).
        synchronize: false,
        logging: false,
      }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
