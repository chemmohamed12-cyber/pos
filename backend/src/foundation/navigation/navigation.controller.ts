import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { NavigationService } from './navigation.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { CompanyViewContextService } from '../plans/company-view-context.service';
import { AuthorizationContextService } from '../authorization/authorization-context.service';

/** ERP Foundation — P7. `GET /me/navigation` — the SPA's only source of sidebar structure. */
@Controller()
@UseGuards(JwtAuthGuard)
export class NavigationController {
  constructor(
    private readonly navigation: NavigationService,
    private readonly companyView: CompanyViewContextService,
    private readonly contexts: AuthorizationContextService,
  ) {}

  @Get('me/navigation')
  async meNavigation(@Req() req: AuthenticatedRequest) {
    // The Company claim is used only after Membership re-validation; otherwise the platform view.
    const company = await this.companyView.resolve(req.user);
    // F1.4: ONE AuthorizationContext load (2 statements) replaces the per-item permission queries (57 gated items x 3 statements before F1).
    const ctx = await this.contexts.forRequest(req, company?.manager);
    return { groups: await this.navigation.resolveFor(req.user.id, undefined, company, ctx) };
  }
}
