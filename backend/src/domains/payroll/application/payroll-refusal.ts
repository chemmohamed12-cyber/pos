import { ConflictException, NotFoundException } from '@nestjs/common';

/** Values the screen substitutes into the registered `error.<code>` label (`{name}` placeholders). */
export type RefusalParams = Record<string, string | number>;

const body = (statusCode: number, code: string, message: string, params: RefusalParams) => ({ statusCode, code, message, params, localizable: true });

/**
 * A payroll refusal that keeps its own stable code through the error envelope (the exception filter honours `localizable`), so the screen can show the registered
 * Arabic/English label instead of the English `message`. Same HTTP classes and messages as before — only the code and parameters are added.
 */
export const conflict = (code: string, message: string, params: RefusalParams = {}): ConflictException => new ConflictException(body(409, code, message, params));
export const notFound = (code: string, message: string, params: RefusalParams = {}): NotFoundException => new NotFoundException(body(404, code, message, params));
