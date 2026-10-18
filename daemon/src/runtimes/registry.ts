import { claudeAdapter } from './claude/adapter.js';
import { detectCodex } from './codex/detect.js';
import { listCodexModels } from './codex/models.js';
import { log } from '../log.js';
import type { RuntimeDriver } from './RuntimeDriver.js';
import type { ModelOption, RuntimeAdapter, RuntimeDetection } from './types.js';

/**
 * A runtime the daemon knows about but which cannot implement `RuntimeAdapter`.
 *
 * `RuntimeAdapter` describes an argv+stdout contract (`buildArgs` →
 * `createParser` → `encodeUserMessage`). Codex is a JSON-RPC peer, driven by
 * `codex/session.ts`, so there is no argv to build and no line stream to parse.
 * The registry still has to answer "is this runtime installed?" and "which
 * models does it offer?", which is all this carries.
 */
export interface RuntimeDetector {
  id: string;
  name: string;
  bin: string;
  detect(env: NodeJS.ProcessEnv): Promise<RuntimeDetection>;
  /**
   * Enumerate the models this runtime offers. Optional: argv runtimes report
   * their catalogue through `detect().models` instead.
   */
  listModels?(env: NodeJS.ProcessEnv): Promise<ModelOption[]>;
}

export interface Registry {
  /** argv-driven runtimes, for wiring their drivers at bootstrap. */
  adapters(): RuntimeAdapter[];
  list(): Array<Pick<RuntimeAdapter, 'id' | 'name' | 'bin'>>;
  /** Probe a runtime and cache the detection. */
  detect(id: string, env: NodeJS.ProcessEnv): Promise<RuntimeDetection | undefined>;
  /** Return the cached detection without re-probing. */
  detection(id: string): RuntimeDetection | undefined;
  /** Models offered by a runtime, or `undefined` for an unknown runtime. */
  listModels(id: string, env: NodeJS.ProcessEnv): Promise<ModelOption[] | undefined>;
  /** Register the execution driver for a runtime id (argv or RPC). */
  registerDriver(driver: RuntimeDriver): void;
  /** The driver for a runtime, if one is registered. */
  driver(id: string): RuntimeDriver | undefined;
}

const CODEX_BIN = 'codex';

const DETECTORS: RuntimeDetector[] = [
  {
    id: 'codex',
    name: 'Codex',
    bin: CODEX_BIN,
    detect: (env) => detectCodex(CODEX_BIN, env),
    listModels: (env) => listCodexModels(CODEX_BIN, env),
  },
];

/**
 * Runtime registry. Claude enters through `RuntimeAdapter`; Codex enters
 * through `RuntimeDetector` because it is driven over RPC. Detection (is it
 * installed? which models?) is orthogonal to driving: every runtime is
 * probeable, and drivers are registered separately by id.
 */
export function createRegistry(): Registry {
  const adapters = new Map<string, RuntimeAdapter>();
  const detectors = new Map<string, RuntimeDetector>();
  const detections = new Map<string, RuntimeDetection>();
  const drivers = new Map<string, RuntimeDriver>();

  adapters.set(claudeAdapter.id, claudeAdapter);
  for (const detector of DETECTORS) detectors.set(detector.id, detector);
  // Future: adapters.set(deepseekHarnessAdapter.id, deepseekHarnessAdapter);

  const source = (id: string): RuntimeAdapter | RuntimeDetector | undefined =>
    adapters.get(id) ?? detectors.get(id);

  const detectAndCache = async (id: string, env: NodeJS.ProcessEnv): Promise<RuntimeDetection | undefined> => {
    const found = source(id);
    if (!found) return undefined;
    const detection = await found.detect(env);
    detections.set(id, detection);
    return detection;
  };

  // A catalogue can cost a process spawn (Codex `model/list`), so cache
  // successes for five minutes and failures briefly. Sharing the in-flight
  // promise keeps two pickers opening at once from spawning two processes.
  const MODEL_CACHE_MS = 5 * 60_000;
  const MODEL_FAILURE_CACHE_MS = 30_000;
  const modelCache = new Map<string, { at: number; ttl: number; models: ModelOption[] }>();
  const modelInflight = new Map<string, Promise<ModelOption[]>>();

  const listModels = async (id: string, env: NodeJS.ProcessEnv): Promise<ModelOption[] | undefined> => {
    if (!adapters.has(id) && !detectors.has(id)) return undefined;

    const detector = detectors.get(id);
    // argv runtimes advertise their catalogue through detection.
    if (!detector?.listModels) {
      const detection = detections.get(id) ?? (await detectAndCache(id, env));
      return detection?.models ?? [];
    }

    const cached = modelCache.get(id);
    if (cached && Date.now() - cached.at < cached.ttl) return cached.models;

    const inflight = modelInflight.get(id);
    if (inflight) return inflight;

    const promise = detector
      .listModels(env)
      .then((models) => {
        modelCache.set(id, { at: Date.now(), ttl: MODEL_CACHE_MS, models });
        return models;
      })
      .catch((err: unknown) => {
        log.warn(`failed to list models for ${id}: ${err instanceof Error ? err.message : String(err)}`);
        const models: ModelOption[] = [];
        modelCache.set(id, { at: Date.now(), ttl: MODEL_FAILURE_CACHE_MS, models });
        return models;
      })
      .finally(() => modelInflight.delete(id));

    modelInflight.set(id, promise);
    return promise;
  };

  return {
    adapters() {
      return [...adapters.values()];
    },
    list() {
      return [...adapters.values(), ...detectors.values()];
    },
    detect: detectAndCache,
    detection(id) {
      return detections.get(id);
    },
    listModels,
    registerDriver(driver) {
      drivers.set(driver.id, driver);
    },
    driver(id) {
      return drivers.get(id);
    },
  };
}
