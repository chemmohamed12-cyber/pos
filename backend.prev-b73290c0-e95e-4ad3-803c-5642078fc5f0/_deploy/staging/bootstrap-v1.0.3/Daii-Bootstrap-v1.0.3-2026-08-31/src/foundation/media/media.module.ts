import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaAsset } from './media-asset.entity';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';
import { OBJECT_STORAGE_PORT } from './object-storage.port';
import { LocalFilesystemStorageAdapter } from './local-filesystem-storage.adapter';
import { ConfigurationModule } from '../configuration/configuration.module';
import { AuthenticationModule } from '../authentication/authentication.module';

/**
 * The composition root for this one port (DAII_INFRASTRUCTURE_ABSTRACTION.md
 * §3): exactly this line decides which adapter backs ObjectStoragePort.
 * Swapping to an S3 adapter later means changing this `useClass` only —
 * MediaService and every future domain consumer are unaffected.
 */
@Module({
  imports: [TypeOrmModule.forFeature([MediaAsset]), ConfigurationModule, AuthenticationModule],
  controllers: [MediaController],
  providers: [MediaService, { provide: OBJECT_STORAGE_PORT, useClass: LocalFilesystemStorageAdapter }],
  exports: [MediaService],
})
export class MediaModule {}
