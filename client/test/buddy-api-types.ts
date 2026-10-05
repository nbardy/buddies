import type { BuddyMutationResults } from '@unleashd/shared';
import { buddyApi, buddyWrite } from '../src/components/buddies/api';

// Compiled by pnpm typecheck, never executed. Removing contract typing makes these
// expected-error directives fail, guarding the loose writer that missed model retries.
function contracts() {
  const config = {
    provider: 'codex',
    model: { mode: 'default' },
    reasoning: { mode: 'default' },
  } as const;
  const retry: Promise<BuddyMutationResults['reply.retry']> = buddyWrite(
    'reply.retry',
    { postId: 'p' },
    { config }
  );
  // @ts-expect-error retry requires its model config
  buddyWrite('reply.retry', { postId: 'p' }, {});
  // @ts-expect-error a body cannot add unknown fields to a strict endpoint
  buddyWrite('reply.retry', { postId: 'p' }, { config, extra: true });
  // @ts-expect-error the path parameter is postId, not buddyId
  buddyWrite('reply.retry', { buddyId: 'b' }, { config });
  buddyWrite(
    'task.update',
    { taskId: 't' },
    // @ts-expect-error task changes contain fields, not a task object
    { baseRevision: 1, changes: { task: {}, position: 0 } }
  );
  // @ts-expect-error revisions are numeric
  buddyWrite('task.update', { taskId: 't' }, { baseRevision: '1', changes: { paused: true } });
  // @ts-expect-error workspace creation is unkeyed
  buddyWrite('workspace.create', {}, { rootPath: '/tmp', key: 'k' });
  // @ts-expect-error workspace creation has no path parameters
  buddyWrite('workspace.create', { workspaceId: 'w' }, { rootPath: '/tmp' });
  buddyWrite(
    'doc.write',
    // @ts-expect-error doc kinds come from the shared wire schema
    { buddyId: 'b', kind: 'unknown' },
    { content: 'x', baseRevision: 0, reason: 'edit' }
  );
  // @ts-expect-error bodyless actions accept no JSON object
  buddyWrite('direct.open', { buddyId: 'b' }, { key: 'k' });
  // @ts-expect-error callers cannot choose the response type
  const wrong: Promise<{ conversationId: string }> = retry;
  // @ts-expect-error mutation routes are closed, not arbitrary URLs or methods
  buddyWrite('/api/buddies/posts/p/retry', 'POST', { config });
  // @ts-expect-error read helper cannot bypass the mutation contract
  buddyApi('/api/buddies/posts/p/retry', { method: 'POST' });
  return { retry, wrong };
}
void contracts;
