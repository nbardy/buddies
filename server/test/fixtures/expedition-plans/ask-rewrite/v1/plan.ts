import { need, plan, role, seat, steps } from 'expedition';
// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Version 1: a different step; version 0's probe and question are no longer asked.

const worker = role({ by: seat('claude', 'claude-sonnet-5-5', 'medium'), usd: 1, minutes: 10 });
const { scan } = steps({ scan: worker });

export default plan(async () => need(await scan(), 'The scan found nothing.'));
