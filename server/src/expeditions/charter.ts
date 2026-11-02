import { z } from 'zod';

// The owner's WHAT (reflection never edits it) and the attempt answer shapes, parsed once at the
// boundary: the charter by the `expedition` tool, results by answers.ts `parseOutcome` (κ).

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/** A seat's model: the provider's default (picked at run time), or a catalog id (charterOf). */
const SeatModel = z.discriminatedUnion('t', [
  strict({ t: z.literal('default') }),
  strict({ t: z.literal('named'), id: z.string().min(1) }),
]);
type SeatModel = z.infer<typeof SeatModel>;
const DEFAULT_MODEL: SeatModel = { t: 'default' };

const seatShape = <M extends z.ZodTypeAny>(model: M) =>
  strict({ provider: z.string().min(1), model, reasoningEffort: z.string().min(1).optional() });
/** A seat as a launch names it (the tool's input): the model may be left out or an owner word. */
const SeatRequest = seatShape(z.string().min(1).optional());
type SeatRequest = z.infer<typeof SeatRequest>;
/** A chartered seat (canonical: what the ledger and drafts hold). */
export const WorkerConfig = seatShape(SeatModel);
export type WorkerConfig = z.infer<typeof WorkerConfig>;

const modelName = (m: SeatModel): string[] => (m.t === 'named' ? [m.id] : []);
/** A seat's display name, e.g. `codex/gpt-5/high`. */
export const seatLabel = (w: WorkerConfig) =>
  [w.provider, ...modelName(w.model), w.reasoningEffort].filter(Boolean).join('/');
/** Same provider and model (effort aside): the independence rule for checks. */
export const sameModel = (a: WorkerConfig, b: WorkerConfig) =>
  a.provider === b.provider && modelName(a.model).join() === modelName(b.model).join();
/** The run config a seat's Buddy run takes (the crate's shape: an absent model is its default). */
export const seatRunConfig = (w: WorkerConfig) => ({
  provider: w.provider,
  model: modelName(w.model).at(0),
  reasoningEffort: w.reasoningEffort,
});

/** Work and check rosters: the manager picks a work seat; checks never run on the author's model. */
const rosterOf = <S extends z.ZodTypeAny>(seat: S) =>
  strict({ manager: seat, work: z.array(seat).min(1).max(4), check: z.array(seat).min(1).max(4) });
export const Crew = rosterOf(WorkerConfig);
export type Crew = z.infer<typeof Crew>;
const CrewRequest = rosterOf(SeatRequest);
type CrewRequest = z.infer<typeof CrewRequest>;

/** A host-run argv element (audit 2026-11-01 #5): a NUL byte made `spawn` throw before the check
 * started, and the thrown job re-ran every tick (a hot loop). `argv[0]` is never a shell word. */
const ArgvWord = z
  .string()
  .min(1)
  .refine((w) => !w.includes('\0'), { message: 'an argv element may not contain a NUL byte' });
const Argv = z
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

/** One done check (design.md R2): `command` the HOST runs in a fresh tree (exit 0 passes);
 * `judged` a blind goal-check panel verifies by strict majority. */
export const DoneCheck = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('command'), argv: Argv, timeoutSeconds: TimeoutSeconds }),
  strict({ kind: z.literal('judged'), text: z.string().trim().min(1).max(1000) }),
]);
export type DoneCheck = z.infer<typeof DoneCheck>;
export type CommandCheck = Extract<DoneCheck, { kind: 'command' }>;

/** How completion is decided: typed checks, or the owner's judgment (declared, never defaulted). */
export const Done = z.discriminatedUnion('t', [
  strict({ t: z.literal('checks'), checks: z.array(DoneCheck).min(1).max(10) }),
  strict({ t: z.literal('owner') }),
]);
export type Done = z.infer<typeof Done>;

/** `done` as a launch names it (the tool's input, unchanged since R2). κ: charterOf. */
const DoneRequest = z.union([
  strict({ checks: z.array(DoneCheck).min(1).max(10) }),
  strict({ ownerJudgment: z.literal(true) }),
]);

export const Charter = strict({
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
});
export type Charter = z.infer<typeof Charter>;

// ---------- Kickoff (design.md R7) ----------

/** What a launch or draft names: only the WHAT is required; the rest takes CHARTER_DEFAULTS, each
 * listed in the tool result (provenance as data). The ledger always holds the full `Charter`. */
export const CharterRequest = Charter.extend({ done: DoneRequest, crew: CrewRequest }).partial({
  inScope: true,
  outOfScope: true,
  maxLive: true,
  hours: true,
  exploreShare: true,
  crew: true,
});
export type CharterRequest = z.infer<typeof CharterRequest>;

const seat = (provider: string) => ({ provider, model: DEFAULT_MODEL });
/** A Claude manager, work and checks on Claude and Codex (every claim has an other-model check). */
const DEFAULT_CREW: Crew = {
  manager: seat('claude'),
  work: [seat('claude'), seat('codex')],
  check: [seat('codex'), seat('claude')],
};
const CHARTER_DEFAULTS = {
  inScope: [] as string[],
  outOfScope: [] as string[],
  maxLive: 2,
  hours: 8,
  exploreShare: 0.2,
  crew: DEFAULT_CREW,
};

