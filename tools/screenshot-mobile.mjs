#!/usr/bin/env node
/**
 * screenshot-mobile.mjs — capture every mobile screen at a phone viewport.
 *
 * Drives headless Chrome through tools/lib/headless-chrome.mjs (zero
 * dependencies, no puppeteer). For the Channels screens at phone, tablet and
 * desktop sizes, use `pnpm screenshots` (tools/screenshots.mjs).
 *
 * Usage:
 *   node tools/screenshot-mobile.mjs                     # against http://localhost:7489
 *   node tools/screenshot-mobile.mjs --url http://...    # another origin
 *   node tools/screenshot-mobile.mjs --out /tmp/shots    # another output dir
 *   node tools/screenshot-mobile.mjs --only chats,buddies
 *
 * The dev server must already be running (pnpm dev). Screens that need a real
 * conversation or buddy resolve an id from the live app at runtime, so the set
 * degrades gracefully on an empty install rather than failing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession, resolveAuthToken, sleep } from './lib/headless-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 375x812 = iPhone X..13 mini CSS pixels, the viewport the mobile tree targets
// (useDeviceKind switches at max-width: 768px).
const VIEWPORT = { width: 375, height: 812, deviceScaleFactor: 2, mobile: true };

function parseArgs(argv) {
  const args = {
    url: 'http://localhost:7489',
    out: path.join(ROOT, 'docs/screenshots/mobile'),
    only: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') args.url = argv[++i];
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--only') args.only = new Set(argv[++i].split(',').map((s) => s.trim()));
  }
  return args;
}

/**
 * The screens. `prepare` runs in the page after navigation and may return a
 * value; returning the string 'SKIP' drops the screen (e.g. no conversations
 * exist yet). `path` may be a function resolved against earlier discoveries.
 */
function buildScreens(ids) {
  return [
    { name: '01-chats', path: '/' },
    { name: '03-buddies', path: '/buddies' },
    { name: '04-search', path: '/search' },
    {
      name: '05-new-chat-sheet',
      path: '/',
      prepare: `document.querySelector('.mobile-ui-header-action')?.click()`,
      settleMs: 700,
    },
    ids.conversationId
      ? { name: '07-conversation', path: `/chat/${ids.conversationId}`, settleMs: 1800 }
      : null,
    ids.conversationId
      ? {
          name: '08-conversation-composer-filled',
          path: `/chat/${ids.conversationId}`,
          settleMs: 1800,
          prepare: `(() => {
            const ta = document.querySelector('.mobile-composer__input');
            if (!ta) return 'SKIP';
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, 'Drafting a message from the screenshot script.');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.focus();
          })()`,
        }
      : null,
    ids.conversationId
      ? {
          name: '09-model-modal',
          path: `/chat/${ids.conversationId}`,
          settleMs: 1800,
          prepare: `(() => {
            const btn = document.querySelector('.mobile-chat__model');
            if (!btn) return 'SKIP';
            btn.click();
          })()`,
        }
      : null,
    // Buddy sections are routes (/buddies/:id/:tab), so each shot names its tab.
    ...(ids.buddyId
      ? [
          ['10-buddy-detail-work', 'work'],
          ['11-buddy-detail-chats', 'conversations'],
          ['12-buddy-detail-memory', 'memory'],
          ['12b-buddy-detail-messages', 'mailbox'],
          ['12c-buddy-detail-schedules', 'schedules'],
        ].map(([name, tab]) => ({
          name,
          path: `/buddies/${ids.buddyId}/${tab}`,
          settleMs: 2000,
        }))
      : []),
  ].filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });

  const session = await openSession({
    baseUrl: args.url,
    token: resolveAuthToken(),
    clockMs: Date.now(),
  });
  const { goto, evaluate } = session;
  const saved = [];
  const skipped = [];
  try {
    await session.setViewport(VIEWPORT);

    // Discover real ids from the running app so conversation/buddy
    // screens point at something that exists.
    await goto(`${args.url}/`, 2500);
    const ids = await evaluate(`(() => {
      const firstConv = document.querySelector('.mobile-conversation-item');
      const fiberId = (el) => {
        if (!el) return null;
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
        let fiber = el[key];
        for (let i = 0; i < 12 && fiber; i++) {
          if (fiber.memoizedProps?.id) return fiber.memoizedProps.id;
          fiber = fiber.return;
        }
        return null;
      };
      return { conversationId: fiberId(firstConv) };
    })()`);

    // Click the first card and read the resulting URL. More robust than
    // reading ids out of React internals, and it exercises the real nav path.
    const idFromFirstCard = async (listPath, cardSelector, pattern) => {
      await goto(`${args.url}${listPath}`, 2500);
      const clicked = await evaluate(
        `(() => { const el = document.querySelector('${cardSelector}'); if (!el) return false; el.click(); return true; })()`
      );
      if (!clicked) return null;
      await sleep(1600);
      const url = await evaluate('location.pathname + location.search');
      const match = pattern.exec(url ?? '');
      return match ? decodeURIComponent(match[1]) : null;
    };

    ids.buddyId = await idFromFirstCard('/buddies', '.mobile-buddy-card', /^\/buddies\/([^?]+)/);

    const screens = buildScreens(ids).filter(
      (s) => !args.only || args.only.has(s.name.replace(/^\d+-/, ''))
    );

    for (const screen of screens) {
      await goto(`${args.url}${screen.path}`, screen.settleMs ?? 1500);
      if (screen.prepare) {
        const outcome = await evaluate(screen.prepare);
        if (outcome === 'SKIP') {
          skipped.push(`${screen.name} (precondition absent)`);
          continue;
        }
        await sleep(900);
      }
      const file = path.join(args.out, `${screen.name}.png`);
      await session.capture(file);
      saved.push(file);
      process.stdout.write(`saved ${file}\n`);
    }
  } finally {
    await session.close();
  }

  process.stdout.write(`\n${saved.length} screenshot(s) in ${args.out}\n`);
  if (skipped.length) process.stdout.write(`skipped: ${skipped.join(', ')}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
