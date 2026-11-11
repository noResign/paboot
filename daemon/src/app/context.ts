import type { Config } from './config.js';
import type { Db } from '../db/db.js';
import type { AttachmentStore } from '../attachments/store.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { MemoryKnowledgeIndexer } from '../memory/knowledge-index.js';
import type { MemoryStore } from '../memory/store.js';
import type { MemoryWorker } from '../memory/worker.js';
import type { ProviderManager } from '../providers/provider-manager.js';
import type { PermissionManager } from '../permissions/permissions.js';
import type { RunNotifier } from '../runs/run-notifier.js';
import type { Registry } from '../runtimes/registry.js';
import type { BuiltinRuntimeConfig } from '../runtimes/builtin/config.js';
import type { DeviceStreamHub } from '../capabilities/device-stream.js';
import type { MockStore } from '../capabilities/mock-store.js';
import type { DeviceProvider } from '../capabilities/types.js';
import type { DebugRecorder } from '../debug/recorder.js';

/**
 * Shared dependency object threaded through route registrars. Keep this the
 * single place where daemon-wide services are wired, so adding a runtime or a
 * new domain never forces routes to reach into globals.
 */
export interface AppContext {
  config: Config;
  db: Db;
  /** Curated knowledge documents (K0); file-backed, no memory.db. */
  knowledge: KnowledgeStore;
  /** K2 mirror into memory.db; optional in partial test contexts. */
  knowledgeIndex?: MemoryKnowledgeIndexer;
  /** `paboot_memory` MCP entry; set by the composition root. */
  memoryMcpServerPath?: string;
  /**
   * Long-term memory (`<dataDir>/memory/memory.db`). Optional in partial test
   * contexts; production always wires it and run capture degrades to a no-op.
   */
  memory?: MemoryStore;
  /** Background consolidation loop; starts after the HTTP server is listening. */
  memoryWorker?: MemoryWorker;
  /** Immutable image bytes + SQLite metadata. */
  attachments: AttachmentStore;
  /** Shared provider catalog + write-only credential store for builtin/Memory. */
  providers: ProviderManager;
  /** Central builtin runtime budgets (`<dataDir>/builtin.json`, defaults in code). */
  builtinConfig: BuiltinRuntimeConfig;
  registry: Registry;
  permissions: PermissionManager;
  notifier: RunNotifier;
  /** Absolute path to the compiled PreToolUse permission-hook script. */
  hookPath: string;
  /** Absolute path to the compiled `paboot_tasks` MCP server entry. */
  mcpServerPath: string;
  /** Absolute path to the compiled `paboot_capability` MCP server entry. */
  capabilityMcpServerPath: string;
  /** Device provider shared by capability routes; optional in partial tests. */
  deviceProvider?: DeviceProvider;
  /** On-demand screenshot mirror loops for the desktop device tab. */
  deviceStream?: DeviceStreamHub;
  /** File-backed workspace mock model (Dev Space S2). */
  mockStore?: MockStore;
  /** [debug] In-memory live context audit behind `/debug`; optional in partial tests. */
  debug?: DebugRecorder;
}
