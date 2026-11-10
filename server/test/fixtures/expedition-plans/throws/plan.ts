// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
import { plan } from 'expedition';

export default plan(async () => {
  throw new Error('boom from plan code');
});
