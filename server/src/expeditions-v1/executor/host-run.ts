import type { keyed } from '@unleashd/shared';
import { parseCommand } from '../../expedition-kernel/argv';
import type { RawOutcome } from '../../expedition-kernel/ports';
import {
  type Capture,
  type ProcessEnd,
  type Stdout,
  restoreOracle,
  runProcess,
  withDetachedTree,
} from '../../expeditions/checks';
import type { RunAddress, RunPaths } from './address';
import type { ExpeditionContext } from './context';
import { checkOutput } from './output-schema';
import { getRef, putRef } from './refs';

// The two run kinds the host runs itself (CONNECT_PLAN §1 "Per kind"): a command step, and a
// check judge (a judged agent's `check`, or a `check` done criterion). Both run argv without a
// shell (argv.ts) through checks.ts `runProcess`, in a detached worktree of `contract.repo` that
// exists only while they run: never in the owner's checkout.

/** Everything a host run needs to know about where it is. */
export type HostRun = {
  readonly address: RunAddress;
  readonly ctx: ExpeditionContext;
  readonly paths: RunPaths;
  /** Stops the process (a cancel or a close): it then settles `cancelled`. */
  readonly signal: AbortSignal;
  readonly onSpawn: (pid: number) => void;
};

/** A JSON answer larger than this is not an answer. */
export const STDOUT_LIMIT_BYTES = 16 << 20;
const errored = (why: string): RawOutcome => ({ t: 'errored', why });

// ---- commands ----

/** What a command's stdout is: `output: null` on the wire means only the tail is kept. */
type Reading = { readonly t: 'tail' } | { readonly t: 'json'; readonly schema: unknown };
const readingOf = (output: unknown): Reading =>
  output === null ? { t: 'tail' } : { t: 'json', schema: output };
const CAPTURE: { readonly [K in Reading['t']]: Capture } = {
  tail: { t: 'tail' },
  json: { t: 'stdout', limitBytes: STDOUT_LIMIT_BYTES },
};

export async function runCommand(h: HostRun, call: keyed.CommandCall): Promise<RawOutcome> {
  const parsed = parseCommand(call.command);
  if (parsed.t === 'refused') return errored(parsed.why);
  const base = await commitOf(h.ctx, call.on);
  if (base.t === 'missing') return errored(base.why);
  const reading = readingOf(call.output);
  return withDetachedTree(h.ctx.repo, h.paths.tree, base.sha, async (cwd) => {
    const end = await runProcess(
      {
        argv: parsed.argv,
        cwd,
        scratch: h.paths.scratch,
        timeoutMs: call.maxMinutes * 60_000,
        env: {},
        capture: CAPTURE[reading.t],
        onSpawn: h.onSpawn,
      },
      h.signal
    );
    const raw = commandEnd(end, reading, call.maxMinutes);
    // The output exists (passed or failed): record where before the kernel can see it.
    if (raw.t === 'ok' || raw.t === 'no')
      await putRef(h.ctx.dir, {
        ref: h.address.ref,
        out: raw.t === 'ok' ? raw.out : { tail: raw.why },
        commit: base.sha,
        checkout: { t: 'none' },
        conversation: { t: 'none' },
      });
    return raw;
  });
}

function commandEnd(end: ProcessEnd, reading: Reading, minutes: number): RawOutcome {
  switch (end.t) {
    case 'exited':
      return end.code === 0 ? answerOf(end.stdout, reading, end.tail) : { t: 'no', why: end.tail };
    case 'timed_out':
      return errored(`exceeded ${minutes} min`);
    case 'stopped':
      return { t: 'cancelled' };
    case 'error':
      return errored(end.message);
  }
}

/** Exit 0: the answer is the tail, or stdout parsed as JSON and checked against the schema. A
 * malformed answer is `errored` here, before the kernel logs or judges anything. */
const answerOf = (stdout: Stdout, reading: Reading, tail: string): RawOutcome =>
  ANSWER[reading.t](reading as never, stdout, tail);
const ANSWER: {
  [K in Reading['t']]: (r: Extract<Reading, { t: K }>, stdout: Stdout, tail: string) => RawOutcome;
} = {
  tail: (_r, _stdout, tail) => ({ t: 'ok', out: { tail } }),
  json: (r, stdout) => JSON_STDOUT[stdout.t](stdout as never, r.schema),
};
const JSON_STDOUT: {
  [K in Stdout['t']]: (s: Extract<Stdout, { t: K }>, schema: unknown) => RawOutcome;
} = {
  // CAPTURE asks for stdout whenever the reading is JSON; this row is there for the compiler.
  'not-captured': () => errored('malformed output: stdout was not captured'),
  overflowed: (s) => errored(`malformed output: stdout is over ${s.limitBytes} bytes`),
  captured: (s, schema) => {
    let out: unknown;
    try {
      out = JSON.parse(s.text);
    } catch (e) {
      return errored(`malformed output: stdout is not JSON (${(e as Error).message})`);
    }
    const checked = checkOutput(schema, out);
    return checked.t === 'valid' ? { t: 'ok', out } : errored(`malformed output: ${checked.why}`);
  },
};

// ---- check judges ----

export async function runCheck(
  h: HostRun,
  spec: { readonly command: string; readonly of: keyed.RefId; readonly maxMinutes: number }
): Promise<RawOutcome> {
  const parsed = parseCommand(spec.command);
  if (parsed.t === 'refused') return errored(parsed.why);
  const judged = await getRef(h.ctx.dir, spec.of);
  if (judged.t === 'missing') return errored(`no stored output at ${spec.of}`);
  const { commit, answerPath } = judged.value;
  return withDetachedTree(h.ctx.repo, h.paths.tree, commit, async (cwd) => {
    // The grader is the launch base's, whatever the judged work did to it (checks.ts audit).
    await restoreOracle(h.ctx.repo, cwd, h.ctx.baseSha, [[...parsed.argv]], []);
    const end = await runProcess(
      {
        argv: parsed.argv,
        cwd,
        scratch: h.paths.scratch,
        timeoutMs: spec.maxMinutes * 60_000,
        env: { EXPEDITION_OUTPUT: answerPath },
        capture: { t: 'tail' },
        onSpawn: h.onSpawn,
      },
      h.signal
    );
    return checkEnd(end, spec.maxMinutes);
  });
}

function checkEnd(end: ProcessEnd, minutes: number): RawOutcome {
  switch (end.t) {
    case 'exited':
      return end.code === 0 ? { t: 'ok', out: { tail: end.tail } } : { t: 'no', why: end.tail };
    case 'timed_out':
      return errored(`exceeded ${minutes} min`);
    case 'stopped':
      return { t: 'cancelled' };
    case 'error':
      return errored(end.message);
  }
}

// ---- where ----

type Commit = { readonly t: 'sha'; readonly sha: string } | { readonly t: 'missing'; why: string };
const BASE: {
  [K in keyed.Base['t']]: (
    ctx: ExpeditionContext,
    b: Extract<keyed.Base, { t: K }>
  ) => Promise<Commit>;
} = {
  launch: async (ctx) => ({ t: 'sha', sha: ctx.baseSha }),
  ref: async (ctx, b) => {
    const found = await getRef(ctx.dir, b.ref);
    return found.t === 'found'
      ? { t: 'sha', sha: found.value.commit }
      : { t: 'missing', why: `no stored output at ${b.ref}, so no commit to run on` };
  },
};
const commitOf = (ctx: ExpeditionContext, b: keyed.Base): Promise<Commit> =>
  BASE[b.t](ctx, b as never);
