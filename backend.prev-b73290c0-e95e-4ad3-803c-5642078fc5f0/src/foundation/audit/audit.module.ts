import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditRecord } from './audit-record.entity';
import { AuditService } from './audit.service';

@Module({
  imports: [TypeOrmModule.forFeature([AuditRecord])],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
