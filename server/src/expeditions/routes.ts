import { type ExpeditionCrews, buddyMutations } from '@unleashd/shared';
import type { Express, Request, Response } from 'express';
import type { DraftLaunch } from './drafts';
import type { ExpeditionHost, Retire } from './host';

// Owner HTTP for the expedition modal, badge and draft card. Registered after the auth gate (every
// /api route acts as the owner, like server/src/buddies/routes.ts) and BEFORE the Buddy routes
// (whose `/api/buddies/:buddyId` would capture these paths). The keys live under `/api/buddies` so
// `buddies_changed` pushes refresh mounted views (client atoms/resources.ts). A draft is read and
// launched only under the workspace it was drafted in. That is a consistency check, NOT an access
// boundary: the client names the workspace (the card's own view), and every /api caller is the
// owner. A forged `expedition_draft` card (any Buddy can post a free-text purpose) can only point
// at a real draft, whose launch still runs the tool's preflight.
export function registerExpeditionRoutes(app: Express, host: () => ExpeditionHost | null): void {
  /** The host once booted; a request before that is a 503 (it is starting). */
  const ready = (res: Response): ExpeditionHost | null => {
    const expeditions = host();
    if (!expeditions) res.status(503).json({ error: 'expeditions are starting' });
    return expeditions;
  };

  // Every expedition, newest launch first: the channel rail's section and the index pane.
  app.get('/api/buddies/expeditions', (_req, res) => {
    const expeditions = ready(res);
    if (!expeditions) return;
    res.json(expeditions.summaries());
  });

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
      case 'retired':
        // Frozen (retired.ts): its summary and last report, read-only.
        res.json(expeditions.retiredView(id));
        return;
      case 'present':
        res.json(expeditions.view(id));
    }
  });

  const retire = buddyMutations['expedition.retire'];
  app.post(retire.path, async (req: Request, res: Response) => {
    const expeditions = ready(res);
    if (!expeditions) return;
    const parsed = retire.body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const id = String(req.params.id);
    retireReply(res, id, await expeditions.retire(id, 'owner', parsed.data.mode));
  });
}

/** δ: one HTTP answer per retire outcome. A retired expedition answers as a fresh request does:
 * retire is idempotent (the runbook re-POSTs after fixing a refusal). */
function retireReply(res: Response, id: string, retired: Retire): void {
  switch (retired.t) {
    case 'retiring':
    case 'already_retired':
      res.status(retire202).json({ expeditionId: id });
      return;
    case 'not_finished':
      res.status(409).json({ error: `expedition ${id} is still open: stop it and retire` });
      return;
    case 'missing':
      res.status(404).json({ error: `no expedition ${id}` });
      return;
    case 'quarantined':
      res.status(409).json({ error: `expedition ${id} is quarantined: ${retired.reason}` });
      return;
    case 'disabled':
      res.status(409).json({ error: retired.reason });
  }
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
const retire202 = buddyMutations['expedition.retire'].status;
