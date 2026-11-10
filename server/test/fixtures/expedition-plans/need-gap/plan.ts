// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// One step; need() on it. Unanswered, it is also the "pending call" plan the kill test uses.
import { need, plan, role, seat, steps } from 'expedition';

const { probe } = steps({ probe: role({ by: seat('claude', 'm', 'low'), usd: 1, minutes: 5 }) });

export default plan(async () => need(await probe(), 'The probe found nothing.'));
