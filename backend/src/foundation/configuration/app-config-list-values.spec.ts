import { ConfigService } from '@nestjs/config';
import { AppConfigService, parseJsonStringArray } from './app-config.service';

/**
 * Release 1.1.7 host evidence: the shared host's environment editor delivers `["a","b"]` as `[a,b]`. Every list-like environment value must survive that (or say exactly what to do).
 */
describe('list-like environment values', () => {
  it('RELEASE_HEALTH_ENDPOINTS / RELEASE_SMOKE_GET_ENDPOINTS style: JSON array, plain list, quote-stripped list', () => {
    const expected = ['/api/health', '/api/health/deep'];
    expect(parseJsonStringArray('["/api/health","/api/health/deep"]', 'K')).toEqual(expected);
    expect(parseJsonStringArray('[/api/health,/api/health/deep]', 'K')).toEqual(expected); // what the host delivers
    expect(parseJsonStringArray('/api/health, /api/health/deep', 'K')).toEqual(expected);
    expect(parseJsonStringArray(undefined, 'K')).toEqual([]);
    expect(parseJsonStringArray('', 'K')).toEqual([]);
    expect(parseJsonStringArray('[]', 'K')).toEqual([]);
  });
  it('a JSON value that is not a list of strings is a loud error naming the key', () => {
    expect(() => parseJsonStringArray('{"a":1}', 'RELEASE_HEALTH_ENDPOINTS')).toThrow('RELEASE_HEALTH_ENDPOINTS');
    expect(() => parseJsonStringArray('[1,2]', 'RELEASE_HEALTH_ENDPOINTS')).toThrow('RELEASE_HEALTH_ENDPOINTS');
  });

  describe('ENTITLEMENT_PUBLIC_KEYS (JSON objects cannot survive quote stripping)', () => {
    const keys = [{ kid: 'k1', spki_b64: 'AAAA' }];
    const svc = (value?: string) => new AppConfigService({ get: (k: string) => (k === 'ENTITLEMENT_PUBLIC_KEYS' ? value : k === 'ENTITLEMENT_MODE' ? 'enforced' : 5) } as unknown as ConfigService);
    it('plain JSON still works', () => expect(svc(JSON.stringify(keys)).entitlement.publicKeys).toEqual(keys));
    it('base64:<json> works (the form that survives the host editor)', () => expect(svc('base64:' + Buffer.from(JSON.stringify(keys)).toString('base64')).entitlement.publicKeys).toEqual(keys));
    it('the quote-stripped form fails loudly and tells the operator the base64 form', () => expect(() => svc('[{kid:k1,spki_b64:AAAA}]').entitlement).toThrow(/base64:/));
    it('unset => no keys', () => expect(svc(undefined).entitlement.publicKeys).toEqual([]));
  });
});
