import { buddyMutations } from '@unleashd/shared';
import type { Express, Response } from 'express';
import type { Acted, ExpeditionHost } from './host';
import type { Loaded } from './record';

// Owner HTTP (docs/expeditions-lean-design.md §3.8). Registered after the auth gate and BEFORE
// the Buddy routes, whose `/api/buddies/:buddyId` would capture these paths.
const act = buddyMutations['expedition.act'];

export function registerExpeditionRoutes(app: Express, host: () => ExpeditionHost | null): void {
  const ready = (res: Response) => {
    const h = host();
    if (!h) res.status(503).json({ error: 'expeditions are starting' });
    return h;
  };
  app.get('/api/buddies/expeditions', (_req, res) => {
    const h = ready(res);
    if (h) res.json(h.rows());
  });
  // Before `/:id`, which would read `retired` as an id.
  app.get('/api/buddies/expeditions/retired', (_req, res) => {
    const h = ready(res);
    if (h) res.json(h.retired());
  });
  app.get('/api/buddies/expeditions/:id', (req, res) => {
    const h = ready(res);
    if (h) read(res, h.get(req.params.id));
  });
  app.post(act.path, async (req, res) => {
    const h = ready(res);
    if (!h) return;
    const parsed = act.body.safeParse(req.body);
    if (!parsed.success) res.status(400).json({ error: parsed.error.message });
    // Review 2026-11-03: an act that threw (a core write in launch or retire) left the request
    // unanswered and the rejection unhandled, which Express 4 does not catch.
    else
      await h.act(req.params.id, parsed.data, 'owner').then(
        (a) => reply(res, a),
        (e: Error) => res.status(500).json({ error: e.message })
      );
  });
}

function read(res: Response, l: Loaded | { t: 'missing' }): void {
  switch (l.t) {
    case 'missing':
      res.status(404).json({ error: 'no such expedition' });
      return;
    case 'unreadable':
      res.status(409).json({ error: `unreadable: ${l.reason}` });
      return;
    case 'ok':
      res.json(l.x);
  }
}

function reply(res: Response, a: Acted): void {
  switch (a.t) {
    case 'missing':
      res.status(404).json({ error: 'no such expedition' });
      return;
    case 'refused':
      res.status(409).json({ error: a.reasons.join('; ') });
      return;
    case 'ok':
      res.status(act.status).json(a.x);
  }
}
