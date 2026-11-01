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

/**
 * One done check (design.md R2). `command`: an argv the HOST runs (never an agent, never edited by
 * reflection) in a fresh clean worktree at the commit under validation; exit 0 passes. `judged`:
 * a statement a blind goal-check panel verifies by strict majority.
 */
/**
 * One argv element a host-run check may carry, checked once here (audit 2026-11-01 #5): a NUL byte
 * makes `spawn` throw before the check starts, and a thrown check job was re-run on every tick (a
 * hot loop). The executable must not carry stray whitespace either: it is never a shell word.
 */
const ArgvWord = z
  .string()
  .min(1)
  .refine((w) => !w.includes('\0'), { message: 'an argv element may not contain a NUL byte' });
export const Argv = z
  .array(ArgvWord)
  .min(1)
  .max(64)
  .refine((argv) => argv[0] === argv[0].trim(), {
    message: 'argv[0] (the executable) may not start or end with whitespace',
  });
const TimeoutSeconds = z
  .number()
  .int()
  .min(1)
  .max(6 * 3600);

export const DoneCheck = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('command'),
      argv: Argv,
      timeoutSeconds: TimeoutSeconds,
    })
    .strict(),
  z.object({ kind: z.literal('judged'), text: z.string().trim().min(1).max(1000) }).strict(),
]);
export type DoneCheck = z.infer<typeof DoneCheck>;
export type CommandCheck = Extract<DoneCheck, { kind: 'command' }>;

export const Done = z.union([
  z.object({ checks: z.array(DoneCheck).min(1).max(10) }).strict(),
  z.object({ ownerJudgment: z.literal(true) }).strict(),
]);
export type Done = z.infer<typeof Done>;

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

// ---------- Kickoff (design.md R7) ----------

/**
 * What a launch or draft names. Only the WHAT is required: name, goal, done checks and the attempt
 * budget. The rest may be left out and take the NAMED defaults below; the tool result lists every
 * default applied (provenance as data, never a silent fill). The ledger always holds the full
 * `Charter`.
 */
export const CharterRequest = Charter.partial({
  inScope: true,
  outOfScope: true,
  maxLive: true,
  hours: true,
  exploreShare: true,
  crew: true,
});
export type CharterRequest = z.infer<typeof CharterRequest>;

/** The default crew: a Claude manager, work and checks on Claude and Codex (so every claim has a
 * check seat on the other model), each on its provider's default model. */
export const DEFAULT_CREW: z.infer<typeof Crew> = {
  manager: { provider: 'claude' },
  work: [{ provider: 'claude' }, { provider: 'codex' }],
  check: [{ provider: 'codex' }, { provider: 'claude' }],
};
export const CHARTER_DEFAULTS = {
  inScope: [] as string[],
  outOfScope: [] as string[],
  maxLive: 2,
  hours: 8,
  exploreShare: 0.2,
  crew: DEFAULT_CREW,
};

export const crewLine = (crew: z.infer<typeof Crew>) =>
  `manager ${seatLabel(crew.manager)}; work ${crew.work.map(seatLabel).join(', ')}; check ${crew.check.map(seatLabel).join(', ')}`;

/** A provider's models (host: the installed provider catalog the seat check reads): a closed
 * list, or open for a provider that accepts ad-hoc ids (supportsDynamicModels: pi, opencode). */
export type ProviderModels =
  | { t: 'closed'; models: readonly { id: string; displayName: string }[] }
  | { t: 'open' };
export type ModelsOf = (provider: string) => ProviderModels;

const nameTokens = (name: string) =>
  name
    .toLowerCase()
    .split(/[\s\-_/.]+/)
    .filter(Boolean);

/**
 * A seat's model as the catalog names it (design.md R9). Owners say "claude haiku" or "sonnet";
 * the catalog takes `claude-haiku-5-5`. A name that is not a catalog id resolves when its words
 * pick exactly one of the provider's models (by id or display name); anything else is left as
 * written, and the seat check refuses it listing the valid ids (host.ts seatIssues). Never an
 * invented id. 2026-11-01 smoke incident: "claude haiku" failed the launch; an alias kept as
 * written would also defeat the check-independence rule, which compares model strings.
 */
