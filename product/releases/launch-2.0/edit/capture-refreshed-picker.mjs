// Real app capture through the repo's CDP driver. Draft selections only; never send.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openSession, resolveAuthToken, sleep } from '../../../../tools/lib/headless-chrome.mjs';

const out = path.resolve(process.argv[2] || 'out/picker-refresh');
fs.mkdirSync(out, { recursive: true });
const session = await openSession({ baseUrl: 'http://localhost:7489', token: resolveAuthToken() });
const evaluate = (fn) => session.evaluate(`(${fn.toString()})()`);
const states = [];
const snap = async (name) => {
  await sleep(250);
  const detail = await evaluate(() => {
    const box = document.querySelector('.channel-composer-model')?.getBoundingClientRect();
    return {
      dialog: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
      text: document.querySelector('.channel-composer-model')?.textContent || '',
      chip: document.querySelector('.channel-composer-mention')?.textContent || '',
      viewport: { width: innerWidth, mobile: matchMedia('(max-width: 768px)').matches },
    };
  });
  await session.capture(path.join(out, `${name}.png`));
  states.push({ name, ...detail });
};
try {
  await session.setViewport({ width: 1487, height: 941, deviceScaleFactor: 2, mobile: false });
  await session.goto('http://localhost:7489/', 1200);
  // Stay in the same document so the capture guard survives route changes.
  await evaluate(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      const method = (
        init?.method || (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method))
        return Promise.reject(new Error('Capture: write blocked'));
      return original(input, init);
    };
    WebSocket.prototype.send = () => {};
    history.pushState(
      {},
      '',
      '/buddies/workspaces/project_26fce156-5c5d-4dd9-a9d6-4b527a50af3c/channels?channel=list_032cedcb-55a1-44b2-a625-5ff70fb4e616'
    );
    dispatchEvent(new PopStateEvent('popstate'));
  });
  for (let i = 0; i < 100; i++) {
    if (await evaluate(() => !!document.querySelector('.channel-composer textarea'))) break;
    if (i === 99) throw new Error('Channel composer did not load');
    await sleep(150);
  }
  await evaluate(() => {
    const input = document.querySelector('.channel-composer textarea');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
      input,
      '@Marketing'
    );
    input.setSelectionRange(10, 10);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(1500);
  await snap('00-mention');
  await evaluate(() => {
    const buttons = [...document.querySelectorAll('.channel-composer-picker button')];
    const buddy = buttons.find(
      (b) =>
        b.textContent.includes('Marketing Designer') &&
        !b.querySelector('.channel-composer-picker-task')
    );
    if (!buddy)
      throw new Error(
        'Marketing Designer not found in real mention menu: ' +
          document.querySelector('.channel-composer')?.textContent
      );
    buddy.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  for (let i = 0; i < 40; i++) {
    if (await evaluate(() => !!document.querySelector('.channel-composer-mention'))) break;
    if (i === 39) throw new Error('Mention chip did not appear');
    await sleep(100);
  }
  await snap('01-composer');
  await evaluate(() => document.querySelector('.channel-composer-mention').click());
  await sleep(400);
  await snap('02-picker');
  for (const provider of ['claude', 'codex', 'cursor', 'muse']) {
    await session.evaluate(`(() => {
      const input = document.querySelector('.channel-composer-model input[value="${provider}"]');
      if (!input) throw new Error('Missing provider ${provider}');
      input.click();
    })()`);
    if (provider === 'codex') {
      await sleep(200);
      await evaluate(() =>
        document.querySelector('.channel-composer-model input[value="gpt-6-astra"]').click()
      );
    }
    await snap(`03-${provider}`);
  }
  await evaluate(() => {
    const range = document.querySelector('.channel-composer-model input[type="range"]');
    if (!range) throw new Error('Expected refreshed thinking slider');
    const value = String(Math.round((Number(range.min) + Number(range.max)) / 2));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(range, value);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await snap('04-thinking');
  await evaluate(() => document.querySelector('.channel-composer-model-done').click());
  await snap('05-done');
} finally {
  fs.writeFileSync(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirtyPicker: execFileSync(
          'git',
          [
            'status',
            '--short',
            '--',
            'client/src/components/ConversationConfigPicker.tsx',
            'client/src/components/ConversationConfigPicker.css',
          ],
          { encoding: 'utf8' }
        ).trim(),
        viewport: { width: 1487, height: 941, scale: 2 },
        states,
      },
      null,
      2
    )
  );
  await session.close();
}
console.log(JSON.stringify(states));
