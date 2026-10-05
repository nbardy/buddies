// Tab-bar proof: one shell page, one <electrobun-webview> per tab, each a full
// Buddies client on its own route. Switching tabs only toggles visibility, so a
// background tab keeps its page (and WebSocket) instead of reloading.
import type { WebviewTagElement } from 'electrobun/view';

const params = new URLSearchParams(location.search);
const origin = params.get('origin') ?? '';
const token = params.get('token') ?? '';
const tabs = [
  { label: 'Chats', path: '/chats' },
  { label: 'Buddies', path: '/buddies' },
];

const bar = document.getElementById('bar') as HTMLElement;
const views = document.getElementById('views') as HTMLElement;
const webviews = tabs.map((tab) => {
  const webview = document.createElement('electrobun-webview') as WebviewTagElement;
  webview.setAttribute('renderer', 'cef');
  webview.setAttribute('src', `${origin}${tab.path}?token=${token}`);
  views.appendChild(webview);
  return webview;
});
const buttons = tabs.map((tab, index) => {
  const button = document.createElement('button');
  button.textContent = tab.label;
  button.onclick = () => select(index);
  bar.appendChild(button);
  return button;
});

function select(active: number) {
  webviews.forEach((webview, index) => webview.toggleHidden(index !== active));
  buttons.forEach((button, index) =>
    button.setAttribute('aria-selected', String(index === active))
  );
}

// Both tabs load (and open their sockets) before the second one goes to the background.
setTimeout(() => select(0), 3000);
