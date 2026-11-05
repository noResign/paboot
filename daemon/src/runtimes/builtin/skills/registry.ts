import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { SkillManifest } from '../types.js';

export interface SkillRoot {
  source: 'workspace' | 'user';
  /** Directory containing one `<skill-id>/SKILL.md` per skill. */
  path: string;
}

export interface SkillRegistryOptions {
  maxFileBytes?: number;
}

export interface LoadedSkill extends SkillManifest {
  body: string;
}

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * File-backed skill catalog. Workspace roots listed before user roots override
 * same-id user skills. SKILL.md frontmatter is intentionally tiny; no YAML
 * dependency is needed for the P3 contract.
 */
export class SkillRegistry {
  private readonly maxFileBytes: number;

  constructor(
    private readonly roots: readonly SkillRoot[],
    options: SkillRegistryOptions = {},
  ) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  list(): SkillManifest[] {
    const byId = new Map<string, SkillManifest>();
    for (const root of this.roots) {
      for (const manifest of discoverRoot(root, this.maxFileBytes)) {
        if (!byId.has(manifest.id)) byId.set(manifest.id, manifest);
      }
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  load(id: string): LoadedSkill | null {
    if (!SKILL_ID_PATTERN.test(id)) return null;
    for (const root of this.roots) {
      const manifest = parseSkillAt(root, id, this.maxFileBytes);
      if (manifest) return manifest;
    }
    return null;
  }
}

function discoverRoot(root: SkillRoot, maxFileBytes: number): SkillManifest[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root.path, { withFileTypes: true });
  } catch {
    return [];
  }
  const manifests: SkillManifest[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !SKILL_ID_PATTERN.test(entry.name)) continue;
    const manifest = parseSkillAt(root, entry.name, maxFileBytes);
    if (manifest) manifests.push(manifest);
  }
  return manifests;
}

function parseSkillAt(root: SkillRoot, id: string, maxFileBytes: number): LoadedSkill | null {
  if (!SKILL_ID_PATTERN.test(id)) return null;
  const skillDir = path.join(root.path, id);
  const filePath = path.join(skillDir, 'SKILL.md');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxFileBytes) return null;
  let realDir: string;
  let realFile: string;
  try {
    realDir = fs.realpathSync(skillDir);
    realFile = fs.realpathSync(filePath);
  } catch {
    return null;
  }
  if (!isInside(realDir, realFile)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(realFile, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseSkillDocument(raw);
  if (!parsed) return null;
  return {
    id,
    name: parsed.name || id,
    description: parsed.description,
    ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
    source: root.source,
    path: filePath,
    version: createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16),
    ...(parsed.allowedTools.length > 0 ? { allowedTools: parsed.allowedTools } : {}),
    body: parsed.body,
  };
}

interface ParsedSkillDocument {
  name: string;
  description: string;
  whenToUse?: string;
  allowedTools: string[];
  body: string;
}

function parseSkillDocument(raw: string): ParsedSkillDocument | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const value = unquote(trimmed.slice(colon + 1).trim());
    fields.set(key, value);
  }
  const description = fields.get('description') ?? '';
  if (!description) return null;
  const name = fields.get('name') ?? '';
  const whenToUse = fields.get('when-to-use') ?? fields.get('when_to_use') ?? fields.get('whentouse');
  const allowedTools = (fields.get('allowed-tools') ?? fields.get('allowed_tools') ?? fields.get('allowedtools') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    name,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    allowedTools,
    body: raw.slice(match[0].length).trim(),
  };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
