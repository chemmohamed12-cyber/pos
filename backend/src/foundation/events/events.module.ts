import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventOutbox } from './event-outbox.entity';
import { EventBusService } from './event-bus.service';
import { CompanyEventDispatcherScheduler } from './company-event-dispatcher.scheduler';
import { DatabaseRegistryModule } from '../database-registry/database-registry.module';

/** ADR-075 (D10) — `DatabaseRegistryModule` supplies `CompanyConnectionManagerService` (Company id resolution + the per-Company dispatcher's sweep set). */
@Module({
  imports: [TypeOrmModule.forFeature([EventOutbox]), DatabaseRegistryModule],
  providers: [EventBusService, CompanyEventDispatcherScheduler],
  exports: [EventBusService],
})
export class EventsModule {}
