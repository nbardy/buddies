import type { ExpeditionAttempt, ExpeditionQuestion, ExpeditionRun } from '@unleashd/shared';

// Pure view helpers for the expedition badge and page (no React).

export const expeditionUrl = (id: string) => `/api/buddies/expeditions/${encodeURIComponent(id)}`;
export const expeditionHref = (id: string) => `/expeditions/${encodeURIComponent(id)}`;

export function runLabel(run: ExpeditionRun): string {
  switch (run.t) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'waiting_owner':
      return 'needs you';
    case 'finished':
      return `finished (${run.reason.replaceAll('_', ' ')})`;
  }
}

export function attemptState(a: ExpeditionAttempt): string {
  switch (a.phase) {
    case 'planned':
      return 'queued';
    case 'posting':
    case 'posted':
      return 'running';
    case 'ended':
      return a.outcome ?? 'ended';
  }
}

export const QUESTION_GLYPH: Record<ExpeditionQuestion['status'], string> = {
  open: '○',
  verified: '✓',
  dead: '✗',
};

export type Focus = 'workers' | 'tasks' | 'reflections' | 'charter' | 'chat';
export const FOCI: { focus: Focus; label: string }[] = [
  { focus: 'workers', label: 'Workers' },
  { focus: 'tasks', label: 'Tasks' },
  { focus: 'reflections', label: 'Reflections' },
  { focus: 'charter', label: 'Goal' },
  { focus: 'chat', label: 'Chat' },
];