function seatOf(
  seat: WorkerConfig,
  where: string,
  models: ModelsOf
): { seat: WorkerConfig; resolved: string[] } {
  const catalog = models(seat.provider);
  switch (catalog.t) {
    // An open provider's id outside its list may be valid as written: matching words would
    // rewrite `opencode/gpt-5` to `opencode/gpt-5-nano`, another model (2026-11-01 review).
    case 'open':
      return { seat, resolved: [] };
    case 'closed':
      return closedSeatOf(seat, where, catalog.models);
  }
}

function closedSeatOf(
  seat: WorkerConfig,
  where: string,
  catalog: readonly { id: string; displayName: string }[]
): { seat: WorkerConfig; resolved: string[] } {
  const model = seat.model;
  if (model === undefined || catalog.some((m) => m.id === model)) return { seat, resolved: [] };
  const want = nameTokens(model);
  const matches = catalog.filter((m) => {
    const have = new Set([...nameTokens(m.id), ...nameTokens(m.displayName)]);
    return want.every((t) => have.has(t));
  });
  if (matches.length !== 1) return { seat, resolved: [] };
  const id = matches[0].id;
  return { seat: { ...seat, model: id }, resolved: [`${where}: "${model}" → ${id}`] };
}

function crewOf(crew: z.infer<typeof Crew>, models: ModelsOf) {
  const manager = seatOf(crew.manager, 'manager', models);
  const work = crew.work.map((w, i) => seatOf(w, `work seat ${i}`, models));
  const check = crew.check.map((w, i) => seatOf(w, `check seat ${i}`, models));
  return {
    crew: { manager: manager.seat, work: work.map((x) => x.seat), check: check.map((x) => x.seat) },
    resolved: [manager, ...work, ...check].flatMap((x) => x.resolved),
  };
}

/** The charter fields a request may leave out; the draft view marks each one it defaulted. */
export type CharterDefault = keyof typeof CHARTER_DEFAULTS;
export const CHARTER_DEFAULT_KEYS = Object.keys(CHARTER_DEFAULTS) as CharterDefault[];

/** κ for a launch: the full charter, the fields it defaulted, and one line per seat model name it
 * resolved to a catalog id. */
export function charterOf(
  request: CharterRequest,
  models: ModelsOf
): { charter: Charter; defaulted: CharterDefault[]; resolved: string[] } {
  const seats = crewOf(request.crew ?? CHARTER_DEFAULTS.crew, models);
  const charter: Charter = {
    ...request,
    inScope: request.inScope ?? CHARTER_DEFAULTS.inScope,
    outOfScope: request.outOfScope ?? CHARTER_DEFAULTS.outOfScope,
    maxLive: request.maxLive ?? CHARTER_DEFAULTS.maxLive,
    hours: request.hours ?? CHARTER_DEFAULTS.hours,
    exploreShare: request.exploreShare ?? CHARTER_DEFAULTS.exploreShare,
    crew: seats.crew,
  };
  return {
    charter,
    defaulted: CHARTER_DEFAULT_KEYS.filter((k) => request[k] === undefined),
    resolved: seats.resolved,
  };
}

/** The tool result's line per defaulted field (the Buddy reads field names; the card shows a
 * "default" marker on the value instead, client ExpeditionModal). */
export function defaultedLines(keys: CharterDefault[]): string[] {
  const shown: Record<CharterDefault, string> = {
    inScope: 'inScope: none stated (the goal is the scope)',
    outOfScope: 'outOfScope: none stated (no fence)',
    maxLive: `maxLive: ${CHARTER_DEFAULTS.maxLive}`,
    hours: `hours: ${CHARTER_DEFAULTS.hours}`,
    exploreShare: `exploreShare: ${CHARTER_DEFAULTS.exploreShare}`,
    crew: `crew: the default crew (${crewLine(DEFAULT_CREW)})`,
  };
  return keys.map((k) => shown[k]);
}

