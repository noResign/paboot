import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../src/types/api';
import { createCommandDriver } from '../src/runtimes/command';

function start(command: string, idleTimeoutMs = 0) {
  const events: NormalizedEvent[] = [];
  const driver = createCommandDriver({ idleTimeoutMs });
  const run = driver.start({
    runId: `run-${Math.random()}`,
    sessionId: 'session',
    prompt: command,
    cwd: process.cwd(),
    permissionMode: 'bypass',
    onNativeSessionId: () => {},
    onEvent: (event) => events.push(event),
  });
  return { run, events };
}

describe('command driver', () => {
  it('streams output and reports the exit code', async () => {
    const { run, events } = start('printf hello');
    const outcome = await run.promise;

    expect(outcome).toEqual({ status: 'succeeded', exitCode: 0, error: null });
    expect(events[0]).toMatchObject({ type: 'tool_use', name: 'Bash', input: { command: 'printf hello' } });
    expect(events.some((event) => event.type === 'text_delta' && event.delta === 'hello')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'tool_result', isError: false, content: 'exit code 0' });
  });

  it('reports a non-zero exit as failed', async () => {
    const { run, events } = start('exit 3');
    const outcome = await run.promise;

    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(3);
    expect(events.at(-1)).toMatchObject({ type: 'tool_result', isError: true });
  });

  it('cancels the process and closes the tool call', async () => {
    const { run, events } = start('sleep 5');
    await new Promise((resolve) => setTimeout(resolve, 50));
    run.cancel('cancelled');

    const outcome = await run.promise;
    expect(outcome.status).toBe('cancelled');
    expect(outcome.error).toBe('cancelled');
    expect(events.at(-1)).toMatchObject({ type: 'tool_result', isError: true, interrupted: true });
  });

  it('cancels a silent command after the idle timeout', async () => {
    const { run } = start('sleep 5', 50);
    const outcome = await run.promise;

    expect(outcome.status).toBe('cancelled');
    expect(outcome.error).toBe('idle timeout');
  });
});
