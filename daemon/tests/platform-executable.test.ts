import { describe, expect, it } from 'vitest';
import { runExecutable } from '../src/platform/executable';

describe('runExecutable', () => {
  it('runs a process and collects stdout', async () => {
    const result = await runExecutable(process.execPath, ['-e', 'console.log("ok")']);
    expect(result).toMatchObject({ ok: true, code: 0, error: null });
    expect(result.stdout.trim()).toBe('ok');
  });

  it('reports a missing command instead of throwing', async () => {
    const result = await runExecutable('/nonexistent/paboot-definitely-missing', ['--version']);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('kills a probe that exceeds its timeout', async () => {
    const result = await runExecutable(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
      timeoutMs: 150,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('stops collecting when the output limit is reached', async () => {
    const result = await runExecutable(process.execPath, ['-e', 'console.log("x".repeat(4096))'], {
      maxBuffer: 128,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('output exceeded');
  });
});
