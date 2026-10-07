import Electrobun, { ApplicationMenu } from 'electrobun/main';
import { readSourceStatus, sourceStatusView } from '../../../tools/desktop-source-status.mjs';

/** Native status stays available even when the bundled server has no checkout yet. */
export function installSourceUpdatesMenu(input: {
  home: string;
  runtime: string;
  bundleRevision: string;
  startSetup(): void;
}) {
  let shown = '';
  let dialogOpen = false;
  let finished = false;

  async function showStatus() {
    if (dialogOpen) return;
    dialogOpen = true;
    try {
      const view = sourceStatusView(
        readSourceStatus(input.home),
        input.runtime,
        input.bundleRevision
      );
      const { response } = await Electrobun.Utils.showMessageBox({
        title: 'Buddies source updates',
        message: view.message,
        buttons: view.buttons,
        defaultId: view.action ? 1 : 0,
        cancelId: view.action ? 1 : 0,
      });
      const button = view.buttons[response];
      if (button === 'View setup logs') Electrobun.Utils.openPath(input.home);
      else if (response === 0 && view.action === 'retry') input.startSetup();
      else if (response === 0 && view.action === 'quit') Electrobun.Utils.quit();
    } finally {
      dialogOpen = false;
    }
  }

  function refresh() {
    const state = readSourceStatus(input.home);
    const view = sourceStatusView(state, input.runtime, input.bundleRevision);
    const signature = JSON.stringify(state);
    if (signature === shown) return;
    shown = signature;
    if (state.kind === 'preparing') finished = false;
    ApplicationMenu.setApplicationMenu([
      {
        label: 'Buddies',
        submenu: [
          { role: 'about' },
          { label: view.label, action: 'source-updates' },
          { type: 'divider' },
          { role: 'hide', accelerator: 'Command+h' },
          { role: 'quit', accelerator: 'Command+q' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo', accelerator: 'Command+z' },
          { role: 'redo', accelerator: 'Command+Shift+z' },
          { type: 'divider' },
          { role: 'cut', accelerator: 'Command+x' },
          { role: 'copy', accelerator: 'Command+c' },
          { role: 'paste', accelerator: 'Command+v' },
          { role: 'selectAll', accelerator: 'Command+a' },
        ],
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]);
    // Surface completion/failure once per app launch; reopening on an activated build
    // leaves the menu available without another modal.
    if (
      !finished &&
      (state.kind === 'failed' || (state.kind === 'ready' && view.action === 'quit'))
    ) {
      finished = true;
      void showStatus();
    }
  }
  ApplicationMenu.on('application-menu-clicked', (event) => {
    if ((event as { data?: { action?: string } }).data?.action === 'source-updates')
      void showStatus();
  });
  refresh();
  const timer = setInterval(refresh, 1000);
  Electrobun.events.on('before-quit', () => clearInterval(timer));
}
