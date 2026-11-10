import { randomBytes } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { keyed } from '@unleashd/shared';
import { z } from 'zod';
import { contractFileOf, planDirOf } from '../expedition-kernel/log-store';
import type {
  Disposed,
  ExpeditionView,
  Leader,
  RawOutcome,
  RewriteAt,
  Woken,
} from '../expedition-kernel/ports';
import { parseRunId } from './executor/address';
import type { LeaderSpec } from './executor/calls';
import type { WakeEnd } from './executor/index';
import { getRef } from './executor/refs';
import { leaderBody } from './leader-brief';
import type { OwnerBook } from './owner/book';

// The real Leader port (CONNECT_PLAN §2). A wake is a request the contract's leader Buddy posts to
// itself, keyed `xk:<runId>` with the run id the kernel logged for the wake, in the tool-less
// `call` role: the SAME Buddy-call path as an agent call (executor/calls.ts), so it is one post and
// one crate run per run id, capped by `limits.leaderWake`, metered by the same usage path, and its
// turn directory is its draft folder `<expDir>/drafts/<n>/`: a copy of the current plan version
// plus a read-only `contract.md`. Its answer is one `LeaderAct` (executor/answer.ts); a rewrite
// names that draft folder, and the kernel's gates copy it as the next version.
//
// Write access is by the turn's cwd only: Codex sandboxes writes to it, Claude does not (accepted
// for v1, §2). After a restart the kernel settles a wake that was in flight `errored` and closes
// its id (recovery.ts), which cancels the turn: a wake's answer lives in the process that waits.

export type LeaderDeps = {
  readonly executor: { wake(runId: string, spec: LeaderSpec): Promise<WakeEnd> };
  readonly book: OwnerBook;
};

export const draftDirOf = (expDir: string, n: number): string =>
  path.join(expDir, 'drafts', String(n));
export const DISPOSITIONS = 'dispositions.json';

export function createLeader(d: LeaderDeps): Leader {
  return {
    async wake(runId, event, view) {
      const { key, n, call } = wakeOf(runId, view);
      const draft = draftDirOf(view.dir, n);
      await prepareDraft(view, draft);
      const body = leaderBody({
        runId,
        key,
        view,
        event,
        draft,
        plans: path.dirname(planDirOf(view.dir, 0)),
        notes: (await d.book.read(view.id)).notes,
        refPaths: await refPathsOf(view),
      });
      const end = await d.executor.wake(runId, { t: 'leader', body, draft, max: call.max });
      return (WOKEN[end.raw.t] as (raw: RawOutcome, spent: keyed.Usage) => Woken)(
        end.raw,
        end.spent
      );
    },
    dispose: (at) => readDispositions(at),
  };
}

/** The wake's call, from the run id the kernel logged for it. */
function wakeOf(runId: string, view: ExpeditionView) {
  const { ref } = parseRunId(runId);
  const at = ref.lastIndexOf('@');
  const key = ref.slice(0, at);
  const record = view.state.calls.get(key)?.get(ref.slice(at + 1));
  if (!record || record.call.t !== 'leader')
    throw new Error(`${runId} is not a leader call of ${view.id}`);
  const n = /^leader\/(\d+)$/.exec(key);
  if (!n) throw new Error(`${key} is not a leader wake's key (leader/<n>)`);
  return { key, n: Number(n[1]), call: record.call };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false
  );

/** The current plan version and the contract, copied once per wake: made under a temporary name
 * and renamed, so a draft folder that exists is complete, and a repeated wake keeps the leader's
 * edits. contract.md is read-only: it is the owner's (the rewrite gate rejects a changed one). */
async function prepareDraft(view: ExpeditionView, draft: string): Promise<void> {
  if (await exists(draft)) return;
  const plan = view.state.plan;
  if (plan.t === 'unplanned') throw new Error(`${view.id} has no plan to draft from`);
  await mkdir(path.dirname(draft), { recursive: true, mode: 0o700 });
  const tmp = `${draft}.tmp-${randomBytes(4).toString('hex')}`;
  await cp(planDirOf(view.dir, plan.version), tmp, { recursive: true });
  const contract = path.join(tmp, 'contract.md');
  await copyFile(contractFileOf(view.dir), contract);
  await chmod(contract, 0o444);
  await rename(tmp, draft);
}

/** The answer file of every stored output a key's newest call names. */
async function refPathsOf(view: ExpeditionView): Promise<Map<keyed.RefId, string>> {
  const out = new Map<keyed.RefId, string>();
  for (const [key, byHash] of view.state.calls)
    for (const hash of byHash.keys()) {
      const ref = keyed.refOf(key, hash);
      const found = await getRef(view.dir, ref);
      if (found.t === 'found') out.set(ref, found.value.answerPath);
    }
  return out;
}

/** How a wake's run ended, as the port reports it. Only an act is `acted`; every other end is
 * `errored` and keeps what the turn spent (the kernel charges it). */
const WOKEN: {
  readonly [K in RawOutcome['t']]: (
    raw: Extract<RawOutcome, { t: K }>,
    spent: keyed.Usage
  ) => Woken;
} = {
  // The executor validated it (answer.ts); parsed again here, at the port's boundary.
  ok: (raw, spent) => ({ t: 'acted', act: keyed.LeaderAct.parse(raw.out), spent }),
  no: (raw, spent) => ({ t: 'errored', why: `the wake answered no: ${raw.why}`, spent }),
  errored: (raw, spent) => ({ t: 'errored', why: raw.why, spent }),
  cancelled: (_raw, spent) => ({ t: 'errored', why: 'the wake was cancelled', spent }),
};

const Dispositions = z.record(keyed.Key, keyed.Disposition);
/** `dispositions.json` in the submitted folder. Missing is no choice at all (`{}`: the rules gate
 * then rejects the rewrite as `undecided`, and the next wake is told); unreadable is a rejection
 * naming why, never taken as `{}`. */
async function readDispositions(at: RewriteAt): Promise<Disposed> {
  const file = path.join(at.folder, DISPOSITIONS);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { t: 'decided', dispositions: {} };
    return { t: 'invalid', issues: [`${DISPOSITIONS} could not be read: ${(e as Error).message}`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { t: 'invalid', issues: [`${DISPOSITIONS} is not JSON: ${(e as Error).message}`] };
  }
  const parsed = Dispositions.safeParse(json);
  return parsed.success
    ? { t: 'decided', dispositions: parsed.data }
    : {
        t: 'invalid',
        issues: [
          `${DISPOSITIONS} must map each dropped key to "cancel" or "finish": ${parsed.error.message}`,
        ],
      };
}
