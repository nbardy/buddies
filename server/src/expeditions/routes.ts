import type { Express } from 'express';
import type { ExpeditionHost } from './host';

// Owner HTTP read for the expedition page and badge. Registered after the auth gate and BEFORE
// the Buddy routes (whose `/api/buddies/:buddyId` would capture this path). The key lives under
// `/api/buddies` so `buddies_changed` pushes refresh mounted pages (client atoms/resources.ts).
export function registerExpeditionRoutes(app: Express, host: () => ExpeditionHost | null): void {
  // The list for the sidebar section and the index page (client SidebarExpeditions).
  app.get('/api/buddies/expeditions', (_req, res) => {
    const expeditions = host();
    if (!expeditions) {
      res.status(503).json({ error: 'expeditions are starting' });
      return;
    }
    res.json(expeditions.summaries());
  });
  app.get('/api/buddies/expeditions/:id', (req, res) => {
    const expeditions = host();
    if (!expeditions) {
      res.status(503).json({ error: 'expeditions are starting' });
      return;
    }
    const id = String(req.params.id);
    const found = expeditions.lookup(id);
    switch (found.t) {
      case 'missing':
        res.status(404).json({ error: `no expedition ${id}` });
        return;
      case 'quarantined':
        // Its ledger does not fold (host.ts quarantine); the reason is the owner's to read.
        res.status(409).json({ error: `expedition ${id} is quarantined: ${found.reason}` });
        return;
      case 'present':
        res.json(expeditions.view(id));
    }
  });
}
