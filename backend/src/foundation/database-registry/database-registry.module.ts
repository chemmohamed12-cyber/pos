import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseRegistry } from './database-registry.entity';
import { DatabaseCredential } from './database-credential.entity';
import { DatabaseCredentialCipherService } from './database-credential-cipher.service';
import { DatabaseRegistryService } from './database-registry.service';
import { CompanyConnectionManagerService } from './company-connection-manager.service';

/**
 * Multi-Company Phase 3 V7, Area 3 (Database Registry) + Area 9
 * (Background Jobs — Gap Fix). `AppConfigService` is available without an
 * explicit import — `ConfigurationModule` is `@Global()`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DatabaseRegistry, DatabaseCredential])],
  providers: [DatabaseCredentialCipherService, DatabaseRegistryService, CompanyConnectionManagerService],
  exports: [DatabaseRegistryService, CompanyConnectionManagerService],
})
export class DatabaseRegistryModule {}