/**
 * What refuses a launch before any I/O: a work seat no check seat can verify (checks never run on
 * the claim author's model, so its claims could never be checked).
 */
export function charterIssues(c: Charter): string[] {
  return c.crew.work.flatMap((w, seat) =>
    c.crew.check.some((x) => !sameModel(x, w))
      ? []
      : [`work seat ${seat} (${seatLabel(w)}) has no check seat on another model`]
  );
}

/** Non-blocking: what would make the charter checkable by the host rather than by judgment. */
export function charterAdvice(c: Charter): string[] {
  const checks = 'checks' in c.done ? c.done.checks : [];
  return [
    ...(checks.some((x) => x.kind === 'command')
      ? []
      : [
          'No command check: if completion can be tested, add one (e.g. {kind:"command", argv:["pnpm","test"], timeoutSeconds:600}); the host runs it on the expedition branch head at done',
        ]),
    ...(c.outOfScope.length > 0
      ? []
      : ['No out-of-scope fence (outOfScope): name what the crew must not touch']),
  ];
}

/** Where status posts go: the thread the launch came from, or the owner↔launcher DM. */
export type Origin = { t: 'thread'; channelId: string; rootId: string } | { t: 'direct' };

// ---------- Attempt results ----------

export const ClaimChange = z.discriminatedUnion('t', [
  z
    .object({
      t: z.literal('commit'),
      sha: z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character commit sha'),
    })
    .strict(),
  z.object({ t: z.literal('no_code') }).strict(),
]);
export type ClaimChange = z.infer<typeof ClaimChange>;

export const WorkResult = z.union([
  z
    .object({
      result: z.literal('claim'),
      statement: z.string().min(1),
      /** What the claim changed (design.md R2): a code claim names its immutable candidate commit
       * on the attempt's own branch; a claim about something other than code says so. */
      change: ClaimChange,
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

/**
 * How a question's claims are accepted (design.md R11). `command`: the host runs this argv on the
 * claim's immutable candidate commit in a fresh tree, exactly as it runs the charter's checks at
 * done (exit 0 passes). `panel`: an independent check panel on another model verifies the claim.
 * The goal's done checks run only on the expedition branch at done, never on a candidate unless
 * the manager names one as a question's acceptance. 2026-11-01 incident
 * (own-engine-geometry-opti-1b837b): the charter's done command, fail-closed until every goal
 * item passed, ran on every candidate, so no preparation commit could ever integrate.
 */
export const Acceptance = z.discriminatedUnion('t', [
  z.object({ t: z.literal('command'), argv: Argv, timeoutSeconds: TimeoutSeconds }).strict(),
  z.object({ t: z.literal('panel') }).strict(),
]);
export type Acceptance = z.infer<typeof Acceptance>;

/** A work claim as a manager names it for an attempt whose answer did not report it (R11). */
export const ClaimDraft = z
  .object({
    statement: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character commit sha'),
    evidence: z.array(z.string()).max(20),
    howToCheck: z.string().min(1),
  })
  .strict();

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
      /** Dependencies (design.md R5): question ids. Work on this question waits (stage
       * `waiting`) until each is closed verified; an empty list means none. */
      after: z.array(ref).max(20).default([]),
      /** How its claims are accepted (R11): required, never inferred from the goal. */
      acceptance: Acceptance,
    })
    .strict(),
  /** Changes an open question's acceptance; claims validated before keep their validation. */
  z
    .object({ do: z.literal('set_acceptance'), question: ref, acceptance: Acceptance })
    .strict(),
  /** Claims the commits a work attempt made but did not report (R11): its answer was malformed. */
  z
    .object({ do: z.literal('claim'), attempt: ref, claim: ClaimDraft })
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
  /** Merge a validated claim's commit into the expedition branch (design.md R3). */
  z
    .object({ do: z.literal('integrate'), claimAttempt: ref })
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
