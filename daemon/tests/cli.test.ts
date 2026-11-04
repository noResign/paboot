import { describe, expect, it } from 'vitest';
import { parseCliArgs, printHelp } from '../src/app/cli';

describe('cli print-operator-token', () => {
  it('parses the flag and defaults to off', () => {
    expect(parseCliArgs([]).printOperatorToken).toBe(false);
    expect(parseCliArgs(['--print-operator-token']).printOperatorToken).toBe(true);
  });

  it('documents the flag in help', () => {
    expect(printHelp()).toContain('--print-operator-token');
  });
});
