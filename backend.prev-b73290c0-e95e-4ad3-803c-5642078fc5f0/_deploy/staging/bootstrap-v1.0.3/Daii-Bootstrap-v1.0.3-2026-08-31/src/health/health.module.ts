import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ObservabilityModule } from '../foundation/observability/observability.module';

@Module({
  imports: [ObservabilityModule],
  controllers: [HealthController],
})
export class HealthModule {}
