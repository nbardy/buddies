import { z } from 'zod';
import type { Readable } from '../../api/expedition';
import {
  buddy,
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

const OUT = 'agent_notes/2026-11-10_document_model';
const PRIOR = [
  'studio/',
  'product/MASTER_TASKS.md',
  'agent_notes/2026-10-09_document_model_parity/',
  'agent_notes/2026-10-11_model_comparison/',
  'agent_notes/2026-10-12_reset/',
  'agent_notes/2026-10-14_document_model_owner_decisions.md',
];

// What the plan reads from the adjudicator: is anything still blocking, what only the owner can rule on, what can be run.
const Verdict = z.object({
  blocking: z.number(),
  questions: z.array(
    z.object({ id: z.string(), question: z.string(), options: z.string(), fallback: z.string() })
  ),
  spikes: z.array(z.object({ id: z.string(), claim: z.string(), measure: z.string() })),
});
const Ratify = z.object({ ratified: z.boolean(), note: z.string() });

// Who. Design, critique and reflection sit on three providers; no seat judges work from its own provider.
const referee = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const lead = role({ by: buddy('document-model-lead'), max: usd(8), minutes: 60 }).reads(...PRIOR);
const designer = role({
  by: seat('claude', 'claude-sonnet-5-5', 'high'),
  max: usd(12),
  minutes: 90,
}).reads(...PRIOR);
const critic = role({ by: seat('codex', 'gpt-6.1-sol', 'high'), max: usd(6), minutes: 45 }).reads(
  ...PRIOR
);
const reflect = role({ by: referee, max: usd(4), minutes: 30 }).reads(...PRIOR);
const builder = role({
  by: seat('codex', 'gpt-6.1-sol', 'medium'),
  max: usd(3),
  minutes: 30,
}).needs('cpu');

const { ledger, design, attack, adjudicate, spike, revise, retire } = steps({
  ledger: lead.in(checkout(`${OUT}/`)).judged(review('ledger-complete', referee)),
  design: designer.in(checkout(`${OUT}/`)).judged(review('covers-ledger', referee)),
  attack: critic.judged(review('real-defect', referee)),
  adjudicate: reflect.returns(Verdict),
  spike: builder.in(checkout(`${OUT}/spikes/`)),
  revise: designer.in(checkout(`${OUT}/`)).judged(review('covers-ledger', referee)),
  retire: designer
    .in(checkout(`${OUT}/`, 'studio/DOCUMENT_MODEL.md'))
    .judged(review('replaces-running', referee)),
});

type Round =
  | { t: 'clean' }
  | { t: 'stuck'; at: Readable }
  | { t: 'revised'; next: Awaited<ReturnType<typeof revise>> };

export default plan(async (x) => {
  const rows = await x.phase('ledger', () => ledger());
  if (rows.t !== 'passed')
    return gap(
      'No complete requirement ledger: a design cannot be held to rows nobody wrote down.',
      rows
    );

  let current = await x.phase('design', () => design({ on: rows.value, reads: [rows.value] }));
  let open: Readable[] = []; // the last critique and adjudication: the disagreement as it stands
  let clean = false;

  for (const round of [1, 2, 3]) {
    if (current.t !== 'passed') break;
    const model = current.value;
    const step = await x.phase(`round-${round}`, async (): Promise<Round> => {
      const hit = await attack({ id: round, reads: [model, rows.value, ...open] });
      if (hit.t === 'failed') return { t: 'clean' }; // the referee found no defect that is real, specific and new
      if (hit.t !== 'passed') return { t: 'stuck', at: hit }; // no critique ran: that is not a clean round
      const verdict = await adjudicate({ id: round, reads: [model, hit.value, rows.value] });
      if (verdict.t !== 'passed') return { t: 'stuck', at: verdict };
      open = [hit.value, verdict.value];
      const { blocking, questions, spikes } = verdict.value.out;
      if (blocking === 0 && questions.length === 0) return { t: 'clean' };

      // Owner rulings hold no seat and no budget; testable claims are run while the owner thinks.
      const [answers, probes] = await Promise.all([
        Promise.all(
          questions.map(
            async (q) =>
              `Owner ruling on ${q.id}: ${await x.ask(`${q.id}. ${q.question} Options: ${q.options} Default: ${q.fallback}`)}`
          )
        ),
        wide(spikes, (s) => spike({ item: s, reads: [model] })),
      ]);
      return {
        t: 'revised',
        next: await revise({
          id: round,
          on: model,
          continues: model,
          reads: [
            hit.value,
            verdict.value,
            rows.value,
            ...answers,
            ...passed(probes).map((p) => p.value),
          ],
        }),
      };
    });
    if (step.t === 'stuck')
      return gap(
        `Round ${round} could not run its critique or its adjudication.`,
        model,
        step.at,
        ...open
      );
    if (step.t === 'clean') {
      clean = true;
      break;
    }
    current = step.next;
    await x.review(
      `Round ${round}: did a blocking defect close, or did only the wording move? This model has been redesigned eight times; stop if this is the ninth.`
    );
  }
  if (current.t !== 'passed')
    return gap('No design covering the ledger survived the rounds.', current, ...open);
  const model = current.value;

  const owner = await x.ask(
    `Do you ratify this model as the one that replaces what runs? The last round ended ${clean ? 'with no blocking defect' : 'on a revision that has not been attacked again'}.`,
    Ratify
  );
  if (!owner.ratified)
    return gap(
      `The owner did not ratify the model. Open disagreement: ${owner.note}`,
      model,
      ...open
    );

  const exit = await x.phase('retirement', () =>
    retire({
      on: model,
      continues: model,
      reads: [model, rows.value, `Owner ratification note: ${owner.note}`],
    })
  );
  if (exit.t !== 'passed')
    return gap(
      'The model is ratified, but no plan retires the running model; it would sit beside it.',
      model,
      exit
    );

  const landed = await x.land('document-model', exit.value);
  return landed.t === 'passed'
    ? landed.value
    : gap('The ratified model and its retirement plan could not be landed.', exit, landed);
});
