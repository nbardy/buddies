import type { ConversationRow, RowKind } from '@unleashd/shared';

/** A provider process is alive (streaming implies running). */
export function isRowRunning(row: Pick<ConversationRow, 'run'>): boolean {
  return row.run === 'running' || row.run === 'streaming';
}

export type BuddyRowKind = Extract<RowKind, { t: 'buddy' }>;

/** The Buddy ids of a Buddy thread's row, or null for every other kind. */
export function rowBuddy(row: { kind: RowKind } | null | undefined): BuddyRowKind | null {
  return row?.kind.t === 'buddy' ? row.kind : null;
}