export const crewLine = (crew: Crew) =>
  `manager ${seatLabel(crew.manager)}; work ${crew.work.map(seatLabel).join(', ')}; check ${crew.check.map(seatLabel).join(', ')}`;

/** A provider's installed models: a closed list, or open for ad-hoc ids (pi, opencode). */
type ProviderModels =
  | { t: 'closed'; models: readonly { id: string; displayName: string }[] }
  | { t: 'open' };
export type ModelsOf = (provider: string) => ProviderModels;

const nameTokens = (name: string) =>
  name
    .toLowerCase()
    .split(/[\s\-_/.]+/)
    .filter(Boolean);

/**
 * A seat's model as the catalog names it (design.md R9): owner words ("claude haiku") resolve when
 * they pick exactly one model of a closed catalog, else stay as written for the seat check to
 * refuse (2026-11-01 smoke: "claude haiku" failed the launch). An open provider's id is kept as
 * written: matching rewrote `opencode/gpt-5` to `opencode/gpt-5-nano` (2026-11-01 review).
 */
function seatOf(
  seat: SeatRequest,
  where: string,
  models: ModelsOf
): { seat: WorkerConfig; resolved: string[] } {
  if (seat.model === undefined) return { seat: { ...seat, model: DEFAULT_MODEL }, resolved: [] };
  const catalog = models(seat.provider);
  const id = catalog.t === 'open' ? seat.model : catalogId(seat.model, catalog.models);
  return {
    seat: { ...seat, model: { t: 'named', id } },
    resolved: id === seat.model ? [] : [`${where}: "${seat.model}" → ${id}`],
  };
}

function catalogId(model: string, catalog: readonly { id: string; displayName: string }[]): string {
  if (catalog.some((m) => m.id === model)) return model;
  const want = nameTokens(model);
  const matches = catalog.filter((m) => {
    const have = new Set([...nameTokens(m.id), ...nameTokens(m.displayName)]);
    return want.every((t) => have.has(t));
  });
  return matches.length === 1 ? matches[0].id : model;
}

