import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import express, { type Express } from 'express';
import type { AppContext } from './context.js';
import { requireAuth, requireRolePolicy } from '../http/auth.js';
import { corsMiddleware } from '../http/cors.js';
import { registerHealthRoutes } from '../routes/health.js';
import { registerAgentRoutes } from '../routes/agent.js';
import { registerAttachmentRoutes } from '../routes/attachments.js';
import { registerChatRoutes } from '../routes/chat.js';
import { registerChangesRoutes } from '../routes/changes.js';
import { registerConfigRoutes } from '../routes/config.js';
import { registerDeployRoutes } from '../routes/deploy.js';
import { registerFileRoutes } from '../routes/files.js';
import { registerFsRoutes } from '../routes/fs.js';
import { registerKnowledgeRoutes } from '../routes/knowledge.js';
import { registerMemoryRoutes } from '../routes/memory.js';
import { registerPermissionRoutes } from '../routes/permissions.js';
import { registerProviderRoutes } from '../routes/providers.js';
import { registerRunRoutes } from '../routes/runs.js';
import { registerSessionPermissionRoutes } from '../routes/session-permissions.js';
import { registerSessionRoutes } from '../routes/sessions.js';
import { registerScheduledTaskRoutes } from '../routes/scheduled-tasks.js';
import { registerMcpTaskRoutes } from '../routes/mcp-tasks.js';
import { registerSystemRoutes, type SystemRouteHooks } from '../routes/system.js';
import { registerWorkspaceRoutes } from '../routes/workspaces.js';

export type ServerHooks = SystemRouteHooks;

export function createApp(ctx: AppContext, hooks: ServerHooks = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware());
  app.use(express.json({ limit: '1mb' }));

  // Health is unauthenticated so probes/load-balancers can reach it.
  registerHealthRoutes(app, ctx);

  // Everything else under /api requires a bearer token.
  app.use(
    '/api',
    requireAuth(ctx.config.token, {
      maxFailures: ctx.config.authMaxFailures,
      lockoutMs: ctx.config.authLockoutMs,
      agentToken: ctx.config.agentToken,
      serverToken: ctx.config.serverToken,
    }),
  );
  app.use('/api', requireRolePolicy());
  registerAgentRoutes(app, ctx);
  registerAttachmentRoutes(app, ctx);
  registerChangesRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerProviderRoutes(app, ctx);
  registerDeployRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerFsRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerKnowledgeRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerSessionPermissionRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerScheduledTaskRoutes(app, ctx);
  registerMcpTaskRoutes(app, ctx);
  registerPermissionRoutes(app, ctx);
  registerSystemRoutes(app, hooks);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found', code: 'not_found' });
  });

  return app;
}

export function startServer(ctx: AppContext, hooks: ServerHooks = {}): http.Server | https.Server {
  const app = createApp(ctx, hooks);

  if (ctx.config.tls) {
    const server = https.createServer(
      {
        key: fs.readFileSync(ctx.config.tls.key),
        cert: fs.readFileSync(ctx.config.tls.cert),
      },
      app,
    );
    server.listen(ctx.config.port, ctx.config.host);
    return server;
  }

  const server = app.listen(ctx.config.port, ctx.config.host);
  return server;
}
