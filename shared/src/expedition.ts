import { z } from 'zod';

export const ExpeditionProposal = z.object({
  file: z.string(),
  hash: z.string(),
  workspaceId: z.string(),
  source: z.string().optional(),
  preview: z.object({
    goal: z.string(),
    leader: z.string(),
    repo: z.string(),
    start: z.object({ commit: z.string(), line: z.string() }).optional(),
    budget: z.object({ usd: z.number(), hours: z.number() }),
    costUsd: z.number(),
    firstWave: z.array(z.object({ key: z.string(), who: z.string(), usd: z.number() })),
    defaults: z.array(z.string()),
  }),
});
export type ExpeditionProposal = z.infer<typeof ExpeditionProposal>;
export const EXPEDITION_PROPOSAL = 'expedition-small:';
export type ExpeditionRef = { id: string; commit?: string; base?: string };
export type ExpeditionResult =
  | { t: 'passed' | 'failed'; out: unknown; ref: ExpeditionRef; why?: string }
  | { t: 'errored'; why: string }
  | { t: 'cancelled'; partial: ExpeditionRef }
  | { t: 'refused'; reason: string };
export type ExpeditionStep = {
  key: string;
  hash: string;
  who: string;
  state: string;
  cost: number;
  why?: string;
  conversationId?: string;
  commit?: string;
};
export type ExpeditionQuestion = {
  key: string;
  question: string;
  kind: 'text' | 'confirm' | 'manager';
};
export type ExpeditionView = {
  id: string;
  workspaceId: string;
  status: 'running' | 'held' | 'met' | 'stopped';
  goal: string;
  budget: { usd: number; hours: number };
  spend: number;
  reserved: number;
  steps: ExpeditionStep[];
  questions: ExpeditionQuestion[];
  versions: number[];
  reason?: string;
};
