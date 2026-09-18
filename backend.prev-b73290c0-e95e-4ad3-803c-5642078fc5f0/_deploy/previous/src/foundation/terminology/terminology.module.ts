import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TerminologyEntry } from './terminology-entry.entity';
import { TerminologyService } from './terminology.service';
import { TerminologyController } from './terminology.controller';

@Module({
  imports: [TypeOrmModule.forFeature([TerminologyEntry])],
  controllers: [TerminologyController],
  providers: [TerminologyService],
  exports: [TerminologyService],
})
export class TerminologyModule {}
