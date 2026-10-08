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
    const s = star.getBoundingClientRect();
    if (Math.abs(r.right - s.right) > 1 || actions.lastElementChild !== star) {
      throw new Error('Row star must be the last action at the far right');
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
            Math.abs(star.getBoundingClientRect().right - r.right) > 1
          ) {
            throw new Error('Worker count moved the star or shortened the Buddy opener');
          }
        }
      } finally {
        count.textContent = original;
      }
    }
    checked += 1;
  }
  return { checked };
}
