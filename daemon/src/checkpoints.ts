import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChangesError, MAX_PATCH_CHARS, gitRootFor, runGit, type ChangedFile, type ChangeStatus } from './changes.js';

/**
 * Per-run workspace checkpoints, kept as hidden git refs
 * (`refs/paboot/checkpoints/<key>`). Snapshots and restores use a throwaway
 * index (`GIT_INDEX_FILE`), so the user's real index, HEAD and staged state are
 * never touched. Everything here is git-repo-only — callers gate on
 * `gitRootFor` first and degrade to "unavailable" when the cwd is not a repo.
 */

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'paboot',
  GIT_AUTHOR_EMAIL: 'paboot@localhost',
  GIT_COMMITTER_NAME: 'paboot',
  GIT_COMMITTER_EMAIL: 'paboot@localhost',
} as const;

/** Explicit author/committer so `commit-tree` never depends on the host's git identity. */
function gitEnv(indexFile: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_INDEX_FILE: indexFile, ...AUTHOR_ENV };
}

function tempIndex(key: string): string {
  const safe = key.replace(/[^\w.-]/g, '_');
  return path.join(os.tmpdir(), `paboot-ckpt-${process.pid}-${Date.now()}-${safe}.index`);
}

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
}

function stdoutOrNull(result: Awaited<ReturnType<typeof runGit>>): string | null {
  return result.ok ? result.stdout : null;
}

function splitZ(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

/** The git repo root containing `cwd`, or null when it is not a repo (or git is missing). */
export async function repoRootFor(cwd: string): Promise<string | null> {
  try {
    return await gitRootFor(cwd);
  } catch {
    return null;
  }
}

/**
 * Snapshot the whole working tree (modifications, additions and deletions) of
 * `repoRoot` into `refs/paboot/checkpoints/<key>`. Returns the commit sha, or
 * null when git is missing or the snapshot could not be written.
 */
export async function captureCheckpoint(repoRoot: string, key: string): Promise<string | null> {
  const indexFile = tempIndex(key);
  try {
    const env = gitEnv(indexFile);
    // Seed from HEAD so deletions show up as deletions; an unborn branch has no
    // tree to read, so that one failure is expected and ignored.
    await runGit(repoRoot, ['read-tree', 'HEAD'], env);
    const added = await runGit(repoRoot, ['add', '-A', '--', '.'], env);
    if (!added.ok) return null;
    const tree = stdoutOrNull(await runGit(repoRoot, ['write-tree'], env))?.trim();
    if (!tree) return null;
    const commit = stdoutOrNull(
      await runGit(repoRoot, ['commit-tree', tree, '-m', `paboot checkpoint ${key}`], env),
    )?.trim();
    if (!commit) return null;
    const ref = await runGit(repoRoot, ['update-ref', `refs/paboot/checkpoints/${key}`, commit]);
    if (!ref.ok) return null;
    return commit;
  } finally {
    unlinkQuiet(indexFile);
  }
}

function statusFromLetter(letter: string): ChangeStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

interface NumStat {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

function parseNumstat(output: string): Map<string, NumStat> {
  const stats = new Map<string, NumStat>();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const binary = parts[0] === '-';
    const additions = binary ? null : Number(parts[0]);
    const deletions = binary ? null : Number(parts[1]);
    stats.set(parts.slice(2).join('\t'), {
      additions: additions !== null && Number.isFinite(additions) ? additions : null,
      deletions: deletions !== null && Number.isFinite(deletions) ? deletions : null,
      binary,
    });
  }
  return stats;
}

/** Files changed between two checkpoint refs, with repo-root-relative paths. */
export async function diffRefs(repoRoot: string, from: string, to: string): Promise<ChangedFile[]> {
  const prefix = ['-c', 'core.quotePath=false'];
  const [nameStatus, numstat] = await Promise.all([
    runGit(repoRoot, [...prefix, 'diff', '--name-status', '--no-ext-diff', from, to, '--']),
    runGit(repoRoot, [...prefix, 'diff', '--numstat', '--no-ext-diff', from, to, '--']),
  ]);
  if (!nameStatus.ok) {
    throw new ChangesError(`git diff failed: ${nameStatus.stderr}`, 'git_failed', 500);
  }
  const stats = numstat.ok ? parseNumstat(numstat.stdout) : new Map<string, NumStat>();

  const files: ChangedFile[] = [];
  for (const line of nameStatus.stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    if (!code) continue;
    const letter = code[0] ?? 'M';
    let filePath: string | undefined;
    let oldPath: string | null = null;
    if (letter === 'R' || letter === 'C') {
      oldPath = parts[1] ?? null;
      filePath = parts[2];
    } else {
      filePath = parts[1];
    }
    if (!filePath) continue;
    const stat = stats.get(filePath);
    files.push({
      path: filePath,
      oldPath,
      status: statusFromLetter(letter),
      staged: false,
      binary: stat?.binary ?? false,
      isDirectory: false,
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export interface RefPatch {
  patch: string;
  binary: boolean;
  truncated: boolean;
}

/** The unified patch for one file between two checkpoint refs. */
export async function patchRefFile(
  repoRoot: string,
  from: string,
  to: string,
  relativePath: string,
): Promise<RefPatch> {
  const result = await runGit(repoRoot, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '-M',
    '--unified=3',
    from,
    to,
    '--',
    relativePath,
  ]);
  const raw = result.ok ? result.stdout : '';
  const binary = /^Binary files .* differ$/m.test(raw) || raw.includes('GIT binary patch');
  const truncated = raw.length > MAX_PATCH_CHARS;
  return { patch: binary ? '' : raw.slice(0, MAX_PATCH_CHARS), binary, truncated };
}

/**
 * Make the working tree of `repoRoot` match `ref` exactly: overwrite files the
 * ref has, and delete files present now but absent from the ref (e.g. files a
 * run added). The real index/HEAD/staged state is left untouched.
 *
 * Destructive and hard to reverse — callers snapshot the current tree first.
 */
export async function restoreToRef(repoRoot: string, ref: string): Promise<void> {
  const indexFile = tempIndex('restore');
  try {
    const env = gitEnv(indexFile);
    const read = await runGit(repoRoot, ['read-tree', ref], env);
    if (!read.ok) {
      throw new ChangesError(`failed to read checkpoint ${ref}: ${read.stderr}`, 'git_failed', 500);
    }
    const checkout = await runGit(repoRoot, ['checkout-index', '-a', '-f'], env);
    if (!checkout.ok) {
      throw new ChangesError(`failed to restore files: ${checkout.stderr}`, 'git_failed', 500);
    }

    // checkout-index writes files but never removes them, so delete anything the
    // ref does not contain: tracked-or-untracked files currently on disk minus
    // the ref's file list.
    const target = new Set(splitZ(stdoutOrNull(await runGit(repoRoot, ['ls-files', '-z'], env)) ?? ''));
    const current = splitZ(
      stdoutOrNull(
        await runGit(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
      ) ?? '',
    );
    for (const rel of current) {
      if (target.has(rel)) continue;
      unlinkQuiet(path.join(repoRoot, rel));
    }
  } finally {
    unlinkQuiet(indexFile);
  }
}
