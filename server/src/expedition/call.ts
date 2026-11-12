import fs from 'node:fs';
import path from 'node:path';
import { type TurnCapabilities, type TurnGit, parseModelString } from '@nbardy/agent-cli';
import type { ExpeditionRef, ExpeditionResult } from '@unleashd/shared';
import Ajv from 'ajv';
import { priceUsd } from '../providers/pricing';
import type { RunTurnOutcome, RunTurnRequest } from '../turns/run-turn';
import { answerValue } from './answer';
import type { Call } from './author';
import { add, exec, git, release } from './cambium';
import { command } from './checks';
import { type Contract, defaultCap } from './gates';

const ajv = new Ajv({ strictTypes: false, strictTuples: false, validateFormats: false });
export const verdict = {
  type: 'object',
  properties: { verdict: { enum: ['yes', 'no'] }, why: { type: 'string', minLength: 1 } },
  required: ['verdict', 'why'],
  additionalProperties: false,
};
export function readAnswer(body: string, schema: object): unknown {
  const value = answerValue(body);
  if (!ajv.validate(schema, value)) throw new Error(`Malformed answer: ${ajv.errorsText()}`);
  return value;
}
export type Turn =
  | { t: 'read'; reads: string[]; web: boolean }
  | { t: 'checkout'; tree: string; temp: string; reads: string[]; web: boolean; git: TurnGit };
