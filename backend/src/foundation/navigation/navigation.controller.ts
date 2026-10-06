import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { NavigationService } from './navigation.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { CompanyViewContextService } from '../plans/company-view-context.service';

/** ERP Foundation — P7. `GET /me/navigation` — the SPA's only source of sidebar structure. */
@Controller()
@UseGuards(JwtAuthGuard)
export class NavigationController {
  constructor(
    private readonly navigation: NavigationService,
    private readonly companyView: CompanyViewContextService,
  ) {}

  @Get('me/navigation')
  async meNavigation(@Req() req: AuthenticatedRequest) {
    // The Company claim is used only after Membership re-validation; otherwise the platform view.
    const company = await this.companyView.resolve(req.user);
    return { groups: await this.navigation.resolveFor(req.user.id, undefined, company) };
  }
}
