import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import express, { type Express } from 'express';
import type { AppContext } from './context.js';
import { requireAuth } from './auth.js';
import { corsMiddleware } from './cors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerChangesRoutes } from './routes/changes.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerDeployRoutes } from './routes/deploy.js';
import { registerFileRoutes } from './routes/files.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerPermissionRoutes } from './routes/permissions.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSessionPermissionRoutes } from './routes/session-permissions.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerScheduledTaskRoutes } from './routes/scheduled-tasks.js';
import { registerMcpTaskRoutes } from './routes/mcp-tasks.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware());
  app.use(express.json({ limit: '1mb' }));

  // Health is unauthenticated so probes/load-balancers can reach it.
  registerHealthRoutes(app, ctx);

  // Everything else under /api requires a bearer token.
  app.use('/api', requireAuth(ctx.config.token));
  registerAgentRoutes(app, ctx);
  registerChangesRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerDeployRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerFsRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerSessionPermissionRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerScheduledTaskRoutes(app, ctx);
  registerMcpTaskRoutes(app, ctx);
  registerPermissionRoutes(app, ctx);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found', code: 'not_found' });
  });

  return app;
}

export function startServer(ctx: AppContext): http.Server | https.Server {
  const app = createApp(ctx);

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
