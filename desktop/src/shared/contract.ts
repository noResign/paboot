/**
 * The transport contract, re-exported from the daemon package's `./protocol`
 * subpath. This is the *only* place the daemon's wire types enter the desktop
 * app, and it is intentionally type-only: the import is erased at build time so
 * no daemon (or Node/Express) code ever reaches either bundle.
 *
 * Copying these types instead of importing them is forbidden — drift here is
 * the failure mode we care most about. See tests/protocol-purity.test.ts.
 */
export type * from '@noresign/paboot/protocol';

import type { ProductPermissionMode, RunDto, SessionDto, WorkspaceDto } from '@noresign/paboot/protocol';

// `HealthDto` is part of the protocol now (`daemon/src/types/api.ts`) and reaches
// here through the re-export above — declaring it again would be a copy.

export interface AgentDto {
  id: string;
  name: string;
  bin: string;
  available: boolean;
}

export interface AgentsResponse {
  agents: AgentDto[];
}

export interface ModelParameterValueDto {
  id: string;
  label: string;
}

/** A knob a model accepts (e.g. reasoning effort), described by the daemon. */
export interface ModelParameterDto {
  id: string;
  label: string;
  values: ModelParameterValueDto[];
  defaultId?: string;
}

/** `GET /api/agents/:id/models` — the models one runtime offers. */
export interface ModelOptionDto {
  id: string;
  label: string;
  parameters?: ModelParameterDto[];
}

export interface AgentModelsResponse {
  models: ModelOptionDto[];
}

/** `PATCH /api/sessions/:id/model` — applies from the next run onward. */
export interface UpdateSessionModelResponse {
  ok: boolean;
  effective: 'next_run';
  session: SessionDto;
}

export interface SessionsResponse {
  sessions: SessionDto[];
}

export interface WorkspacesResponse {
  workspaces: WorkspaceDto[];
}

/** `POST` / `PATCH /api/workspaces[/:id]` — the daemon echoes the stored row. */
export interface WorkspaceResponse {
  ok: boolean;
  workspace: WorkspaceDto;
}

/** `POST` / `DELETE /api/workspaces/:id/dirs` — the full list after the change. */
export interface WorkspaceDirsResponse {
  ok: boolean;
  dirs: string[];
}

/** `POST` / `DELETE /api/workspaces/:id/shortcuts` — files-tab bookmarks. Unlike
 *  `dirs`, they grant the agent nothing; they are just extra roots to browse. */
export interface WorkspaceShortcutsResponse {
  ok: boolean;
  shortcutDirs: string[];
}

/** `DELETE /api/workspaces/:id` — how many sessions the cascade took with it. */
export interface DeleteWorkspaceResponse {
  ok: boolean;
  id: string;
  deletedSessions: number;
}

export interface DirectoryEntryDto {
  name: string;
  path: string;
  /** Already a workspace: the picker tags it, and blocks "choose this folder" when creating. */
  isWorkspace: boolean;
}

/** `GET /api/fs/directories` — one level of a tree, folders only. */
export interface DirectoriesResponse {
  path: string;
  /** null at the filesystem root (`/`). */
  parent: string | null;
  entries: DirectoryEntryDto[];
}

/** `GET/PATCH /api/config` — daemon-side defaults. */
export interface ConfigResponse {
  /** Applied to a new session whose request omits `permissionMode`. */
  defaultPermissionMode: ProductPermissionMode;
  defaultWorkspaceId: string | null;
  workspaces: Array<{ id: string; name: string; path: string; isDefault: boolean; enabled: boolean }>;
  server: { host: string; port: number; dataDir: string; tls: boolean; restartRequired: string[] };
}

/**
 * `GET /api/sessions/:id`. `messages` are raw DB rows in snake_case — the one
 * place in the contract that lies. Adapters keep that shape out of the store;
 * see store/chat/history.ts (M1 step 7).
 */
export interface SessionDetailResponse {
  session: SessionDto;
  messages: unknown[];
  runs: RunDto[];
}
