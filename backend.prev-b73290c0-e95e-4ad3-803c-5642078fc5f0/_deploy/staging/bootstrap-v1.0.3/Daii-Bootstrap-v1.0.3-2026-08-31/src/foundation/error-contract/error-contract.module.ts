import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware } from './correlation-id.middleware';
import { IdempotencyRecord } from './idempotency-record.entity';
import { IdempotencyService } from './idempotency.service';

@Module({
  imports: [TypeOrmModule.forFeature([IdempotencyRecord])],
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class ErrorContractModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
