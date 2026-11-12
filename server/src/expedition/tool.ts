import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXPEDITION_PROPOSAL, type ExpeditionProposal } from '@unleashd/shared';
import { z } from 'zod';
import { buddyActor } from '../buddies/core';
import { announcePost } from '../buddies/events';
import type { BuddyGrant } from '../buddies/grants';
import type { ToolDeps } from '../buddies/mcp';
import { exec, git, resolveBase } from './cambium';
import { hash } from './engine';
import { gates } from './gates';

const act = <T extends 'continue' | 'stop' | 'rewrite'>(doWhat: T) =>
  z.object({ do: z.literal(doWhat), id: z.string(), why: z.string().min(1) }).strict();
const Action = z.union([
  z
    .object({ do: z.literal('propose'), file: z.string(), at: z.literal('base').optional() })
    .strict(),
  z.object({ do: z.literal('list') }).strict(),
  z.object({ do: z.literal('status'), id: z.string() }).strict(),
  act('continue'),
  act('stop'),
  act('rewrite'),
]);
type Action = z.infer<typeof Action>;
async function handle(deps: ToolDeps, grant: BuddyGrant, action: Action): Promise<unknown> {
  const host = deps.expeditions;
  if (!host) throw new Error('Expeditions unavailable');
  const here = () => host.rows().filter((r) => r.workspaceId === grant.workspaceId);
  if ('id' in action && !here().some((r) => r.id === action.id))
    throw new Error('No expedition in this workspace');
  switch (action.do) {
    case 'list':
      return here();
    case 'status':
      return host.view(action.id);
    case 'continue':
    case 'stop':
    case 'rewrite':
      try {
        return await host.act(action.id, grant.buddyId, action.do, action.why);
      } catch (error) {
        return { issues: [String(error)] };
      }
    case 'propose': {
      host.allowed();
      const workspace = (await deps.core.listWorkspaces()).find((w) => w.id === grant.workspaceId);
      if (!workspace || path.isAbsolute(action.file) === Boolean(action.at))
        throw new Error('Use an absolute workspace file, or a repo-relative file with at:base');
      const repo = action.at
        ? await git(workspace.rootPath, ['rev-parse', '--show-toplevel'])
        : workspace.rootPath;
      const file = action.at ? path.resolve(repo, action.file) : fs.realpathSync(action.file);
      if (
        !(action.at ? [repo] : (workspace.folders ?? [workspace.rootPath])).some((root) => {
          const rel = path.relative(fs.realpathSync(root), file);
          return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
        })
      )
        throw new Error('Plan outside workspace');
      const start = action.at ? await resolveBase(repo) : undefined;
      const committed = action.at
        ? await exec('git', repo, ['show', `${start!.commit}:${action.file}`])
        : undefined;
      if (committed?.code) throw new Error(committed.stderr);
      const source = committed?.stdout ?? fs.readFileSync(file, 'utf8');
      let checked: Awaited<ReturnType<typeof gates>>;
      try {
        checked = await gates(file, undefined, committed?.stdout);
        checked.preview.start =
          start && !checked.contract.base && checked.contract.repo === repo
            ? start
            : await resolveBase(
                checked.contract.repo.replace(/^~(?=\/)/, os.homedir()),
                checked.contract.base
              );
      } catch (error) {
        return { issues: [String(error)] };
      }
      if (!action.at && source !== fs.readFileSync(file, 'utf8'))
        return { issues: ['File changed during gates'] };
      const proposal: ExpeditionProposal = {
        file,
        source: committed?.stdout,
        hash: hash(source),
        workspaceId: grant.workspaceId,
        preview: checked.preview,
      };
      let replyToId: string | undefined;
      let channel: Parameters<typeof deps.core.post>[1] = {
        kind: 'direct',
        members: [grant.author, { kind: 'owner' }],
      };
      if (grant.runId) {
        const run = await deps.core.getRun(grant.runId);
        if (run.input.kind === 'post' || run.input.kind === 'deliver') {
          const post = await deps.core.getPost(grant.author, run.input.postId);
          channel = { kind: 'id', id: post.channelId };
          replyToId = post.rootId ?? post.id;
        }
      }
      const by = buddyActor(grant.buddyId);
      const posted = await deps.core.post(by, channel, {
        kind: 'inform',
        replyToId,
        mentions: [],
        broadcast: false,
        body: `Proposed expedition: ${checked.preview.goal}\nBudget $${checked.preview.budget.usd}. Launch from this card.`,
        purpose: 'expedition',
        // A changed base or fetch result needs a new card. Guard: expedition-backend base checkouts.
        key: `expedition:${hash([proposal.hash, checked.preview.start])}`,
        evidence: [EXPEDITION_PROPOSAL + JSON.stringify(proposal)],
      });
      if (posted.created) await announcePost(deps, { kind: 'owner' }, posted.post);
      return { ...checked.preview, card: posted.post.id, next: 'Owner launches from the card.' };
    }
  }
}
export const EXPEDITION_TOOL = {
  writes: true,
  description: `Expeditions: propose {file} checks an absolute workspace plan (repo-relative with at:'base', from origin/HEAD) and posts an owner Launch card; list, status {id} read. Only the owner launches. The contract's manager Buddy may continue|stop|rewrite {id,why}; edit the run's plan.expedition.ts before rewrite, then fix gate issues in this turn. Contract changes are refused; extra cost above autoApply asks the owner.
Import {expedition,step} from 'expedition', zod for schemas. export default expedition({contract,agents,steps,plan:async(steps,x)=>held}).
contract:{goal,leader:'buddy:<id>',repo,budget:{usd,hours},rules,done:[{check}|{review,by}|{owner}]}; optional base (ref/commit),pools,autoApply,call,leaderWake,doneReview. agents:{name:spec|{use:spec,usd?,minutes?}}; spec=harness:model[:effort] or buddy:<id>.
steps:{by,brief,returns?,item?,reads?,web?,checkout?,needs?,judge?,usd?,minutes?} or {run,returns?,item?,minutes?,needs?}. judge:{check}|{review,by}. brief/check/run: text or item=>text. step({...}) infers item callbacks; item needs string id. await name(item?,{id?,reads?,on?,continues?}) requires pass; .try returns passed|failed|errored|cancelled|refused. Use promises and loops. x.ask(q),x.confirm(q),x.checkin(q). Return a passed result. Examples: docs/expeditions/examples/.`,
  schema: z.object({ action: Action }).strict(),
  handler(deps: ToolDeps, grant: BuddyGrant, { action }: { action: Action }) {
    return handle(deps, grant, action);
  },
};
