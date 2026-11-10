import { z } from 'zod';
import {
  buddy,
  check,
  checkout,
  gap,
  passed,
  plan,
  review,
  role,
  seat,
  steps,
  usd,
  wide,
} from '../../api/expedition';

const Entity = z.object({ id: z.string(), name: z.string() });
const FEATURES = ['server/src/features/', 'client/src/features/'];

const judge = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const lead = role({ by: buddy('product-dev'), max: usd(6), minutes: 60 });
const builder = role({
  by: seat('claude', 'claude-sonnet-5-5', 'medium'),
  max: usd(3),
  minutes: 40,
});

const { foundation, slice, integrate, walkthrough } = steps({
  foundation: lead
    .in(checkout('db/', 'shared/', 'server/src/', 'client/src/', 'test/', 'docs/CONVENTIONS.md'))
    .lists(Entity)
    .judged(check('pnpm typecheck && pnpm test', 'tools/')),
  slice: builder
    .in(checkout(...FEATURES))
    .judged(check('pnpm typecheck && pnpm accept {{id}}', 'tools/')),
  integrate: lead
    .in(checkout(...FEATURES))
    .judged(check('pnpm typecheck && pnpm accept --all && pnpm build', 'tools/')),
  walkthrough: builder.in(checkout('docs/walkthrough/')).judged(review('walkthrough-real', judge)),
});

// A fixed pipeline. There is no review point: nothing here should surprise the plan. If a step
// fails, the plan returns a gap and the host wakes the leader, which is the only time it is needed.
export default plan(async (x) => {
  const base = await x.phase('foundation', () => foundation());
  if (base.t !== 'passed' || base.value.out.length === 0)
    return gap('No foundation: the schema, auth or acceptance tests did not pass.', base);
  if ((await x.land('foundation', base.value)).t !== 'passed')
    return gap('The foundation failed its re-check on main.', base);

  // Each builder may write only its own feature's two folders.
  const build = (e: z.infer<typeof Entity>) =>
    slice({ id: e.id, item: e, fence: FEATURES.map((dir) => `${dir}${e.id}/`) });

  // The first feature is built alone and landed, so the others start from a tree that already
  // holds one worked example to copy instead of inventing four conventions.
  const [first, ...rest] = base.value.out;
  const exemplar = await x.phase('exemplar', () => build(first));
  if (exemplar.t !== 'passed')
    return gap('The first feature failed, so the others were not started.', exemplar);
  if ((await x.land(first.id, exemplar.value)).t !== 'passed')
    return gap('The first feature failed its re-check on main.', exemplar);

  const built = await x.phase('slices', () => wide(rest, build));
  const slices = passed(built).map((s) => s.value);
  if (slices.length < rest.length)
    return gap('Not every feature passed its acceptance tests.', ...built.map((b) => b.result));

  const whole = await x.phase('integrate', () => integrate({ reads: slices }));
  if (whole.t !== 'passed') return gap('The features pass alone but not together.', whole);

  const shown = await x.phase('walkthrough', () => walkthrough({ on: whole.value }));
  if (shown.t !== 'passed')
    return gap('The walkthrough does not show what it claims.', whole, shown);

  if ((await x.land('app', shown.value)).t !== 'passed')
    return gap('The app failed its re-check on main.', shown);
  return shown.value; // the owner's acceptance of the walkthrough is the contract's last criterion
});
