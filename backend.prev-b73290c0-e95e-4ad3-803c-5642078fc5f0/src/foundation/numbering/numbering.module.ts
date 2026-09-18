import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NumberingSequence } from './numbering-sequence.entity';
import { NumberingService } from './numbering.service';

@Module({
  imports: [TypeOrmModule.forFeature([NumberingSequence])],
  providers: [NumberingService],
  exports: [NumberingService],
})
export class NumberingModule {}
