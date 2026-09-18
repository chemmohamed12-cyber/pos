import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventOutbox } from './event-outbox.entity';
import { EventBusService } from './event-bus.service';

@Module({
  imports: [TypeOrmModule.forFeature([EventOutbox])],
  providers: [EventBusService],
  exports: [EventBusService],
})
export class EventsModule {}
