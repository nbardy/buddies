import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { awaitingApproval, finished, rowOf, runningWithAsks } from './keyed-fixtures';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { KeyedExpeditionView } = await import('../src/components/buddies/KeyedExpeditionView');
const { RailExpeditions, DESKTOP_ROW } = await import('../src/components/buddies/ExpeditionRail');
const { KEYED_URL, keyedUrl } = await import('../src/components/buddies/keyed-api');
const { EXPEDITIONS_URL } = await import('../src/components/buddies/expedition-api');
const { loadResource } = await import('../src/atoms/resources');
const { jotaiStore } = await import('../src/atoms/store');
const { Provider } = await import('jotai');
const { MemoryRouter } = await import('react-router-dom');

const view = (id: string, frame: 'desktop' | 'mobile' = 'desktop') =>
  renderToStaticMarkup(
    <Provider store={jotaiStore}>
      <MemoryRouter initialEntries={[`/?keyed=${id}`]}>
        <KeyedExpeditionView id={id} workspaceId="ws-1" frame={frame} />
      </MemoryRouter>
    </Provider>
  );
const rail = () =>
  renderToStaticMarkup(
    <Provider store={jotaiStore}>
      <MemoryRouter>
        <RailExpeditions workspaceId="ws-1" classes={DESKTOP_ROW} />
      </MemoryRouter>
    </Provider>
  );
const prime = (x: { id: string }) => loadResource({ key: keyedUrl(x.id), load: async () => x });

// The view renders from the same parsed wire values the server will send, in both shells.
test('a running expedition shows its asks, bars by outcome, plan markers and the controls', async () => {
  await prime(runningWithAsks);
  for (const frame of ['desktop', 'mobile'] as const) {
    const html = view(runningWithAsks.id, frame);
    // The goal's first line only; the state; the plan version.
    assert.match(html, /Find ten design partners/);
    assert.doesNotMatch(html, /then write them up/);
    assert.match(html, />Needs you</);
    assert.match(html, />Plan v1</);
    // The text ask has its question and an answer box; the confirm ask has Yes and No.
    assert.match(html, /Which segment first\?/);
    assert.match(html, /<textarea[^>]*aria-label="Answer: Which segment first\?"/);
    assert.match(html, />Send answer</);
    assert.match(html, /Send the cold emails\?/);
    assert.match(html, />Yes<.*>No</s);
    // A failed attempt, an errored call and a call waiting on the owner are marked as such.
    assert.match(html, /aria-label="build\/agent\/1, attempt 1: Failed"[^>]*/);
    assert.match(html, /data-tone="failed"/);
    assert.match(html, /aria-label="build\/agent\/1, attempt 2: Running"/);
    assert.match(html, /aria-label="gtm\/lint\/1, attempt 1: Errored"/);
    assert.match(html, /aria-label="gtm\/ask\/owner, attempt 1: Waiting on you"/);
    // Bars begun under plan v0 are marked as replaced; the one under v1 is not.
    assert.match(
      html,
      /aria-label="build\/agent\/1, attempt 1: Failed"[^>]*data-stale|data-stale[^>]*aria-label="build\/agent\/1, attempt 1: Failed"/
    );
    assert.doesNotMatch(
      html,
      /data-stale[^>]*aria-label="build\/agent\/1, attempt 2|aria-label="build\/agent\/1, attempt 2[^>]*data-stale/
    );
    // Both plan versions and the review have a marker.
    assert.match(html, /aria-label="Plan v0"/);
    assert.match(html, /aria-label="Plan v1"/);
    assert.match(html, /aria-label="Review: rewrite"/);
    // A running expedition can be paused, extended or stopped, not resumed.
    assert.match(html, />Pause</);
    assert.match(html, /Extend deadline/);
    assert.match(html, />Stop</);
    assert.doesNotMatch(html, />Resume</);
    // Faults are folded and counted.
    assert.match(html, /<details><summary[^>]*>Faults \(1\)/);
  }
});

test("a pending approval shows the diff counts and the leader's reason, with Approve and Decline", async () => {
  await prime(awaitingApproval);
  const html = view(awaitingApproval.id);
  assert.match(html, /drop the lint step/);
  assert.match(html, /2 started · 1 reused · 0 attached · 0 dropped · \+\$0\.40/);
  assert.match(html, /costs \$0\.40 more than reserved/);
  assert.match(html, />Approve<.*>Decline</s);
  assert.match(html, />Needs you</);
});

test('a finished expedition offers no act and asks nothing', async () => {
  await prime(finished);
  const html = view(finished.id);
  assert.match(html, />Goal met</);
  assert.doesNotMatch(html, />Pause<|>Resume<|>Stop<|Extend deadline|Send answer|>Approve</);
  assert.match(html, /aria-label="Goal met"/);
});

// A backend that is not reloaded yet answers 404; one with the feature off answers 503. Neither
// is a fault to show as an error: the pane says the feature is unavailable.
test('a 404 or 503 reads as unavailable, not as a crash', async () => {
  for (const code of [404, 503]) {
    const id = `gone-${code}`;
    await loadResource({
      key: keyedUrl(id),
      load: async () => Promise.reject(new Error(`HTTP ${code}`)),
    }).catch(() => undefined);
    assert.match(view(id), /not available on this backend/);
  }
});

test('the rail shows nothing extra when the list route is missing', async () => {
  await loadResource({ key: EXPEDITIONS_URL, load: async () => [] });
  await loadResource({ key: `${EXPEDITIONS_URL}/retired`, load: async () => [] });
  await loadResource({
    key: KEYED_URL,
    load: async () => Promise.reject(new Error('HTTP 503')),
  }).catch(() => undefined);
  assert.equal(rail(), '');
});

test('the rail marks "needs you" only for an expedition with an ask or an approval pending', async () => {
  await loadResource({ key: EXPEDITIONS_URL, load: async () => [] });
  await loadResource({ key: `${EXPEDITIONS_URL}/retired`, load: async () => [] });
  const quiet = { ...runningWithAsks, id: 'ex-quiet', goal: 'Quiet one', asks: [] };
  await prime(quiet);
  await prime(awaitingApproval);
  await loadResource({
    key: KEYED_URL,
    load: async () => [rowOf(quiet), rowOf(awaitingApproval)],
  });
  const [, quietRow, approvalRow] = rail().split('<li>');
  assert.match(quietRow, /Quiet one/);
  assert.doesNotMatch(quietRow, /needs you/);
  assert.match(quietRow, />Running</);
  assert.match(approvalRow, /Approve the rewrite/);
  assert.match(approvalRow, />needs you</);
});
