import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { Credential } from './credential.entity';
import { RefreshToken } from './refresh-token.entity';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IdentityModule } from '../identity/identity.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { CompanyModule } from '../company/company.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Credential, RefreshToken]),
    JwtModule.register({}),
    IdentityModule,
    AuthorizationModule,
    // Multi-Company Area 5 (2026-09-23) — for MembershipService, so
    // AuthService.selectCompany can validate a Company claim before ever
    // issuing a token that carries it. `forwardRef` — Membership HTTP
    // Management (2026-09-24) made this circular: CompanyModule's own
    // controllers now need JwtAuthGuard from THIS module.
    forwardRef(() => CompanyModule),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  // JwtModule AND IdentityModule are re-exported (not just
  // AuthService/JwtAuthGuard) because JwtAuthGuard's OWN constructor
  // needs JwtService, UsersService, AND AppConfigService — any module
  // that only imports AuthenticationModule to use the guard (Admin,
  // Commerce, CRM, Sales Orders, every domain controller using
  // @UseGuards(JwtAuthGuard)) needs all three resolvable transitively.
  // AppConfigService is covered by ConfigurationModule's @Global().
  // Same class of bug throughout, found the same way each time: by
  // actually booting against a real database instead of stopping at
  // mocked unit tests, which never exercise the real Nest DI graph.
  exports: [AuthService, JwtAuthGuard, JwtModule, IdentityModule],
})
export class AuthenticationModule {}
