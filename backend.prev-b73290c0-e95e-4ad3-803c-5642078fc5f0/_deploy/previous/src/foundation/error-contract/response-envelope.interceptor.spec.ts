import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

describe('ResponseEnvelopeInterceptor', () => {
  const interceptor = new ResponseEnvelopeInterceptor();

  function contextWith(correlationId: string): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ correlationId }) }),
    } as unknown as ExecutionContext;
  }

  it('wraps raw controller data into the shared envelope', (done) => {
    const handler: CallHandler = { handle: () => of({ id: 'abc' }) };
    interceptor.intercept(contextWith('corr-1'), handler).subscribe((result) => {
      expect(result).toEqual({ success: true, data: { id: 'abc' }, meta: { correlationId: 'corr-1' } });
      done();
    });
  });

  it('passes through data that already has a success flag unchanged', (done) => {
    const already = { success: true, data: { id: 'abc' }, meta: { note: 'already enveloped' } };
    const handler: CallHandler = { handle: () => of(already) };
    interceptor.intercept(contextWith('corr-2'), handler).subscribe((result) => {
      expect(result).toBe(already);
      done();
    });
  });
});
