import { type ExpeditionCrews, buddyMutations } from '@unleashd/shared';
import type { Express, Request, Response } from 'express';
import type { DraftLaunch } from './drafts';
import type { ExpeditionHost } from './host';

// Owner HTTP for the expedition modal, badge and draft card. Registered after the auth gate (every
// /api route acts as the owner, like server/src/buddies/routes.ts) and BEFORE the Buddy routes
// (whose `/api/buddies/:buddyId` would capture these paths). The keys live under `/api/buddies` so
// `buddies_changed` pushes refresh mounted views (client atoms/resources.ts). A draft is read and
// launched only from the workspace it was drafted in: the card names the workspace it is shown in.
export function registerExpeditionRoutes(app: Express, host: () => ExpeditionHost | null): void {
  /** The host once booted; a request before that is a 503 (it is starting). */
  const ready = (res: Response): ExpeditionHost | null => {
    const expeditions = host();
    if (!expeditions) res.status(503).json({ error: 'expeditions are starting' });
    return expeditions;
  };

  app.get('/api/buddies/expeditions/crews', (_req, res) => {
    const expeditions = ready(res);
    if (!expeditions) return;
    res.json({ buddyIds: expeditions.crews() } satisfies ExpeditionCrews);
  });

  app.get('/api/buddies/expeditions/drafts/:draftId', async (req, res) => {
    const expeditions = ready(res);
    if (!expeditions) return;
    const id = String(req.params.draftId);
    const found = await expeditions.drafts.view(id, String(req.query.workspaceId ?? ''));
    switch (found.t) {
      case 'missing':
        res.status(404).json({ error: `no draft ${id} in this workspace` });
        return;
      case 'present':
        res.json(found.view);
    }
  });

  const launch = buddyMutations['expedition.launch'];
  app.post(launch.path, async (req: Request, res: Response) => {
    const expeditions = ready(res);
    if (!expeditions) return;
    const parsed = launch.body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const id = String(req.params.draftId);
    launchReply(res, id, await expeditions.drafts.launch(id, parsed.data.workspaceId));
  });

  app.get('/api/buddies/expeditions/:id', (req, res) => {
    const expeditions = ready(res);
    if (!expeditions) return;
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

/** δ: one HTTP answer per launch outcome; every refusal is the card's inline error text. */
function launchReply(res: Response, id: string, launched: DraftLaunch): void {
  switch (launched.t) {
    case 'launched':
      res.status(launch200).json({ expeditionId: launched.expeditionId });
      return;
    case 'missing':
      res.status(404).json({ error: `no draft ${id} in this workspace` });
      return;
    case 'superseded':
      res.status(409).json({ error: `replaced by a newer draft, ${launched.by}: launch that one` });
      return;
    case 'already_running':
      res.status(409).json({
        error: `an expedition named "${launched.name}" from this conversation is still open (${launched.expeditionId}); stop it first, or draft another name`,
      });
      return;
    case 'refused':
      res.status(422).json({ error: `Launch refused: ${launched.reasons.join('; ')}.` });
  }
}

const launch200 = buddyMutations['expedition.launch'].status;
