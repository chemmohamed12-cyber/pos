import * as childProcess from 'child_process';
import { asText, runCapture } from './capture-process';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
const execFileMock = childProcess.execFile as unknown as jest.Mock;

/**
 * Release 1.1.7 on the shared host: `promisify(execFile)` handed back `stdout === undefined`, `stdout.trim()` threw and the pre-swap environment check blocked a valid release.
 * `runCapture` must deliver text in every shape the runtime may hand back, and never throw on a successful exit.
 */
describe('runCapture / asText', () => {
  const answer = (...cbArgs: unknown[]) => execFileMock.mockImplementation((_b: string, _a: string[], _o: unknown, cb: (...a: unknown[]) => void) => cb(...cbArgs));

  it('string stdout is returned as is', async () => {
    answer(null, '{"errors":[]}\n', '');
    expect(await runCapture('node', ['-e', 'x'])).toEqual({ stdout: '{"errors":[]}\n', stderr: '' });
  });
  it('Buffer stdout is decoded', async () => {
    answer(null, Buffer.from('hello'), Buffer.from(''));
    expect((await runCapture('node', [])).stdout).toBe('hello');
  });
  it('UNDEFINED stdout/stderr (the host quirk) => empty strings, no throw on a clean exit', async () => {
    answer(null, undefined, undefined);
    const r = await runCapture('node', []);
    expect(r).toEqual({ stdout: '', stderr: '' });
    expect(() => r.stdout.trim()).not.toThrow();
  });
  it('a failing exit rejects and keeps the child stderr on the error', async () => {
    answer(Object.assign(new Error('Command failed: node -e x'), { code: 1 }), '', 'ReferenceError: boom');
    await expect(runCapture('node', [])).rejects.toMatchObject({ stderr: 'ReferenceError: boom' });
  });
  it('asText: null/number/string/Buffer', () => {
    expect([asText(undefined), asText(null), asText(5), asText('a'), asText(Buffer.from('b'))]).toEqual(['', '', '5', 'a', 'b']);
  });
});