function crewOf(crew: CrewRequest, models: ModelsOf) {
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

/** κ for a launch: the full charter, the fields it defaulted, and each seat model it resolved. */
export function charterOf(
  request: CharterRequest,
  models: ModelsOf
): { charter: Charter; defaulted: CharterDefault[]; resolved: string[] } {
  const seats =
    request.crew === undefined
      ? { crew: CHARTER_DEFAULTS.crew, resolved: [] }
      : crewOf(request.crew, models);
  const charter: Charter = {
    ...request,
    done: 'checks' in request.done ? { t: 'checks', checks: request.done.checks } : { t: 'owner' },
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

/** The tool result's line per defaulted field (the card marks the value instead). */
const DEFAULTED_LINE: Record<CharterDefault, string> = {
  inScope: 'inScope: none stated (the goal is the scope)',
  outOfScope: 'outOfScope: none stated (no fence)',
  maxLive: `maxLive: ${CHARTER_DEFAULTS.maxLive}`,
  hours: `hours: ${CHARTER_DEFAULTS.hours}`,
  exploreShare: `exploreShare: ${CHARTER_DEFAULTS.exploreShare}`,
  crew: `crew: the default crew (${crewLine(DEFAULT_CREW)})`,
};
export const defaultedLines = (keys: CharterDefault[]) => keys.map((k) => DEFAULTED_LINE[k]);

/** Refuses a launch before any I/O: a work seat no check seat on another model can verify. */
export const charterIssues = (c: Charter): string[] =>
  c.crew.work.flatMap((w, seat) =>
    c.crew.check.some((x) => !sameModel(x, w))
      ? []
      : [`work seat ${seat} (${seatLabel(w)}) has no check seat on another model`]
  );

/** The charter's typed done checks (none when the owner judges completion). */
export const doneChecks = (done: Done): DoneCheck[] => (done.t === 'checks' ? done.checks : []);

/** Non-blocking: what would make the charter checkable by the host rather than by judgment. */
export const charterAdvice = (c: Charter): string[] => [
  ...(doneChecks(c.done).some((x) => x.kind === 'command')
    ? []
    : [
        'No command check: if completion can be tested, add one (e.g. {kind:"command", argv:["pnpm","test"], timeoutSeconds:600}); the host runs it on the expedition branch head at done',
      ]),
  ...(c.outOfScope.length > 0
    ? []
    : ['No out-of-scope fence (outOfScope): name what the crew must not touch']),
];

/** Where status posts go: the thread the launch came from, or the owner↔launcher DM. */
export const Origin = z.discriminatedUnion('t', [
  strict({ t: z.literal('thread'), channelId: z.string(), rootId: z.string() }),
  strict({ t: z.literal('direct') }),
]);
export type Origin = z.infer<typeof Origin>;

/** The most hours one `extend` adds (the charter's own `hours` limit). */
export const EXTEND_MAX_HOURS = 72;
const FeedbackText = z.string().trim().min(1).max(2000);

/** Owner steering however it arrives (the tool's `steer`, a chat message via answers.ts), as the
 * ledger records it. The tool's input grouping changes only additively (tool-contract.test.ts). */
export const Feedback = z.union([
  strict({ t: z.enum(['lesson', 'note']), text: FeedbackText }),
  strict({ t: z.enum(['pause', 'resume', 'stop']) }),
  strict({ t: z.literal('extend'), hours: z.number().positive().max(EXTEND_MAX_HOURS) }),
]);
export type Feedback = z.infer<typeof Feedback>;

// ---------- Attempt results ----------

const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character commit sha');

/** What a claim changed (design.md R2): its candidate commit on its own branch, or no code. */
export const ClaimChange = z.discriminatedUnion('t', [
  strict({ t: z.literal('commit'), sha: Sha }),
  strict({ t: z.literal('no_code') }),
]);
export type ClaimChange = z.infer<typeof ClaimChange>;

export const WorkResult = z.union([
  strict({
    result: z.literal('claim'),
    statement: z.string().min(1),
    change: ClaimChange,
    evidence: z.array(z.string()),
    howToCheck: z.string().min(1),
  }),
  strict({ result: z.literal('finding'), statement: z.string().min(1), evidence: z.array(z.string()) }),
  strict({ result: z.literal('blocked'), need: z.string().min(1) }),
]);
export type WorkResult = z.infer<typeof WorkResult>;
export type Claim = Extract<WorkResult, { result: 'claim' }>;

export const CheckResult = strict({
  verdict: z.enum(['verified', 'refuted', 'unclear']),
  why: z.string().min(1),
});
export type CheckResult = z.infer<typeof CheckResult>;

/** In the charter's scope, budgeted exploration, or parked until the owner funds it. */
export const QuestionScope = z.enum(['in', 'explore', 'parked']);
export type QuestionScope = z.infer<typeof QuestionScope>;

/** A repo-relative file-custody prefix, normalized once (`./a/b/` → `a/b`, whole repo → `.`). */
export const CustodyPath = z
  .string()
  .trim()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
    message: 'a repo-relative path inside the repository',
  })
  .transform((p) => p.replace(/^(\.\/)+/, '').replace(/\/+$/, '') || '.');

/**
 * How a question's claims are accepted (design.md R11): a host-run argv on the claim's commit, or
 * an independent panel. 2026-11-01 incident (own-engine-geometry-opti-1b837b): the charter's
 * fail-closed done command ran on every candidate, so no preparation commit could integrate.
 */
export const Acceptance = z.discriminatedUnion('t', [
  strict({ t: z.literal('command'), argv: Argv, timeoutSeconds: TimeoutSeconds }),
  strict({ t: z.literal('panel') }),
]);
export type Acceptance = z.infer<typeof Acceptance>;

const ref = z.string().min(1);
export const ManagerAction = z.discriminatedUnion('do', [
  strict({
    do: z.literal('add_question'),
    title: z.string().min(1).max(200),
    detail: z.string().min(1).max(2000),
    scope: QuestionScope,
    /** File custody: work attempts on overlapping paths never run at once. */
    paths: z.array(CustodyPath).min(1).max(20),
    /** Question ids whose verified close this question's work waits for (design.md R5). */
    after: z.array(ref).max(20).default([]),
    acceptance: Acceptance,
  }),
  /** Claims validated under an earlier acceptance keep their validation. */
  strict({ do: z.literal('set_acceptance'), question: ref, acceptance: Acceptance }),
  /** Claims the commits a work attempt made but did not report (R11). */
  strict({
    do: z.literal('claim'),
    attempt: ref,
    claim: strict({
      statement: z.string().min(1),
      sha: Sha,
      evidence: z.array(z.string()).max(20),
      howToCheck: z.string().min(1),
    }),
  }),
  strict({
    do: z.literal('work'),
    question: ref,
    seat: z.number().int().min(0),
    brief: z.string().min(1).max(4000),
  }),
  strict({
    do: z.literal('check'),
    claimAttempt: ref,
    goal: z.boolean(),
    panel: z.number().int().min(1).max(3),
  }),
  /** Merge a validated claim's commit into the expedition branch (design.md R3). */
  strict({ do: z.literal('integrate'), claimAttempt: ref }),
  strict({
    do: z.literal('close_question'),
    question: ref,
    status: z.enum(['verified', 'dead']),
    why: z.string().min(1),
  }),
  strict({ do: z.literal('ask_owner'), question: z.string().min(1) }),
  strict({ do: z.literal('done'), summary: z.string().min(1) }),
  strict({ do: z.literal('note'), text: z.string().min(1).max(2000) }),
]);
export type ManagerAction = z.infer<typeof ManagerAction>;
export const ManagerResult = strict({ actions: z.array(ManagerAction).max(30) });
