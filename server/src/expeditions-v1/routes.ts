import { buddyMutations } from '@unleashd/shared';
import type { Express, Request, Response } from 'express';
import type { z } from 'zod';
import type { AskAnswer } from './executor/asks';
import type { Expect, KeyedExpeditions, Mutated, Previewing, Viewed } from './service';

// Owner HTTP for keyed expeditions (CONNECT_PLAN §4, step 6), under /api/buddies/keyed-expeditions.
// Registered after the auth gate and BEFORE the Buddy routes, whose `/api/buddies/:buddyId` would
// capture these paths. Paths, methods, bodies and success statuses are the shared table
// (`buddyMutations['keyed.*']`); every body is checked with its zod schema (400 naming the field).
//
//   GET  /                    KeyedRow[]               (both modes; read-only folds the logs on disk)
//   GET  /:id                 KeyedView | 404
//   POST /:id/act             KeyedView | 409 refused  (pause, resume, stop, extend, retry)
//   POST /:id/asks/:ref       KeyedView | 409          (the view as of the answer: the ask leaves
//                                                       it when the executor observes the reply)
//   POST /:id/approval        KeyedView | 409          (nothing waiting)
//   POST /preview             KeyedPreview (200, a rejected plan included) — writes nothing
//   POST /launch         201  KeyedView | 422 {gate, issues} | 404 workspace | 409 the file no
//                             longer matches the card's `digest` (or it was launched already)
//   GET  /proposals/:digest?file=   KeyedProposalStatus   (a proposal card's facts; both modes)
//
// In read-only mode every POST is 503 with the reason (flag off, or execution disabled).
// Pattern: table-driven (docs/patterns.md#table-driven)

const M = buddyMutations;
const ROOT = '/api/buddies/keyed-expeditions';

/** One status per result: the mutation's own success status for `ok`. */
const MUTATED: {
  readonly [K in Mutated['t']]: (
    res: Response,
    ok: number,
    m: Extract<Mutated, { t: K }>
  ) => unknown;
} = {
  ok: (res, ok, m) => res.status(ok).json(m.view),
  unavailable: (res, _ok, m) => res.status(503).json({ error: m.why }),
  missing: (res, _ok, m) => res.status(404).json({ error: m.why }),
  refused: (res, _ok, m) => res.status(409).json({ error: m.why }),
  rejected: (res, _ok, m) =>
    res
      .status(422)
      .json({ error: `${m.gate}: ${m.issues.join('; ')}`, gate: m.gate, issues: m.issues }),
};
const replyMutated = (res: Response, ok: number, m: Mutated) =>
  (MUTATED[m.t] as (r: Response, ok: number, m: Mutated) => unknown)(res, ok, m);

const VIEWED: {
  readonly [K in Viewed['t']]: (res: Response, v: Extract<Viewed, { t: K }>) => unknown;
} = {
  ok: (res, v) => res.json(v.view),
  missing: (res, v) => res.status(404).json({ error: v.why }),
};
const PREVIEWING: {
  readonly [K in Previewing['t']]: (res: Response, p: Extract<Previewing, { t: K }>) => unknown;
} = {
  previewed: (res, p) => res.status(M['keyed.preview'].status).json(p.preview),
  unavailable: (res, p) => res.status(503).json({ error: p.why }),
};

/** A text ask takes `answer`, a confirm ask takes `confirm` (the shared body schema). */
const askAnswerOf = (body: { answer: string } | { confirm: boolean }): AskAnswer =>
  'answer' in body ? { t: 'text', text: body.answer } : { t: 'confirm', yes: body.confirm };

/** κ: a launch body naming a digest demands it of the file; one without is direct HTTP. */
const expectOf = (digest: string | undefined): Expect =>
  digest === undefined ? { t: 'any' } : { t: 'digest', digest };

/** The body, checked: a bad one is answered 400 naming each field and `undefined` returned. */
function parsed<S extends z.ZodTypeAny>(
  schema: S,
  req: Request,
  res: Response
): z.infer<S> | undefined {
  const r = schema.safeParse(req.body);
  if (r.success) return r.data;
  const fields = r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`);
  res.status(400).json({ error: `invalid body: ${fields.join('; ')}`, fields });
  return undefined;
}

/** Express 4 does not catch a rejected handler: answer 500 rather than hang the request. */
const handled =
  (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
    handler(req, res).catch((e: unknown) => {
      console.error(`[expeditions-v1] ${req.method} ${req.path}:`, e);
      if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
    });
  };

export function registerKeyedExpeditionRoutes(app: Express, x: KeyedExpeditions): void {
  app.get(
    ROOT,
    handled(async (_req, res) => res.json(await x.rows()))
  );
  // The two file routes before `/:id/...`; they are POSTs, so `GET /:id` never reads them.
  app.post(
    M['keyed.preview'].path,
    handled(async (req, res) => {
      const body = parsed(M['keyed.preview'].body, req, res);
      if (!body) return;
      const p = await x.preview(body.file);
      (PREVIEWING[p.t] as (r: Response, p: Previewing) => unknown)(res, p);
    })
  );
  app.post(
    M['keyed.launch'].path,
    handled(async (req, res) => {
      const body = parsed(M['keyed.launch'].body, req, res);
      if (body)
        replyMutated(
          res,
          M['keyed.launch'].status,
          await x.launch(body.workspaceId, body.file, expectOf(body.digest))
        );
    })
  );
  // A proposal card's facts (mode, launched, file unchanged): a read, in both modes.
  app.get(
    `${ROOT}/proposals/:digest`,
    handled(async (req, res) => {
      const file = typeof req.query.file === 'string' ? req.query.file : '';
      if (!file.startsWith('/'))
        return res.status(400).json({ error: 'file: must be an absolute path' });
      return res.json(await x.proposal(req.params.digest, file));
    })
  );
  app.get(
    `${ROOT}/:id`,
    handled(async (req, res) => {
      const v = await x.view(req.params.id);
      (VIEWED[v.t] as (r: Response, v: Viewed) => unknown)(res, v);
    })
  );
  app.post(
    M['keyed.act'].path,
    handled(async (req, res) => {
      const body = parsed(M['keyed.act'].body, req, res);
      if (body) replyMutated(res, M['keyed.act'].status, await x.act(req.params.id, body));
    })
  );
  app.post(
    M['keyed.answer'].path,
    handled(async (req, res) => {
      const body = parsed(M['keyed.answer'].body, req, res);
      if (body)
        replyMutated(
          res,
          M['keyed.answer'].status,
          await x.answer(req.params.id, req.params.ref, askAnswerOf(body))
        );
    })
  );
  app.post(
    M['keyed.approval'].path,
    handled(async (req, res) => {
      const body = parsed(M['keyed.approval'].body, req, res);
      if (body)
        replyMutated(
          res,
          M['keyed.approval'].status,
          await x.approval(req.params.id, body.approve)
        );
    })
  );
}
