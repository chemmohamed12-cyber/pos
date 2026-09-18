import { HttpStatus } from '@nestjs/common';

/**
 * Canonical fallback code per HTTP status, for errors that are standard
 * NestJS exceptions (UnauthorizedException, NotFoundException, the
 * ValidationPipe's BadRequestException, etc.) rather than a domain's own
 * DaiiException. Keeps every error response on the same canonical-code
 * contract even when the throwing code didn't opt in explicitly.
 */
export function httpStatusToCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'VALIDATION_ERROR';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'UNPROCESSABLE_ENTITY';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR';
  }
}
