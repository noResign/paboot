import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import { CAPABILITIES } from '../capabilities/registry.js';
import type { CapabilitiesResponse } from '../types/api.js';

/** Global capability catalog. Ends select from it; settings lists it. */
export function registerCapabilityRoutes(app: Express, _ctx: AppContext): void {
  app.get('/api/capabilities', (_req, res) => {
    const dto: CapabilitiesResponse = {
      capabilities: CAPABILITIES.map((capability) => ({
        id: capability.id,
        name: capability.name,
        families: [...capability.families],
        scope: capability.scope,
        domains: [...(capability.domains ?? [])],
        tools: [...capability.tools],
        approval: capability.approval,
        surfaces: [...capability.surfaces],
      })),
    };
    res.json(dto);
  });
}
