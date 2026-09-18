import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { NavigationService } from './navigation.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';

/** ERP Foundation — P7. `GET /me/navigation` — the SPA's only source of sidebar structure. */
@Controller()
@UseGuards(JwtAuthGuard)
export class NavigationController {
  constructor(private readonly navigation: NavigationService) {}

  @Get('me/navigation')
  async meNavigation(@Req() req: AuthenticatedRequest) {
    return { groups: await this.navigation.resolveFor(req.user.id) };
  }
}
