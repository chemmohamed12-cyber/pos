import { Controller, Get, Query } from '@nestjs/common';
import { TerminologyService, SupportedLang } from './terminology.service';

/** Daii/architecture/DAII_I18N_TERMINOLOGY_ARCHITECTURE.md §3 — the client-facing read endpoint. */
@Controller('terminology')
export class TerminologyController {
  constructor(private readonly terminology: TerminologyService) {}

  @Get()
  async list(@Query('codes') codes: string, @Query('lang') lang: SupportedLang = 'ar') {
    const codeList = codes ? codes.split(',') : [];
    return this.terminology.resolveMany(codeList, lang);
  }
}
