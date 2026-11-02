import { z } from 'zod';

// The owner's WHAT and the attempt answer shapes, parsed once at the boundary (κ).

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const SeatModel = z.discriminatedUnion('t', [
  strict({ t: z.literal('default') }),
  strict({ t: z.literal('named'), id: z.string().min(1) }),
]);
type SeatModel = z.infer<typeof SeatModel>;
const DEFAULT_MODEL: SeatModel = { t: 'default' };

const seatShape = <M extends z.ZodTypeAny>(model: M) =>
  strict({ provider: z.string().min(1), model, reasoningEffort: z.string().min(1).optional() });
const SeatRequest = seatShape(z.string().min(1).optional());
type SeatRequest = z.infer<typeof SeatRequest>;
export const WorkerConfig = seatShape(SeatModel);
export type WorkerConfig = z.infer<typeof WorkerConfig>;

const modelName = (m: SeatModel): string[] => (m.t === 'named' ? [m.id] : []);
export const seatLabel = (w: WorkerConfig) =>
  [w.provider, ...modelName(w.model), w.reasoningEffort].filter(Boolean).join('/');
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

/** Audit 2026-11-01 #5: a NUL in argv made spawn throw and the job re-ran every tick. */
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
const TimeoutSeconds = z.number().int().min(1).max(21_600); // 6 h

/** One done check (R2): a host-run `command` (exit 0 passes), or `judged` by a blind panel. */
export const DoneCheck = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('command'), argv: Argv, timeoutSeconds: TimeoutSeconds }),
  strict({ kind: z.literal('judged'), text: z.string().trim().min(1).max(1000) }),
]);
export type DoneCheck = z.infer<typeof DoneCheck>;
export type CommandCheck = Extract<DoneCheck, { kind: 'command' }>;

export const Done = z.discriminatedUnion('t', [
  strict({ t: z.literal('checks'), checks: z.array(DoneCheck).min(1).max(10) }),
  strict({ t: z.literal('owner') }),
]);
export type Done = z.infer<typeof Done>;

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

/** What a launch names: the WHAT; the rest takes CHARTER_DEFAULTS, each reported as data. */
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

type ProviderModels =
  | { t: 'closed'; models: readonly { id: string; displayName: string }[] }
  | { t: 'open' };
export type ModelsOf = (provider: string) => ProviderModels;

const nameTokens = (name: string) =>
  name
    .toLowerCase()
    .split(/[\s\-_/.]+/)
    .filter(Boolean);

/** Owner words resolve to the one catalog model they pick (2026-11-01: "claude haiku" failed);
 * an open provider keeps its id (`gpt-5` became `gpt-5-nano`, 2026-11-01 review). */
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

export type CharterDefault = keyof typeof CHARTER_DEFAULTS;
export const CHARTER_DEFAULT_KEYS = Object.keys(CHARTER_DEFAULTS) as CharterDefault[];

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

const DEFAULTED_LINE: Record<CharterDefault, string> = {
  inScope: 'inScope: none stated (the goal is the scope)',
  outOfScope: 'outOfScope: none stated (no fence)',
  maxLive: `maxLive: ${CHARTER_DEFAULTS.maxLive}`,
  hours: `hours: ${CHARTER_DEFAULTS.hours}`,
  exploreShare: `exploreShare: ${CHARTER_DEFAULTS.exploreShare}`,
  crew: `crew: the default crew (${crewLine(DEFAULT_CREW)})`,
};
export const defaultedLines = (keys: CharterDefault[]) => keys.map((k) => DEFAULTED_LINE[k]);

export const charterIssues = (c: Charter): string[] =>
  c.crew.work.flatMap((w, seat) =>
    c.crew.check.some((x) => !sameModel(x, w))
      ? []
      : [`work seat ${seat} (${seatLabel(w)}) has no check seat on another model`]
  );

export const doneChecks = (done: Done): DoneCheck[] => (done.t === 'checks' ? done.checks : []);

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

export const Origin = z.discriminatedUnion('t', [
  strict({ t: z.literal('thread'), channelId: z.string(), rootId: z.string() }),
  strict({ t: z.literal('direct') }),
]);
export type Origin = z.infer<typeof Origin>;

export const EXTEND_MAX_HOURS = 72;
const FeedbackText = z.string().trim().min(1).max(2000);

/** Owner steering as the tool, a chat message and the ledger take it (input grows additively). */
export const Feedback = z.union([
  strict({ t: z.enum(['lesson', 'note']), text: FeedbackText }),
  strict({ t: z.enum(['pause', 'resume', 'stop']) }),
  strict({ t: z.literal('extend'), hours: z.number().positive().max(EXTEND_MAX_HOURS) }),
]);
export type Feedback = z.infer<typeof Feedback>;

const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character commit sha');

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
  strict({
    result: z.literal('finding'),
    statement: z.string().min(1),
    evidence: z.array(z.string()),
  }),
  strict({ result: z.literal('blocked'), need: z.string().min(1) }),
]);
export type WorkResult = z.infer<typeof WorkResult>;
export type Claim = Extract<WorkResult, { result: 'claim' }>;

export const CheckResult = strict({
  verdict: z.enum(['verified', 'refuted', 'unclear']),
  why: z.string().min(1),
});
export type CheckResult = z.infer<typeof CheckResult>;

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

/** How claims are accepted (R11). 2026-11-01 (geometry-opti): the fail-closed done command ran
 * on every candidate, so no preparation commit could integrate. */
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
    paths: z.array(CustodyPath).min(1).max(20),
    /** Question ids whose verified close this question's work waits for (design.md R5). */
    after: z.array(ref).max(20).default([]),
    acceptance: Acceptance,
  }),
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
