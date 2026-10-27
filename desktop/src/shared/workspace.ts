/**
 * Fallback offered when starting a local daemon and the user has no project in
 * mind. It is a subdirectory of the daemon data root rather than the root
 * itself: the agent may write anywhere inside its workspace, while the root
 * holds the token and the SQLite DB. `~` is expanded by the daemon.
 *
 * The daemon marks this path as its built-in workspace: it is the default only
 * while no real workspace exists, and clients stop listing it once one does.
 */
export const DEFAULT_WORKSPACE_PATH = '~/.paboot/defaultworkspace';
