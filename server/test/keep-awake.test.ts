import assert from 'node:assert/strict';
import test from 'node:test';
import { KeepAwake, caffeinateAssertion } from '../src/turns/keep-awake';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number) => {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
};

test(
  'two overlapping turns hold one caffeinate, released after both end',
  { skip: process.platform !== 'darwin' },
  async () => {
    // Owner decision 2026-10-07: keep the Mac awake only while a turn runs. A per-turn spawn
    // would leak one process per turn; a missed release would keep the Mac awake forever.
    const awake = new KeepAwake(caffeinateAssertion);
    assert.equal(awake.pid, null);
    awake.setRunning('a', true);
    const pid = awake.pid;
    assert.ok(pid !== null && alive(pid));
    awake.setRunning('b', true);
    assert.equal(awake.pid, pid, 'second turn reuses the one assertion');
    awake.setRunning('a', true); // duplicate publish is idempotent
    awake.setRunning('a', false);
    assert.equal(awake.pid, pid, 'still held while b runs');
    assert.ok(alive(pid));
    awake.setRunning('b', false);
    assert.equal(awake.pid, null);
    assert.ok(await gone(pid), 'caffeinate reaped after the last turn');
  }
);
