import { Body, Controller, Get, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AuthenticatedRequest, JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { CompanyInvitationService } from './company-invitation.service';

class AcceptDto {
  @IsString()
  @MaxLength(200)
  token!: string;
}

class RegisterAcceptDto extends AcceptDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fullName!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;
}

/**
 * Authorization Foundation F2 — invitation acceptance. The token is the only credential on the public routes; every invalid state
 * (unknown, expired, used, revoked, wrong e-mail) answers with the same `INVITATION_INVALID` 404. Rate-limited per IP.
 */
@Controller('invitations')
export class CompanyInvitationsPublicController {
  constructor(private readonly invitations: CompanyInvitationService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('preview')
  async preview(@Query('token') token: string) {
    return { success: true, data: await this.invitations.preview(token) };
  }

  /** An existing account, signed in as the invited e-mail. */
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('accept')
  async accept(@Req() req: AuthenticatedRequest, @Body() dto: AcceptDto) {
    if (!req.user) throw new UnauthorizedException();
    return { success: true, data: await this.invitations.acceptAsUser(req.user.id, dto.token) };
  }

  /** A new person: creates the identity (invitee's own password) and the membership. Refused if the e-mail already has an account. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(@Body() dto: RegisterAcceptDto) {
    return { success: true, data: await this.invitations.acceptAsNewIdentity(dto.token, dto.fullName, dto.password) };
  }
}
