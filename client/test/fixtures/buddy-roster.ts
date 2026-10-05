import type { Buddy, WorkspaceRoster } from '../../src/components/buddies/types';

/** A crate `Buddy` with every required field; override what the test is about. */
export function buddyFixture(overrides: Partial<Buddy> & Pick<Buddy, 'id' | 'name'>): Buddy {
  return {
    workspaceId: 'ws-1',
    slug: overrides.id,
    role: 'Teammate',
    status: 'active',
    maxActiveRuns: 2,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/** One overview entry: a workspace with its Buddies. */
export function rosterFixture(
  buddies: Buddy[],
  overrides: Partial<WorkspaceRoster> = {}
): WorkspaceRoster {
  return {
    id: 'ws-1',
    name: 'Unleashd',
    rootPath: '/tmp/unleashd',
    createdAt: '2026-09-01T00:00:00.000Z',
    buddies,
    taskCounts: [],
    ...overrides,
  };
}

/** The install agent every pre-2026-10-05 picker test assumed: Codex on PATH. */
export const CODEX_INSTALLED = { kind: 'agent', provider: 'codex' } as const;
