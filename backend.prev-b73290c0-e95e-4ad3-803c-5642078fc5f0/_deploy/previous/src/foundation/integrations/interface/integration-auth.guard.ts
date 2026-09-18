import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { DataSource } from 'typeorm';
import { IntegrationConnector } from '../infrastructure/integration-connector.entity';
import { IntegrationCredential } from '../infrastructure/integration-credential.entity';
import { CredentialCipherService } from '../application/credential-cipher.service';

export interface IntegrationRequest extends Request {
  connector: IntegrationConnector;
}

/**
 * Inbound authentication for calls FROM an external system (QR order
 * intake) — a machine-to-machine credential, never a Daii user JWT.
 * Mirrors the pattern `_source-audits/xnexus-website`'s own capability
 * audit already validated for this exact shape
 * (`integration-gateway-engine.js`, "inbound shared-secret verification",
 * classified C — reusable pattern, not reusable code, since that
 * implementation is homegrown-crypto/file-persisted). Expects
 * `X-Daii-Connector-Id: <connectorId>` + `Authorization: Bearer <pairing
 * token>`; the token is compared against the connector's OWN active
 * (non-revoked) credential, decrypted server-side — never trusted from
 * the request as a bare id.
 */
@Injectable()
export class IntegrationAuthGuard implements CanActivate {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cipher: CredentialCipherService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<IntegrationRequest>();
    const connectorId = req.header('X-Daii-Connector-Id');
    const authHeader = req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;

    if (!connectorId || !token) {
      throw new UnauthorizedException('Missing X-Daii-Connector-Id or Authorization header.');
    }

    const connector = await this.dataSource.getRepository(IntegrationConnector).findOne({ where: { id: connectorId } });
    // 404-shaped denial (a generic 401, not "connector not found") —
    // never confirm/deny a connector id's existence to an unauthenticated caller.
    if (!connector || connector.status === 'disconnected') {
      throw new UnauthorizedException('Invalid connector credential.');
    }

    const credential = await this.dataSource
      .getRepository(IntegrationCredential)
      .findOne({ where: { connectorId, revoked: false }, order: { createdAt: 'DESC' } });
    if (!credential) throw new UnauthorizedException('Invalid connector credential.');

    let decrypted: string;
    try {
      decrypted = this.cipher.decrypt(credential.encryptedValue);
    } catch {
      throw new UnauthorizedException('Invalid connector credential.');
    }
    // V1 Release Audit LOW fix — constant-time comparison for a
    // credential check (was a plain !==). Buffer.from + length guard
    // first since timingSafeEqual throws on mismatched lengths.
    const decryptedBuf = Buffer.from(decrypted, 'utf8');
    const tokenBuf = Buffer.from(token, 'utf8');
    const isValid = decryptedBuf.length === tokenBuf.length && timingSafeEqual(decryptedBuf, tokenBuf);
    if (!isValid) throw new UnauthorizedException('Invalid connector credential.');

    req.connector = connector;
    return true;
  }
}
