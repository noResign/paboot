#!/usr/bin/env node
/**
 * Multi-agent shadow-table reconciliation (P0).
 *
 * P0 adds `agents` / `session_agents` / `agent_threads` / `session_turns` /
 * `agent_tasks` and dual-writes into them, but nothing in the request path reads
 * them yet — which means drift here is invisible to users and to the normal test
 * suite. This script is the only thing that can tell "the shadow tables are
 * consistent" from "they quietly rotted".
 *
 * It is read-only. It never repairs: P0's contract is that a wrong shadow row is
 * a bug to investigate, not a state to paper over.
 *
 * Exits 1 when a check fails, so it can gate CI or a nightly cron.
 *
 * Usage:
 *   pnpm verify:shadow                          # default data dir
 *   pnpm verify:shadow -- --data-dir ~/.paboot
 *   pnpm verify:shadow -- --db /path/paboot.sqlite --json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db/db.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function parseArgs(argv: string[]): { dbPath: string; json: boolean } {
  let dbPath = path.join(os.homedir(), '.paboot', 'paboot.sqlite');
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--db' && argv[i + 1]) {
      dbPath = path.resolve(argv[i + 1]!);
      i += 1;
      continue;
    }
    if (arg === '--data-dir' && argv[i + 1]) {
      dbPath = path.join(path.resolve(argv[i + 1]!), 'paboot.sqlite');
      i += 1;
    }
  }
  return { dbPath, json };
}

function runChecks(db: Db): Check[] {
  const counts = db.shadowTableCounts();
  const checks: Check[] = [];

  checks.push({
    name: 'every live session has a leader',
    ok: counts.withLeader === counts.liveSessions,
    detail: `${counts.withLeader}/${counts.liveSessions} sessions have a leader row`,
  });

  checks.push({
    name: 'every live session has a thread',
    ok: counts.withThread === counts.liveSessions,
    detail: `${counts.withThread}/${counts.liveSessions} sessions have a thread row`,
  });

  checks.push({
    name: 'no orphan threads',
    ok: counts.orphanThreads === 0,
    detail: `${counts.orphanThreads} thread row(s) point at a missing session`,
  });

  checks.push({
    name: 'dual write agrees on native session id',
    ok: counts.dualWriteMismatch === 0,
    detail:
      counts.dualWriteMismatch === 0
        ? 'sessions.native_session_id matches agent_threads.native_session_id wherever both are set'
        : `${counts.dualWriteMismatch} session(s) disagree with their thread`,
  });

  // Implicit agents must be unique per (workspace, runtime); a duplicate means
  // the deterministic-id seeding was bypassed or the schema drifted.
  const duplicates = db.listDuplicateImplicitAgents();
  checks.push({
    name: 'one implicit agent per (workspace, runtime)',
    ok: duplicates.length === 0,
    detail:
      duplicates.length === 0
        ? 'no duplicate implicit agents'
        : `duplicates: ${duplicates.map((d) => `${d.workspace_id}/${d.runtime}`).join(', ')}`,
  });

  // Every implicit agent must belong to a workspace that still exists.
  const dangling = db.listDanglingImplicitAgents();
  checks.push({
    name: 'no implicit agents for deleted workspaces',
    ok: dangling.length === 0,
    detail:
      dangling.length === 0
        ? 'all implicit agents belong to live workspaces'
        : `dangling: ${dangling.join(', ')}`,
  });

  return checks;
}

const { dbPath, json } = parseArgs(process.argv.slice(2));
if (!fs.existsSync(dbPath)) {
  const message = `database not found: ${dbPath}`;
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  else console.error(message);
  process.exit(2);
}

const db = new Db(dbPath);
try {
  const checks = runChecks(db);
  const ok = checks.every((check) => check.ok);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok, dbPath, checks }, null, 2)}\n`);
  } else {
    console.log(`shadow tables: ${dbPath}`);
    for (const check of checks) {
      console.log(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name} — ${check.detail}`);
    }
    console.log(ok ? '\nall checks passed' : '\nshadow tables are inconsistent');
  }
  process.exit(ok ? 0 : 1);
} finally {
  db.close();
}
