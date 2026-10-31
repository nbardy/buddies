import { z } from 'zod';

// The owner's WHAT (reflection never edits it) and the attempt answer shapes, parsed once at the
// boundary: the charter by the `expedition` tool, results by briefs.ts `parseOutcome` (κ).

export const WorkerConfig = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional(),
  })
  .strict();

export type WorkerConfig = z.infer<typeof WorkerConfig>;

/** A seat's display name, e.g. `codex/gpt-5/high`. */
export const seatLabel = (w: WorkerConfig) =>
  [w.provider, w.model, w.reasoningEffort].filter(Boolean).join('/');
/** Same provider and model (effort aside): the independence rule for checks. */
export const sameModel = (a: WorkerConfig, b: WorkerConfig) =>
  a.provider === b.provider && (a.model ?? '') === (b.model ?? '');

/** Who runs each attempt kind. Work and check seats are rosters: the manager picks a work seat;
 * the engine seats every check on a model other than the claim's author (blind and independent). */
export const Crew = z
  .object({
    manager: WorkerConfig,
    work: z.array(WorkerConfig).min(1).max(4),
    check: z.array(WorkerConfig).min(1).max(4),
  })
  .strict();

export const Done = z.union([
  z.object({ checks: z.array(z.string().trim().min(1)).min(1).max(10) }).strict(),
  z.object({ ownerJudgment: z.literal(true) }).strict(),
]);

export const Charter = z
  .object({
    name: z.string().trim().min(1).max(60),
    goal: z.string().trim().min(1).max(4000),
    done: Done,
    inScope: z.array(z.string().trim().min(1)).max(20),
    outOfScope: z.array(z.string().trim().min(1)).max(20),
    maxAttempts: z.number().int().min(2).max(60),
    maxLive: z.number().int().min(1).max(8),
    hours: z.number().min(0.25).max(72),
    exploreShare: z.number().min(0).max(0.5),
    crew: Crew,
  })
  .strict();
export type Charter = z.infer<typeof Charter>;

/** Where status posts go: the thread the launch came from, or the owner↔launcher DM. */
export type Origin = { t: 'thread'; channelId: string; rootId: string } | { t: 'direct' };

// ---------- Attempt results ----------

export const WorkResult = z.union([
  z
    .object({
      result: z.literal('claim'),
      statement: z.string().min(1),
      /** The candidate commit on the attempt's own branch (design.md R1/R2). */
      commit: z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character commit sha'),
      evidence: z.array(z.string()),
      howToCheck: z.string().min(1),
    })
    .strict(),
  z
    .object({
      result: z.literal('finding'),
      statement: z.string().min(1),
      evidence: z.array(z.string()),
    })
    .strict(),
  z.object({ result: z.literal('blocked'), need: z.string().min(1) }).strict(),
]);
export type WorkResult = z.infer<typeof WorkResult>;
export type Claim = Extract<WorkResult, { result: 'claim' }>;

export const CheckResult = z
  .object({ verdict: z.enum(['verified', 'refuted', 'unclear']), why: z.string().min(1) })
  .strict();
export type CheckResult = z.infer<typeof CheckResult>;

/** In the charter's scope, budgeted exploration, or parked until the owner funds it. */
export const QuestionScope = z.enum(['in', 'explore', 'parked']);
export type QuestionScope = z.infer<typeof QuestionScope>;

/**
 * A file-custody prefix, repo-relative, normalized once here: `./a/b/` → `a/b`, the whole
 * repository → `.`. Absolute paths and `..` are refused (custody never leaves the repository).
 */
export const CustodyPath = z
  .string()
  .trim()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
    message: 'a repo-relative path inside the repository',
  })
  .transform((p) => p.replace(/^(\.\/)+/, '').replace(/\/+$/, '') || '.');

const ref = z.string().min(1);
export const ManagerAction = z.discriminatedUnion('do', [
  z
    .object({
      do: z.literal('add_question'),
      title: z.string().min(1).max(200),
      detail: z.string().min(1).max(2000),
      scope: QuestionScope,
      /** File custody: work attempts on overlapping paths never run at once. */
      paths: z.array(CustodyPath).min(1).max(20),
    })
    .strict(),
  z
    .object({
      do: z.literal('work'),
      question: ref,
      seat: z.number().int().min(0),
      brief: z.string().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      do: z.literal('check'),
      claimAttempt: ref,
      goal: z.boolean(),
      panel: z.number().int().min(1).max(3),
    })
    .strict(),
  z
    .object({
      do: z.literal('close_question'),
      question: ref,
      status: z.enum(['verified', 'dead']),
      why: z.string().min(1),
    })
    .strict(),
  z.object({ do: z.literal('ask_owner'), question: z.string().min(1) }).strict(),
  z.object({ do: z.literal('done'), summary: z.string().min(1) }).strict(),
  z.object({ do: z.literal('note'), text: z.string().min(1).max(2000) }).strict(),
]);
export type ManagerAction = z.infer<typeof ManagerAction>;
export const ManagerResult = z.object({ actions: z.array(ManagerAction).max(30) }).strict();
