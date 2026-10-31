import type { Express } from 'express';
import type { ExpeditionHost } from './host';

// Owner HTTP read for the expedition page and badge. Registered after the auth gate and BEFORE
// the Buddy routes (whose `/api/buddies/:buddyId` would capture this path). The key lives under
// `/api/buddies` so `buddies_changed` pushes refresh mounted pages (client atoms/resources.ts).
export function registerExpeditionRoutes(app: Express, host: () => ExpeditionHost | null): void {
  app.get('/api/buddies/expeditions/:id', (req, res) => {
    const expeditions = host();
    if (!expeditions) {
      res.status(503).json({ error: 'expeditions are starting' });
      return;
    }
    const id = String(req.params.id);
    if (!expeditions.has(id)) {
      res.status(404).json({ error: `no expedition ${id}` });
      return;
    }
    res.json(expeditions.view(id));
  });
}
