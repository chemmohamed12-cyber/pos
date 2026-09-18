import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserLocalePreference } from './user-locale-preference.entity';
import { LocalizationService } from './localization.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserLocalePreference])],
  providers: [LocalizationService],
  exports: [LocalizationService],
})
export class LocalizationModule {}
