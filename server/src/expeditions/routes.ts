import { type ExpeditionCrews, buddyMutations } from '@unleashd/shared';
import type { Express, NextFunction, Request, Response } from 'express';
import type { DraftLaunch } from './drafts';
import type { ExpeditionHost } from './host';
import type { Retire } from './launch';

// Owner HTTP for the expedition modal, badge and draft card. Registered after the auth gate (every
// /api caller is the owner) and BEFORE the Buddy routes (`/api/buddies/:buddyId` would capture
// these); under `/api/buddies` so `buddies_changed` refreshes mounted views. A draft's workspace
// check is consistency, NOT an access boundary: a forged card can only point at a real draft,
// whose launch still runs the tool's preflight.

type Reply = { status: number; body: unknown };
const error = (status: number, message: string): Reply => ({ status, body: { error: message } });
const LAUNCH = buddyMutations['expedition.launch'];
const RETIRE = buddyMutations['expedition.retire'];

export function registerExpeditionRoutes(app: Express, host: () => ExpeditionHost | null): void {
  /** Runs `handle` once the host has booted (503 before); a throw goes to express as a sync one. */
  const route =
    (handle: (h: ExpeditionHost, req: Request) => Reply | Promise<Reply>) =>
    (req: Request, res: Response, next: NextFunction) => {
      const expeditions = host();
      Promise.resolve(expeditions ? handle(expeditions, req) : error(503, 'expeditions are starting'))
        .then((reply) => res.status(reply.status).json(reply.body))
        .catch(next);
    };
  const ok = (body: unknown): Reply => ({ status: 200, body });

  // Every expedition, newest launch first: the channel rail's section and the index pane.
  app.get('/api/buddies/expeditions', route((h) => ok(h.summaries())));
  app.get(
    '/api/buddies/expeditions/crews',
    route((h) => ok({ buddyIds: h.crews() } satisfies ExpeditionCrews))
  );
  app.get(
    '/api/buddies/expeditions/drafts/:draftId',
    route(async (h, req) => {
      const id = String(req.params.draftId);
      const found = await h.drafts.view(id, String(req.query.workspaceId ?? ''));
      return found.t === 'present' ? ok(found.view) : error(404, `no draft ${id} in this workspace`);
    })
  );
  app.post(
    LAUNCH.path,
    route(async (h, req) => {
      const parsed = LAUNCH.body.safeParse(req.body);
      if (!parsed.success) return error(400, parsed.error.message);
      const id = String(req.params.draftId);
      return launchReply(id, await h.drafts.launch(id, parsed.data.workspaceId));
    })
  );
  app.get(
    '/api/buddies/expeditions/:id',
    route((h, req) => {
      const id = String(req.params.id);
      const found = h.lookup(id);
      switch (found.t) {
        case 'missing':
          return error(404, `no expedition ${id}`);
        case 'quarantined':
          // Its ledger does not fold (store.ts quarantine); the reason is the owner's to read.
          return error(409, `expedition ${id} is quarantined: ${found.reason}`);
        case 'retired':
          // Frozen (retired.ts): its summary and last report, read-only.
          return ok(h.retiredView(id));
        case 'present':
          return ok(h.view(id));
      }
    })
  );
  app.post(
    RETIRE.path,
    route(async (h, req) => {
      const parsed = RETIRE.body.safeParse(req.body);
      if (!parsed.success) return error(400, parsed.error.message);
      const id = String(req.params.id);
      return retireReply(id, await h.retire(id, 'owner', parsed.data.mode));
    })
  );
}

/** δ per retire outcome. Retire is idempotent: a retired expedition answers as a fresh request
 * (the runbook re-POSTs after fixing a refusal). */
function retireReply(id: string, retired: Retire): Reply {
  switch (retired.t) {
    case 'retiring':
    case 'already_retired':
      return { status: RETIRE.status, body: { expeditionId: id } };
    case 'not_finished':
      return error(409, `expedition ${id} is still open: stop it and retire`);
    case 'missing':
      return error(404, `no expedition ${id}`);
    case 'quarantined':
      return error(409, `expedition ${id} is quarantined: ${retired.reason}`);
    case 'disabled':
      return error(409, retired.reason);
  }
}

/** δ per launch outcome; every refusal is the card's inline error text. */
function launchReply(id: string, launched: DraftLaunch): Reply {
  switch (launched.t) {
    case 'launched':
      return { status: LAUNCH.status, body: { expeditionId: launched.expeditionId } };
    case 'missing':
      return error(404, `no draft ${id} in this workspace`);
    case 'superseded':
      return error(409, `replaced by a newer draft, ${launched.by}: launch that one`);
    case 'already_running':
      return error(
        409,
        `an expedition named "${launched.name}" from this conversation is still open (${launched.expeditionId}); stop it first, or draft another name`
      );
    case 'refused':
      return error(422, `Launch refused: ${launched.reasons.join('; ')}.`);
  }
}
