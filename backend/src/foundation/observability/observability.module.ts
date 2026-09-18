import { Module } from '@nestjs/common';
import { DaiiLoggerService } from './daii-logger.service';
import { MetricsService } from './metrics.service';
import { HealthService } from './health.service';

@Module({
  providers: [DaiiLoggerService, MetricsService, HealthService],
  exports: [DaiiLoggerService, MetricsService, HealthService],
})
export class ObservabilityModule {}
