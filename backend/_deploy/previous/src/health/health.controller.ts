import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { HealthService, OverallHealth } from '../foundation/observability/health.service';

/**
 * `check`/`checkDb` are the milestone-1/2 boot-proof endpoints, kept as-is.
 * `deep` is the real Observability/Health capability (build-order item 15,
 * DAII_PLATFORM_FOUNDATION_CONTRACT.md §17) — real functional round-trip
 * checks, not a hardcoded "ok" (RMS discipline).
 */
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly healthService: HealthService,
  ) {}

  @Get()
  check(): { success: true; data: { status: 'ok' }; meta: { note: string } } {
    return {
      success: true,
      data: { status: 'ok' },
      meta: { note: 'Shallow boot-proof only — see Foundation Contract §17. Use /health/deep for real checks.' },
    };
  }

  @Get('db')
  async checkDb(): Promise<{ success: boolean; data: Record<string, unknown>; meta: { note: string } }> {
    const rows = await this.dataSource.query(
      'SELECT id, checked_at FROM "_daii_bootstrap_check" ORDER BY id DESC LIMIT 1',
    );
    return {
      success: true,
      data: { connected: true, lastBootstrapRow: rows[0] },
      meta: { note: 'Real round-trip query against Postgres — build-order item 3 verification.' },
    };
  }

  @Get('deep')
  async deep(): Promise<{ success: boolean; data: OverallHealth }> {
    const health = await this.healthService.checkAll();
    return { success: health.status === 'ok', data: health };
  }
}
