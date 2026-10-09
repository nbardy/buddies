/** Real-browser guard for the shared channel/Buddy row background and right-side actions. */
export function inspectChannelStarLayout() {
  const rows = document.querySelectorAll('.highlight-row');
  let checked = 0;
  for (const row of rows) {
    const opener = row.firstElementChild;
    const actions = row.querySelector('.highlight-row-actions');
    const star = actions?.querySelector('.channel-star');
    if (!opener || !star) continue;
    const r = row.getBoundingClientRect();
    const worker = actions.querySelector('.buddy-background-link');
    const last = worker ?? star;
    if (Math.abs(r.right - last.getBoundingClientRect().right) > 1 || actions.lastElementChild !== last) {
      throw new Error('Worker status (or channel star) must be the last action at the far right');
    }
    if (worker && star.getBoundingClientRect().right > worker.getBoundingClientRect().left + 1) {
      throw new Error('Buddy star must precede the worker status');
    }
    const current = row.getAttribute('data-current');
    try {
      row.setAttribute('data-current', 'true');
      if (getComputedStyle(row).backgroundColor === 'rgba(0, 0, 0, 0)') {
        throw new Error('Selected highlight must cover the entire row, including actions');
      }
    } finally {
      if (current === null) row.removeAttribute('data-current');
      else row.setAttribute('data-current', current);
    }
    const count = actions.querySelector('.buddy-background-link span');
    if (count) {
      const original = count.textContent;
      const width = opener.getBoundingClientRect().width;
      try {
        for (const value of ['0', '1', '10', '999']) {
          count.textContent = value;
          if (
            Math.abs(opener.getBoundingClientRect().width - width) > 1 ||
            Math.abs(last.getBoundingClientRect().right - r.right) > 1
          ) {
            throw new Error('Worker count moved the rightmost action or shortened the Buddy opener');
          }
        }
      } finally {
        count.textContent = original;
      }
    }
    const next = row.nextElementSibling;
    const nextStar = next?.querySelector('.channel-star');
    if (next?.classList.contains('highlight-row') && nextStar) {
      const original = star.getAttribute('aria-pressed');
      const nextOriginal = nextStar.getAttribute('aria-pressed');
      try {
        star.setAttribute('aria-pressed', 'true');
        nextStar.setAttribute('aria-pressed', 'false');
        if (Math.abs(parseFloat(getComputedStyle(next).marginBlockStart) - 8) > 0.1) {
          throw new Error('Starred and unstarred rows need an 8px gap');
        }
        nextStar.setAttribute('aria-pressed', 'true');
        if (parseFloat(getComputedStyle(next).marginBlockStart) !== 0) {
          throw new Error('Rows within the starred group must stay compact');
        }
      } finally {
        star.setAttribute('aria-pressed', original);
        nextStar.setAttribute('aria-pressed', nextOriginal);
      }
    }
    checked += 1;
  }
  return { checked };
}
