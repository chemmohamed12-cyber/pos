import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Error / Response Contract — Stage 2 build-order item 13.
 * Daii/architecture/DAII_FOUNDATION_CROSSCUTTING_SPEC.md §6.
 *
 * Domain code throws this (or a subclass) instead of inventing its own
 * error shape. `code` is a canonical, Terminology-Registry-eligible
 * string (e.g. "SALES_ORDER_NOT_FOUND") — never a free-text message
 * alone, per DAII_API_ARCHITECTURE.md §2.
 */
export class DaiiException extends HttpException {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status: HttpStatus, details?: Record<string, unknown>) {
    super(message, status);
    this.code = code;
    this.details = details;
  }
}