// Pattern: sum-types (docs/patterns.md#sum-types)
export function capabilitiesOf(turn: Turn): TurnCapabilities {
  const files: TurnCapabilities['files'] =
    turn.t === 'read'
      ? { t: 'read', roots: turn.reads }
      : {
          t: 'write',
          dir: turn.tree,
          temp: turn.temp,
          reads: turn.reads,
          shell: 'on',
          git: turn.git,
        };
  return {
    files,
    web: turn.web ? 'on' : 'off',
    instructions: turn.t === 'read' ? 'none' : 'project',
    agents: 'off',
    schedule: 'off',
    mcp: 'none',
  };
}
export function prompt(
  brief: string,
  inputs: unknown,
  caps: TurnCapabilities,
  schema: object,
  provider: string
): string {
  const location =
    caps.files.t === 'write'
      ? `Write and commit only in ${caps.files.dir}; private temp ${caps.files.temp}. Git commit metadata is writable. Shell chains and heredocs are allowed. Use mktemp "$TMPDIR/x.XXXXXX". Report refusals; never escape the sandbox.`
      : `Read only: ${caps.files.roots.join(', ')}. Codex: use the shell tool (exec_command, directly or through the code execution tool) to open the files before answering; the shell can read files without writing them.`;
  return `${brief}\n\nINPUTS\n${JSON.stringify(inputs)}\n\nLIMITS (${provider})\n${location}\nWeb ${caps.web}. No helpers, scheduling, or MCP. ${caps.instructions === 'project' ? 'Load project instructions.' : 'No additional instructions requested.'}\nCodex read roots, helper exclusion, shell-off intent and global instructions are advisory. Claude checkout shell reads are advisory.\n\nANSWER FORMAT\nThe final message is your answer: LAST fenced json block, otherwise the whole message as JSON, otherwise its last complete top-level JSON value. End with JSON matching ${JSON.stringify(schema)}. Bare JSON or progress followed by JSON is allowed. Files are relative paths inside your own directory.`;
}
export async function worktreeGit(tree: string, branch: string): Promise<TurnGit> {
  const [admin, common] = (
    await git(tree, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  ).split('\n');
  const dirs = [
    admin!,
    path.join(common!, 'objects'),
    path.join(common!, 'refs/heads', path.dirname(branch)),
    path.join(common!, 'logs/refs/heads', path.dirname(branch)),
  ];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  return { t: 'worktree', dirs: dirs.map((d) => fs.realpathSync(d)) };
}
export type CallDeps = {
  runTurn(r: RunTurnRequest): Promise<RunTurnOutcome>;
  cancelTurn(key: string): Promise<void>;
  resolve(who: string): Promise<{ provider: string; model: string; effort: string }>;
};
export const modelOf = (who: string) => {
  const model = parseModelString(who);
  if (model.t === 'invalid') throw new Error(model.why);
  return {
    provider: model.provider,
    model: model.model,
    effort: model.effort.t === 'none' ? '' : model.effort.value,
  };
};
export type Receipt = {
  result: ExpeditionResult;
  cost: number;
  conversationId?: string;
  commit?: string;
  why?: string;
  review?: Receipt & { who: string };
};
export async function execute(
  d: CallDeps,
  c: Exclude<Call, { t: 'question' }>,
  at: {
    token: string;
    folder: string;
    repo: string;
    base: string;
    contract: Contract;
    signal: AbortSignal;
  }
): Promise<Receipt> {
  const own = path.join(at.folder, 'work', at.token);
  fs.mkdirSync(own, { recursive: true });
  const tree = path.join(own, at.token),
    temp = path.join(own, 'tmp'),
    branch = `expedition/${at.token}`;
  const candidate = c.inputs.on ?? c.inputs.continues;
  const base = candidate?.ref.commit ?? at.base;
  const ref: ExpeditionRef = { id: at.token, base, commit: base };
  const checkout = async (write: boolean) => {
    if (!fs.existsSync(path.join(tree, '.git'))) {
      if (write) {
        const existing = await exec('git', at.repo, [
          'rev-parse',
          '--verify',
          `refs/heads/${branch}`,
        ]);
        if (existing.code === 0) await git(at.repo, ['worktree', 'add', tree, branch]);
        else {
          await add(at.repo, { workspace: at.token, branch, path: tree, baseSha: base });
        }
      } else await git(at.repo, ['worktree', 'add', '--detach', tree, base]);
    }
    fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  };
  const turns: string[] = [];
  const run = async (
    key: string,
    by: string,
    brief: string,
    schema: object,
    caps: TurnCapabilities,
    cwd: string,
    usd: number,
    inputs: unknown,
    minutes = c.minutes
  ): Promise<Receipt> => {
    if (at.signal.aborted) return { cost: 0, result: { t: 'cancelled', partial: ref } };
    const model = await d.resolve(by);
    turns.push(key);
    const request: RunTurnRequest = {
      key,
      ...model,
      cwd,
      // Forward the grants too: a prompt alone left the first real run on chat permissions.
      // Guard: expedition-backend rejects bypass argv for every expedition turn.
      capabilities: caps,
      prompt: prompt(brief, inputs, caps, schema, model.provider),
      maxRuntimeMs: Math.ceil(minutes * 60000),
      title: `Expedition ${c.key}`,
    };
    const o = await d.runTurn(request);
    const priced =
      o.usage.t === 'reported'
        ? priceUsd(model.provider as Parameters<typeof priceUsd>[0], model.model, {
            ...o.usage.tokens,
            reportedCostUsd: 0,
          })
        : { t: 'unpriced' as const };
    const cost = priced.t === 'priced' ? priced.usd : usd;
    if (o.t !== 'complete')
      return {
        cost,
        conversationId: o.conversationId,
        result:
          o.t === 'cancelled' ? { t: 'cancelled', partial: ref } : { t: 'errored', why: o.detail },
      };
    let out: unknown;
    try {
      out = readAnswer(o.text, schema);
    } catch (error) {
      return {
        cost,
        conversationId: o.conversationId,
        result: { t: 'errored', why: `${error}; ${o.text.slice(0, 160)}` },
      };
    }
    const decision = schema === verdict ? (out as { verdict: string; why: string }) : undefined;
    return {
      cost,
      conversationId: o.conversationId,
      why: decision?.why,
      result: { t: decision?.verdict === 'no' ? 'failed' : 'passed', why: decision?.why, out, ref },
    };
  };
  const cancel = () => {
    for (const key of turns) void d.cancelTurn(key);
  };
  at.signal.addEventListener('abort', cancel);
  try {
    switch (c.t) {
      case 'command': {
        await checkout(false);
        const r = await command(c.command, tree, c.minutes, at.signal);
        const out = c.output ? readAnswer(r.stdout, c.output) : { summary: r.tail, files: [] };
        return {
          cost: 0,
          commit: base,
          result: { t: r.code === 0 ? 'passed' : 'failed', out, ref, why: r.tail },
        };
      }
      case 'agent': {
        if (c.checkout) await checkout(true);
        // Done reviews read the candidate's exact tree too, rather than only its answer.
        // Guard: expedition-backend reads the source and diff for a done review.
        const pinned = !c.checkout && candidate?.ref.commit;
        if (pinned) {
          await checkout(false);
          fs.writeFileSync(
            path.join(own, 'changes.diff'),
            await git(at.repo, ['diff', at.base, base])
          );
        }
        const cwd = c.checkout ? tree : own;
        const reads = [
          ...c.reads.map((p) => path.resolve(at.repo, p)),
          ...(pinned ? [tree, own] : []),
        ];
        const caps = capabilitiesOf(
          c.checkout
            ? { t: 'checkout', tree, temp, reads, web: c.web, git: await worktreeGit(tree, branch) }
            : { t: 'read', reads, web: c.web }
        );
        const r = await run(
          at.token,
          c.by,
          `${at.contract.rules.join('\n')}\n${c.brief}\n${c.checkout ? `Starting commit ${base}. Commit your changes.` : ''}${pinned ? `\nTHE CODE: exact commit ${base} at ${tree}; diff ${path.join(own, 'changes.diff')}. Open both.` : ''}`,
          c.output!,
          caps,
          cwd,
          c.usd,
          c.inputs
        );
        if (c.checkout) ref.commit = await git(tree, ['rev-parse', 'HEAD']);
        if (r.result.t !== 'passed') return { ...r, commit: ref.commit };
        if (typeof r.result.out === 'object' && r.result.out && 'files' in r.result.out) {
          for (const file of (r.result.out as { files: string[] }).files) {
            const rel = path.relative(
              fs.realpathSync(cwd),
              fs.realpathSync(path.resolve(cwd, file))
            );
            if (
              path.isAbsolute(file) ||
              rel === '..' ||
              rel.startsWith(`..${path.sep}`) ||
              !fs.statSync(path.join(cwd, file)).isFile()
            )
              throw new Error(`Answer file outside turn: ${file}`);
          }
        }
        let why: string | undefined, reviewReceipt: Receipt['review'];
        if (c.judge && 'check' in c.judge) {
          const checkTree = path.join(own, 'check');
          await git(at.repo, ['worktree', 'add', '--detach', checkTree, ref.commit!]);
          try {
            const check = await command(c.judge.check, checkTree, c.minutes, at.signal);
            if (check.code !== 0) why = check.tail;
          } finally {
            await git(at.repo, ['worktree', 'remove', '--force', checkTree]);
          }
        }
        if (c.judge && 'review' in c.judge) {
          const j = c.judge;
          const reviewTree = path.join(own, 'review');
          if (!fs.existsSync(reviewTree))
            await git(at.repo, ['worktree', 'add', '--detach', reviewTree, ref.commit!]);
          if ((await git(reviewTree, ['rev-parse', 'HEAD'])) !== ref.commit)
            throw new Error('Review checkout is at the wrong commit');
          const diff = path.join(own, 'changes.diff');
          fs.writeFileSync(diff, await git(at.repo, ['diff', base, ref.commit!]));
          try {
            const max = at.contract.doneReview ?? defaultCap(at.contract);
            const review = await run(
              `${at.token}/review`,
              j.by,
              `THE CODE: exact commit ${ref.commit} at ${reviewTree}; diff ${diff}. Open both and quote code.\n${j.review}`,
              verdict,
              capabilitiesOf({ t: 'read', reads: [reviewTree, own], web: false }),
              own,
              max.usd,
              r.result,
              max.minutes
            );
            if (review.result.t !== 'passed') why = JSON.stringify(review.result);
            reviewReceipt = { ...review, who: j.by };
          } finally {
            await git(at.repo, ['worktree', 'remove', '--force', reviewTree]);
          }
        }
        return {
          ...r,
          cost: r.cost + (reviewReceipt?.cost ?? 0),
          review: reviewReceipt,
          commit: ref.commit,
          result: { ...r.result, ref, t: why ? 'failed' : 'passed', why },
        };
      }
    }
  } finally {
    at.signal.removeEventListener('abort', cancel);
    if (c.t === 'agent' && c.checkout) {
      await release(at.repo, at.token, `refs/expedition-salvage/${at.token}`);
    } else if (fs.existsSync(tree)) await git(at.repo, ['worktree', 'remove', '--force', tree]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
