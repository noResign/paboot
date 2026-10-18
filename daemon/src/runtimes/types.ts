import type { NormalizedEvent } from '../types/api.js';

export interface ModelParameterValue {
  id: string;
  label: string;
}

/**
 * A provider-defined knob the client may set alongside the model
 * (e.g. reasoning effort). Parameter ids are stable and runtime-agnostic so a
 * new runtime can advertise new knobs without changing the wire contract or
 * the clients' rendering: the catalog describes them, and `modelParameters`
 * carries the chosen values as a plain string map.
 */
export interface ModelParameter {
  id: string;
  /** Fallback label for clients that don't know this parameter id. */
  label: string;
  values: ModelParameterValue[];
  /** The provider's default for this model, when it reports one. */
  defaultId?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  /** Knobs this specific model accepts. Absent/empty = none. */
  parameters?: ModelParameter[];
}

/**
 * Feature flags a runtime adapter advertises after probing its `--help` /
 * probe output. The engine only passes flags the adapter itself confirmed,
 * so an older CLI never crashes on an unknown option.
 */
export interface RuntimeCapabilities {
  /** `--include-partial-messages` (richer text/thinking deltas). */
  partialMessages: boolean;
  /** stdin delivered as JSONL (`--input-format stream-json`). */
  inputStreamJson: boolean;
  /** `--resume <id>` continues an existing session. */
  resume: boolean;
  /** `--session-id <uuid>` starts a session with a host-controlled id. */
  sessionId: boolean;
  /** `--add-dir <path>` grants an extra allowed dir. */
  addDir: boolean;
  /** `--settings` lets the adapter inject a PreToolUse hook for permission asks. */
  permissionHook: boolean;
  /** `--effort <level>` accepts a reasoning-effort level. */
  effort: boolean;
}

export const defaultCapabilities: RuntimeCapabilities = {
  partialMessages: false,
  inputStreamJson: true,
  resume: true,
  sessionId: true,
  addDir: false,
  permissionHook: false,
  effort: false,
};

export interface RuntimeDetection {
  id: string;
  name: string;
  bin: string;
  available: boolean;
  version: string | null;
  authed: boolean | null;
  capabilities: RuntimeCapabilities;
  models: ModelOption[];
  error: string | null;
}

/**
 * A runtime-specific stdout parser. The adapter's `createParser` returns one;
 * the generic engine feeds raw stdout chunks into it and it emits normalized
 * events through the sink it was constructed with.
 */
export interface StreamParser {
  feed(chunk: string): void;
  flush(): void;
}

/** Everything the adapter needs to build a spawn command line. */
export interface SpawnContext {
  prompt: string;
  cwd: string;
  model?: string;
  /** Model parameters resolved from the session / request (e.g. reasoningEffort). */
  modelParameters?: Record<string, string>;
  resumeSessionId?: string;
  newSessionId?: string;
  permissionMode: string;
  env: NodeJS.ProcessEnv;
  capabilities: RuntimeCapabilities;
  /**
   * Extra dirs beyond `cwd` the runtime should also be allowed to touch
   * (Claude Code: `--add-dir`). The engine also exports these to the
   * permission hook so in-scope reads skip the daemon round-trip.
   */
  extraDirs?: string[];
  /** When set, the adapter wires tool-permission asks to a PreToolUse hook. */
  permissionHook?: { settingsJson: string };
}

/**
 * The pluggable-runtime boundary. Adding a new agent (Codex, OpenCode,
 * DeepSeek Harness, …) means implementing this interface and registering it in
 * `registry.ts`; the engine, routes, persistence, and transport stay untouched.
 */
export interface RuntimeAdapter {
  id: string;
  name: string;
  bin: string;
  /** Keep stdin open after the initial prompt (stream-json style input). */
  keepStdinOpen: boolean;
  /** Probe version / auth / capabilities. Runs before a spawn. */
  detect(env: NodeJS.ProcessEnv): Promise<RuntimeDetection>;
  /** Build the child-process argv (without the bin). */
  buildArgs(ctx: SpawnContext): string[];
  /** Construct the stdout parser for this runtime. */
  createParser(onEvent: (ev: NormalizedEvent) => void): StreamParser;
  /** Encode a user message into the runtime's stdin format (with newline). */
  encodeUserMessage(text: string): string;
}
