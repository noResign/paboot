import fs from 'node:fs';
import path from 'node:path';

import type { PathCapability, ResolvedPathPolicy } from '../types.js';

export class PathPolicyError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_path'
      | 'denied_root'
      | 'outside_allowed_roots'
      | 'capability_denied'
      | 'symlink_escape',
  ) {
    super(message);
    this.name = 'PathPolicyError';
  }
}

export interface PathAccessRequest {
  policy: ResolvedPathPolicy;
  cwd: string;
  requestedPath: string;
  capability: PathCapability;
}

export interface PathAccessResult {
  /** Real path when the target exists; canonicalized parent + tail for writes. */
  path: string;
}

/**
 * Resolve one model-requested path against the effective filesystem policy.
 * `bypass` intentionally skips root/symlink containment checks; OS permissions
 * and the surrounding sandbox remain the boundary.
 */
export function resolvePathAccess(request: PathAccessRequest): PathAccessResult {
  if (!request.requestedPath || request.requestedPath.includes('\0')) {
    throw new PathPolicyError('invalid path', 'invalid_path');
  }
  const absolute = path.isAbsolute(request.requestedPath)
    ? path.resolve(request.requestedPath)
    : path.resolve(request.cwd, request.requestedPath);

  if (request.policy.mode === 'bypass') {
    return { path: canonicalizeForAccess(absolute) };
  }

  const lexicalDenied = request.policy.denyRoots.some((root) =>
    isInside(path.resolve(root), absolute),
  );
  if (lexicalDenied) throw new PathPolicyError('path is denied by policy', 'denied_root');

  const canonical = canonicalizeForAccess(absolute);
  const resolvedDenied = request.policy.denyRoots.some((root) => {
    const canonicalRoot = canonicalizeRoot(root);
    return isInside(canonicalRoot, canonical);
  });
  if (resolvedDenied) throw new PathPolicyError('path is denied by policy', 'denied_root');

  const matching = request.policy.grants.filter((grant) => {
    const canonicalRoot = canonicalizeRoot(grant.root);
    return isInside(canonicalRoot, canonical) && isInside(canonicalRoot, absolute);
  });
  if (matching.length === 0) {
    throw new PathPolicyError('path is outside allowed roots', 'outside_allowed_roots');
  }
  if (!matching.some((grant) => grant.capabilities.includes(request.capability))) {
    throw new PathPolicyError(
      `path capability "${request.capability}" is not granted`,
      'capability_denied',
    );
  }
  return { path: canonical };
}

/**
 * resolve the real location of the nearest existing ancestor, then append the
 * not-yet-existing tail. This catches symlinked directories while still
 * allowing Write/Edit to target a file that does not exist yet.
 */
function canonicalizeForAccess(absolute: string): string {
  if (fs.existsSync(absolute)) {
    try {
      return fs.realpathSync.native(absolute);
    } catch {
      throw new PathPolicyError('path cannot be resolved', 'symlink_escape');
    }
  }
  let probe = absolute;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const realProbe = fs.realpathSync.native(probe);
    return path.resolve(realProbe, path.relative(probe, absolute));
  } catch {
    throw new PathPolicyError('path cannot be resolved', 'symlink_escape');
  }
}

function canonicalizeRoot(root: string): string {
  const absolute = path.resolve(root);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
