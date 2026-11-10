import assert from 'node:assert/strict';
import test from 'node:test';
import type { keyed } from '@unleashd/shared';
import {
  MIN_BAR,
  axisOf,
  boxOf,
  budgetSplit,
  canRetry,
  durationLabel,
  groupLanes,
  placeMarkers,
  toneOf,
} from '../src/components/buddies/keyed-timeline';
import { finished, rowOf, runningWithAsks } from './keyed-fixtures';

const DAY = 24 * 3_600_000;
const launch = Date.parse(runningWithAsks.launchedAt);
const now = Date.parse('2026-11-10T10:45:00Z');

// A fixture-free bar: only the fields the layout reads.
const bar = (start: number, end: number | 'open'): keyed.Bar => ({
  key: 'a/b/1',
  hash: 'h',
  kind: 'command',
  attempt: 1,
  planVersion: 0,
  start: new Date(start).toISOString(),
  end:
    end === 'open'
      ? { t: 'open' }
      : { t: 'settled', at: new Date(end).toISOString(), outcome: { t: 'errored', why: 'x' } },
});

// Regression guard: on a two-day axis a 3-second call is 0.0017% of the width. Drawn to scale it
// is invisible and cannot be clicked; the minimum width keeps it there without pushing it off the
// edge.
test('a 3-second bar and a 2-day bar share one axis; both stay visible and inside it', () => {
  const short = bar(launch + 5_000, launch + 8_000);
  const long = bar(launch, launch + 2 * DAY);
  const tail = bar(launch + 2 * DAY - 1_000, launch + 2 * DAY);
  const view = {
    ...runningWithAsks,
    status: finished.status,
    markers: [],
    lanes: [{ key: 'a/b/1', kind: 'command', status: 'settled', bars: [short, long, tail] }],
  } as never;
  const axis = axisOf(view, launch + 3 * DAY);
  for (const b of [short, long, tail]) {
    const box = boxOf(axis, b, now);
    assert.ok(box.width >= MIN_BAR, 'minimum width');
    assert.ok(box.left >= 0 && box.left + box.width <= 1 + 1e-9, 'inside the axis');
  }
  assert.ok(Math.abs(boxOf(axis, long, now).width - 1) < 1e-9, 'the 2-day bar spans the axis');
});

test('a running bar ends at now and never has a negative width, even with a clock behind its start', () => {
  const axis = axisOf(runningWithAsks, now);
  const running = bar(now - 600_000, 'open');
  const box = boxOf(axis, running, now);
  assert.ok(Math.abs(box.left + box.width - 1) < 1e-9, 'its right edge is the axis end (now)');
  const skewed = boxOf(axis, bar(now + 60_000, 'open'), now);
  assert.ok(skewed.width >= MIN_BAR, 'start in the future: still a bar');
  assert.ok(skewed.left + skewed.width <= 1 + 1e-9);
});

test('bars of one lane are ordered by their left edge', () => {
  const axis = axisOf(runningWithAsks, now);
  for (const lane of runningWithAsks.lanes) {
    const lefts = lane.bars.map((b) => boxOf(axis, b, now).left);
    assert.deepEqual(
      lefts,
      [...lefts].sort((a, b) => a - b),
      lane.key
    );
  }
});

test('a plan marker lands between the bars it separates', () => {
  const axis = axisOf(runningWithAsks, now);
  const [first, second] = runningWithAsks.lanes[1].bars;
  const v1 = placeMarkers(axis, runningWithAsks.markers).find(
    (p) => p.marker.t === 'plan' && p.marker.version === 1
  );
  assert.ok(v1);
  const before = boxOf(axis, first, now);
  assert.ok(v1.at >= before.left + before.width, 'after the attempt it replaced');
  assert.ok(v1.at <= boxOf(axis, second, now).left, 'before the attempt that began under it');
});

test('lanes group by the first key segment and keep server order inside a phase', () => {
  const lane = (key: string) => ({ key, kind: 'command', status: 'settled', bars: [] }) as never;
  const groups = groupLanes([lane('b/z/1'), lane('a/x/1'), lane('b/a/1'), lane('lone')]);
  assert.deepEqual(
    groups.map((g) => [g.phase, g.lanes.map((l) => l.key)]),
    [
      ['b', ['b/z/1', 'b/a/1']],
      ['a', ['a/x/1']],
      ['lone', ['lone']],
    ]
  );
});

test('retry is offered only on the newest bar of a lane, and only after an error or a refusal', () => {
  const [compile, agent, lint] = runningWithAsks.lanes;
  assert.equal(toneOf(lint.bars[0]), 'errored');
  assert.equal(canRetry(lint, lint.bars[0]), true);
  assert.equal(canRetry(compile, compile.bars[0]), false, 'passed');
  assert.equal(canRetry(agent, agent.bars[0]), false, 'failed and superseded');
});

test('the budget bar never leaves its track when spent plus reserved passes the budget', () => {
  const ok = budgetSplit(rowOf(runningWithAsks));
  assert.ok(Math.abs(ok.spent - 0.24) < 1e-9 && Math.abs(ok.reserved - 0.16) < 1e-9);
  assert.equal(ok.over, false);
  const over = budgetSplit({ ...rowOf(runningWithAsks), spentUsd: 4, reservedUsd: 3 });
  assert.ok(Math.abs(over.spent + over.reserved - 1) < 1e-9);
  assert.equal(over.over, true);
});

test('the axis reads in minutes and in days', () => {
  assert.equal(durationLabel(3_000), '3 s');
  assert.equal(durationLabel(130 * 60_000), '2 h 10 m');
  assert.equal(durationLabel(2 * DAY + 4 * 3_600_000), '2 d 4 h');
});
