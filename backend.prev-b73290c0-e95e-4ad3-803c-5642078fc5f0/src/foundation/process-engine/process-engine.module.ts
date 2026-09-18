import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProcessInstance } from './process-instance.entity';
import { ProcessTransitionRecord } from './process-transition-record.entity';
import { ProcessEngineService } from './process-engine.service';

@Module({
  imports: [TypeOrmModule.forFeature([ProcessInstance, ProcessTransitionRecord])],
  providers: [ProcessEngineService],
  exports: [ProcessEngineService],
})
export class ProcessEngineModule {}
