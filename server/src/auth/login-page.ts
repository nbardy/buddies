import { LOGIN_PATH } from './gate';

/**
 * The unauthenticated landing page.
 *
 * This is deliberately a standalone, server-rendered document rather than a
 * React route: it has to render before any of the app's JS is reachable, since
 * the gate blocks the bundle itself. That means it cannot consume
 * `client/src/index.css`, so the palette below repeats the app's Solarized
 * token values literally. Keep them in sync with `--theme-*` in index.css.
 */

/** Why the page is being shown. Absence of a problem is a named case. */
export type LoginNotice =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid-key' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'pairing-expired' };

export function loginNoticeFromQuery(value: string | undefined): LoginNotice {
  if (value === 'invalid-key') return { kind: 'invalid-key' };
  if (value === 'signed-out') return { kind: 'signed-out' };
  if (value === 'pairing-expired') return { kind: 'pairing-expired' };
  return { kind: 'none' };
}

function noticeMarkup(notice: LoginNotice): string {
  if (notice.kind === 'invalid-key') {
    return '<p class="notice notice-error" role="alert">Invalid access key, try again.</p>';
  }
  if (notice.kind === 'signed-out') {
    return '<p class="notice notice-info" role="status">You have been signed out.</p>';
  }
  if (notice.kind === 'pairing-expired') {
    return '<p class="notice notice-error" role="alert">That QR code was already used or has expired. Show a new one in Setup → Connect from mobile.</p>';
  }
  return '<p class="notice" role="alert" hidden></p>';
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Kept out of the template literal below so it can use backticks/`${}` freely.
const ENHANCEMENT_SCRIPT = [
  '(function () {',
  "  var form = document.getElementById('login-form');",
  "  var input = document.getElementById('token');",
  "  var notice = document.querySelector('.notice');",
  "  var submit = document.getElementById('submit');",
  "  var reveal = document.getElementById('reveal');",
  "  var paste = document.getElementById('paste');",
  '',
  '  function say(message, kind) {',
  '    notice.textContent = message;',
  "    notice.className = 'notice notice-' + kind;",
  '    notice.hidden = false;',
  '  }',
  "  function clear() { notice.hidden = true; notice.textContent = ''; }",
  '',
  "  reveal.addEventListener('click', function () {",
  "    var hidden = input.type === 'password';",
  "    input.type = hidden ? 'text' : 'password';",
  "    reveal.textContent = hidden ? 'Hide' : 'Show';",
  "    reveal.setAttribute('aria-pressed', String(hidden));",
  '    input.focus();',
  '  });',
  '',
  '  // navigator.clipboard is undefined (not merely rejecting) outside a secure',
  '  // context, so over plain http this button must not exist at all.',
  '  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.readText) {',
  '    paste.hidden = false;',
  "    paste.addEventListener('click', function () {",
  '      navigator.clipboard.readText().then(function (text) {',
  '        input.value = text.trim();',
  '        input.focus();',
  "      }).catch(function () { say('Could not read the clipboard. Paste manually.', 'info'); });",
  '    });',
  '  }',
  '',
  '  // Without JS the plain form POST still works; this only upgrades the',
  '  // failure reporting, which a form POST cannot distinguish.',
  "  form.addEventListener('submit', function (event) {",
  '    event.preventDefault();',
  '    var key = input.value.trim();',
  "    if (!key) { say('Enter your access key.', 'error'); input.focus(); return; }",
  '    clear();',
  '    submit.disabled = true;',
  "    submit.textContent = 'Checking…';",
  '    var body = new URLSearchParams();',
  "    body.set('token', key);",
  "    body.set('redirectTo', form.elements.redirectTo.value);",
  '    fetch(form.action, {',
  "      method: 'POST',",
  '      headers: {',
  "        'Content-Type': 'application/x-www-form-urlencoded',",
  "        Accept: 'application/json'",
  '      },',
  '      body: body.toString()',
  '    }).then(function (response) {',
  '      if (response.ok) {',
  '        return response.json().then(function (data) {',
  "          window.location.assign(data.redirectTo || '/');",
  '        });',
  '      }',
  '      if (response.status === 401) {',
  "        say('Invalid access key, try again.', 'error');",
  '        input.select();',
  '        return;',
  '      }',
  "      say('Sign-in failed (server error ' + response.status + ').', 'error');",
  '    }).catch(function () {',
  "      say('Cannot reach the server. Check that Buddies is running and that you are on the right network.', 'error');",
  '    }).finally(function () {',
  '      submit.disabled = false;',
  "      submit.textContent = 'Unlock';",
  '    });',
  '  });',
  '})();',
].join('\n');

export function loginPageHtml(options: {
  notice: LoginNotice;
  redirectTo: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#002b36">
<title>Buddies — sign in</title>
<style>
  :root {
    --bg: #002b36;
    --surface: #073642;
    --text: #93a1a1;
    --subtle: #657b83;
    --primary: #6c71c4;
    --danger: #dc322f;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100svh;
    display: grid;
    place-items: center;
    padding: 24px max(16px, env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom))
             max(16px, env(safe-area-inset-left));
    background: var(--bg);
    color: var(--text);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  main { width: min(380px, 100%); }
  h1 { font-size: 1.5rem; margin: 0 0 6px; color: #eee8d5; letter-spacing: -0.01em; }
  .lede { margin: 0 0 20px; color: var(--subtle); font-size: 0.95rem; }
  form { display: grid; gap: 12px; }
  .field { display: flex; gap: 8px; }
  /* 16px minimum: anything smaller makes iOS Safari zoom on focus. */
  input[type="password"], input[type="text"] {
    flex: 1; min-width: 0; font-size: 16px; padding: 12px 14px; border-radius: 10px;
    background: var(--surface); color: var(--text);
    border: 1px solid color-mix(in srgb, var(--text) 18%, transparent);
  }
  input:focus-visible {
    outline: none; border-color: var(--primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 35%, transparent);
  }
  button { font-size: 16px; border-radius: 10px; cursor: pointer; border: 1px solid transparent; }
  #submit {
    padding: 12px 14px; background: var(--primary); color: #fdf6e3;
    font-weight: 600; width: 100%;
  }
  #submit:disabled { opacity: 0.6; cursor: default; }
  .ghost {
    padding: 12px; background: transparent; color: var(--subtle);
    border-color: color-mix(in srgb, var(--text) 18%, transparent); white-space: nowrap;
  }
  .notice { margin: 0 0 4px; padding: 10px 12px; border-radius: 8px; font-size: 0.92rem; }
  .notice-error {
    color: #fdf6e3; background: color-mix(in srgb, var(--danger) 22%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--danger) 55%, transparent);
  }
  .notice-info {
    color: var(--text); background: var(--surface);
    border: 1px solid color-mix(in srgb, var(--text) 18%, transparent);
  }
  .hint { margin: 16px 0 0; font-size: 0.85rem; color: var(--subtle); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
</style>
</head>
<body>
<main>
  <h1>Buddies</h1>
  <p class="lede">This server is private. Enter your access key to continue.</p>
  ${noticeMarkup(options.notice)}
  <form id="login-form" method="post" action="${LOGIN_PATH}">
    <input type="hidden" name="redirectTo" value="${escapeAttribute(options.redirectTo)}">
    <div class="field">
      <input id="token" type="password" name="token" placeholder="Access key"
             autocomplete="current-password" enterkeyhint="go" autocapitalize="off"
             autocorrect="off" spellcheck="false" autofocus required aria-label="Access key">
      <button id="reveal" type="button" class="ghost" aria-pressed="false">Show</button>
      <button id="paste" type="button" class="ghost" hidden>Paste</button>
    </div>
    <button id="submit" type="submit">Unlock</button>
  </form>
  <p class="hint">Easiest: on the computer running Buddies, open Setup → Connect from mobile
    and scan the QR code. The key itself is in <code>~/.agent-viewer/auth-token</code>.</p>
</main>
<script>${ENHANCEMENT_SCRIPT}</script>
</body>
</html>`;
}
