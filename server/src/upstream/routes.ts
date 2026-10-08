import type { Cursor } from '@unleashd/buddies-core';
import {
  type UnleashdHomeState,
  type UpstreamCheck,
  type UpstreamCheckState,
  type UpstreamStatus,
  type UpstreamUpdateResult,
  buddyMutations,
} from '@unleashd/shared';
import type { Express, Request, Response } from 'express';
import { type BuddiesCore, OWNER, coreError } from '../buddies/core';
import type { BuddyEvents } from '../buddies/events';
import { publishOwnerPost } from '../buddies/routes';
import { type Checkout, UPSTREAM_BRANCH, checkUpstream, resolveCheckout } from './git-upstream';
import { bootstrapUnleashdHome } from './unleashd-home';

// The install's upstream loop, server side:
//   start()  — bootstrap the "unleashd" workspace (unleashd-home.ts) and run
//              the fetch-only check now and every 6 hours. Neither blocks
//              startup; a bootstrap failure is logged (and so journaled).
//   GET  /api/upstream/status — the cached check plus where #upstream lives.
//   POST /api/upstream/update — an owner post in #upstream @mentioning the
//              Upstream Release Manager, which starts its merge turn.

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpstreamServiceDependencies {
  /** Where this server's code lives; the checkout is resolved from here, never process.cwd(). */
  serverDirectory: string;
  desktopPublish?: string;
  core: BuddiesCore;
  events: BuddyEvents;
  uploadsRoot(): string;
}

type UpdateOutcome =
  | { kind: 'posted'; result: UpstreamUpdateResult }
  | { kind: 'refused'; reason: string };

function updateBody(input: {
  releaseManager: { id: string; name: string };
  repoRoot: string;
  remote: string;
  desktopPublish?: string;
}): string {
  const mention = `[@${input.releaseManager.name.replace(/[[\]]/g, '')}](buddy:${input.releaseManager.id})`;
  const desktopPublish = input.desktopPublish;
  const quotedPublish = desktopPublish ? `'${desktopPublish.replace(/'/g, "'\"'\"'")}'` : '';
  // Desktop helper owns reconciliation, dev dependencies, build and smoke. A preliminary
  // production install/build can fail before it runs (upstream + source-install guards).
  const build = desktopPublish
    ? `run node ${quotedPublish} --publish directly; it reconciles submodules, installs build dependencies, builds, typechecks and smoke-checks the desktop runtime. Report the verified revision and ask the owner to reopen Buddies to activate it. If publishing fails, report the error; the previous runtime stays selected.`
    : 'run pnpm install && pnpm build, then report what changed.';
  return `${mention} For folder ${input.repoRoot}: fetch upstream ${input.remote}/${UPSTREAM_BRANCH} and merge in our changes. Commit any local edits first, merge (never reset or rebase), resolve conflicts, then ${build}`;
}

export function createUpstreamService(dependencies: UpstreamServiceDependencies) {
  const { serverDirectory, core, events } = dependencies;
  let check: UpstreamCheckState = { kind: 'pending' };
  let home: UnleashdHomeState = { kind: 'pending' };
  let timer: NodeJS.Timeout | null = null;

  async function refresh(): Promise<UpstreamCheck> {
    const latest = await checkUpstream(await resolveCheckout(serverDirectory));
    check = latest;
    if (latest.kind === 'unavailable') {
      // Offline or no remote is ordinary for a local install: the status
      // route reports it, and it is not an operational failure to journal.
      console.log(`[upstream] check unavailable (${latest.reason}): ${latest.detail}`);
    }
    return latest;
  }

  async function bootstrapCheckout(checkout: Checkout): Promise<UnleashdHomeState> {
    switch (checkout.kind) {
      case 'not_checkout':
        console.log(`[upstream] not a git checkout; no unleashd workspace: ${checkout.detail}`);
        return { kind: 'failed', detail: checkout.detail };
      case 'checkout': {
        const ready = await bootstrapUnleashdHome(core, checkout.root);
        events.emit({ kind: 'changed' });
        return { kind: 'ready', ...ready };
      }
    }
  }

  async function bootstrap(): Promise<void> {
    try {
      home = await bootstrapCheckout(await resolveCheckout(serverDirectory));
    } catch (error) {
      console.error('[upstream] Could not bootstrap the unleashd workspace:', error);
      home = { kind: 'failed', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async function postUpdate(): Promise<UpdateOutcome> {
    if (home.kind !== 'ready')
      return { kind: 'refused', reason: `The unleashd workspace is ${home.kind}` };
    if (check.kind !== 'behind')
      return { kind: 'refused', reason: `Upstream is not ahead of this checkout (${check.kind})` };
    const { workspaceId, channelId, releaseManagerId, repoRoot } = home;
    const { remote, sha } = check;
    // A deleted channel or Buddy is the crate's typed not_found (the route answers 404).
    const releaseManager = await core.getBuddy(releaseManagerId);
    const marker = `upstream ${remote}/${UPSTREAM_BRANCH} ${sha}`;
    // Pattern: idempotency-keys (docs/patterns.md#idempotency-keys)
    // A key deduplicates the write, not the turn. Check every page: the latest-50 shortcut
    // started a second merge after 51 new posts (upstream.test.ts guards the older request).
    let before: Cursor | undefined;
    do {
      const page = await core.listPosts(OWNER, { kind: 'channel', channelId }, before, 100);
      const asked = page.posts.find(
        (post) => post.author.kind === 'owner' && post.evidence.includes(marker)
      );
      if (asked) return { kind: 'posted', result: { workspaceId, channelId, postId: asked.id } };
      before = page.next;
    } while (before);
    const { post } = await publishOwnerPost(
      dependencies,
      OWNER,
      { kind: 'id', id: channelId },
      {
        kind: 'inform',
        body: updateBody({
          releaseManager,
          repoRoot,
          remote,
          desktopPublish: dependencies.desktopPublish,
        }),
        purpose: 'message',
        evidence: [marker],
        broadcast: false,
        key: `upstream-update:${remote}:${sha}`,
      },
      []
    );
    return { kind: 'posted', result: { workspaceId, channelId, postId: post.id } };
  }

  // Requests run one at a time: the crate is async, so a double click would
  // otherwise read "not asked yet" twice before either post lands.
  let queue: Promise<unknown> = Promise.resolve();
  function requestUpdate(): Promise<UpdateOutcome> {
    const next = queue.then(postUpdate);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    start(): void {
      void bootstrap();
      void refresh();
      timer = setInterval(() => void refresh(), CHECK_INTERVAL_MS);
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    refresh,
    bootstrap,
    status(): UpstreamStatus {
      return { check, home };
    },
    requestUpdate,
    registerRoutes(app: Express): void {
      app.get('/api/upstream/status', (_req: Request, res: Response) => {
        res.json({ check, home } satisfies UpstreamStatus);
      });
      const update = buddyMutations['upstream.update'];
      app.post(update.path, (_req: Request, res: Response) => {
        requestUpdate()
          .then((outcome) => {
            switch (outcome.kind) {
              case 'posted':
                res.status(update.status).json(outcome.result);
                return;
              case 'refused':
                res.status(409).json({ error: outcome.reason });
                return;
            }
          })
          .catch((error: unknown) => {
            const typed = coreError(error);
            if (!typed || typed.httpStatus >= 500)
              console.error('[upstream] update failed:', error);
            res.status(typed?.httpStatus ?? 500).json({ error: typed?.message ?? String(error) });
          });
      });
    },
  };
}

export type UpstreamService = ReturnType<typeof createUpstreamService>;
