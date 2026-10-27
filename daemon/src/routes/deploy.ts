import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import type { DeployJobRow } from '../db/db.js';
import type { DeployChannel, DeployJobDto, DeployJobStatus, DeployTarget } from '../types/api.js';

const execFileAsync = promisify(execFile);

function normalizeChannel(raw: unknown): DeployChannel | null {
  if (raw === 'test' || raw === 'alpha') return 'alpha';
  if (raw === 'prod') return 'prod';
  return null;
}

function normalizeTarget(raw: unknown): DeployTarget {
  if (raw === 'daemon' || raw === 'android' || raw === 'desktop' || raw === 'all') return raw;
  return 'auto';
}

function toDto(row: DeployJobRow): DeployJobDto {
  return {
    id: row.id,
    channel: row.channel as DeployChannel,
    target: row.target as DeployTarget,
    status: row.status as DeployJobStatus,
    unit: row.unit,
    logPath: row.log_path,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    error: row.error,
  };
}

/** 非 auto 的每个目标都要显式排除其余目标——变更检测是独立的，不排除就会搭车发布。 */
function targetFlags(target: DeployTarget): string[] {
  if (target === 'daemon') return ['--daemon', '--no-android', '--no-desktop'];
  if (target === 'android') return ['--android', '--no-daemon', '--no-desktop'];
  if (target === 'desktop') return ['--desktop', '--no-daemon', '--no-android'];
  if (target === 'all') return ['--daemon', '--android', '--desktop'];
  return [];
}

async function systemdUnitProperties(ctx: AppContext, unit: string): Promise<Record<string, string> | null> {
  try {
    const { stdout } = await execFileAsync(
      'systemctl',
      [
        '--user',
        'show',
        unit,
        '-p',
        'ActiveState',
        '-p',
        'SubState',
        '-p',
        'Result',
        '-p',
        'ExecMainStatus',
      ],
      { timeout: 5000 },
    );
    const props: Record<string, string> = {};
    for (const line of stdout.split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx > 0) props[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return Object.keys(props).length > 0 ? props : null;
  } catch {
    return null;
  }
}

async function refreshDeployJob(ctx: AppContext, row: DeployJobRow): Promise<DeployJobRow> {
  if (row.status === 'succeeded' || row.status === 'failed') return row;

  const props = await systemdUnitProperties(ctx, row.unit);
  if (!props) return row;

  const activeState = props.ActiveState ?? '';
  const result = props.Result ?? '';
  const rawExit = Number(props.ExecMainStatus ?? '');
  const exitCode = Number.isFinite(rawExit) ? rawExit : null;

  let status = row.status as DeployJobStatus;
  let finishedAt = row.finished_at;
  let error = row.error;

  if (activeState === 'active' || activeState === 'activating' || activeState === 'reloading') {
    status = 'running';
  } else if (activeState === 'inactive' && result === 'success' && (exitCode === null || exitCode === 0)) {
    status = 'succeeded';
    finishedAt = finishedAt ?? Date.now();
  } else if (activeState === 'failed' || (activeState === 'inactive' && result !== 'success')) {
    status = 'failed';
    finishedAt = finishedAt ?? Date.now();
    error = `systemd result=${result || 'unknown'} exit=${props.ExecMainStatus ?? 'n/a'}`;
  } else {
    return row;
  }

  const startedAt =
    row.started_at ??
    (status === 'running' ? Date.now() : status === 'succeeded' || status === 'failed' ? row.created_at : null);

  if (
    status !== row.status ||
    startedAt !== row.started_at ||
    finishedAt !== row.finished_at ||
    exitCode !== row.exit_code ||
    error !== row.error
  ) {
    ctx.db.updateDeployJob(row.id, { status, startedAt, finishedAt, exitCode, error });
  }

  return ctx.db.getDeployJob(row.id) ?? row;
}

export function registerDeployRoutes(app: Express, ctx: AppContext): void {
  app.post('/api/deploy', async (req, res) => {
    if (!ctx.config.allowDeploy) {
      res.status(403).json({
        error: 'deploy is disabled; set PABOOT_ALLOW_DEPLOY=1 to enable',
        code: 'deploy_disabled',
      });
      return;
    }

    const channel = normalizeChannel(req.body?.channel);
    if (!channel) {
      res.status(400).json({ error: 'channel must be test/alpha or prod', code: 'bad_request' });
      return;
    }
    const target = normalizeTarget(req.body?.target);

    const current = ctx.db.getActiveDeployJob();
    if (current) {
      const refreshed = await refreshDeployJob(ctx, current);
      if (refreshed.status === 'queued' || refreshed.status === 'running') {
        res.status(409).json({
          error: 'a deploy job is already in progress',
          code: 'deploy_in_progress',
          job: toDto(refreshed),
        });
        return;
      }
    }

    const deployScript = ctx.config.deployScript;
    if (!fs.existsSync(deployScript)) {
      res.status(500).json({
        error: `deploy script not found: ${deployScript}`,
        code: 'deploy_script_missing',
      });
      return;
    }

    const id = `dep_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const unit = `paboot-deploy-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const logDir = path.join(ctx.config.dataDir, 'deploy');
    const logPath = path.join(logDir, `${id}.log`);
    fs.mkdirSync(logDir, { recursive: true });

    ctx.db.createDeployJob({ id, channel, target, unit, logPath });

    const uid = process.getuid?.();
    const repoRoot = path.resolve(path.dirname(deployScript), '..', '..', '..', '..');
    const args = [
      '--no-block',
      '--user',
      `--unit=${unit}`,
      '--property=Type=oneshot',
      '--property=TimeoutStartSec=infinity',
      `--property=WorkingDirectory=${repoRoot}`,
      `--property=StandardOutput=append:${logPath}`,
      `--property=StandardError=append:${logPath}`,
      `--setenv=HOME=${process.env.HOME ?? ''}`,
      `--setenv=PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      `--setenv=DEPLOY_JOB_ID=${id}`,
      ...(uid !== undefined
        ? [
            `--setenv=XDG_RUNTIME_DIR=/run/user/${uid}`,
            `--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
          ]
        : []),
      deployScript,
      channel,
      ...targetFlags(target),
    ];

    try {
      // --no-block 让 systemd-run 入队后立即返回；任务是否完成由
      // refreshDeployJob() 轮询 systemctl show 判断，绝不能被构建耗时误判成启动失败。
      await execFileAsync('systemd-run', args, { timeout: 5000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.db.updateDeployJob(id, { status: 'failed', finishedAt: Date.now(), error: message });
      res.status(500).json({
        error: `failed to start deploy: ${message}`,
        code: 'deploy_start_failed',
        job: toDto(ctx.db.getDeployJob(id) as DeployJobRow),
      });
      return;
    }

    ctx.db.updateDeployJob(id, { status: 'running', startedAt: Date.now() });
    res.status(202).json({ job: toDto(ctx.db.getDeployJob(id) as DeployJobRow) });
  });

  app.get('/api/deploy', async (_req, res) => {
    const rows = ctx.db.listDeployJobs(20);
    const jobs = await Promise.all(rows.map((row) => refreshDeployJob(ctx, row)));
    res.json({ jobs: jobs.map(toDto) });
  });

  app.get('/api/deploy/:id', async (req, res) => {
    const row = ctx.db.getDeployJob(req.params.id);
    if (!row) {
      res.status(404).json({ error: 'deploy job not found', code: 'deploy_job_not_found' });
      return;
    }
    const refreshed = await refreshDeployJob(ctx, row);
    res.json({ job: toDto(refreshed) });
  });
}
