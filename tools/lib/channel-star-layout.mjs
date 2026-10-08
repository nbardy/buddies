/** Browser guard: a star beside the opener used to shorten the selected bar. */
export function inspectChannelStarLayout() {
  const rows = document.querySelectorAll('.channel-star-row:not([data-worker-row])');
  let checked = 0;
  for (const row of rows) {
    const opener = row.firstElementChild;
    const star = row.querySelector('.channel-star');
    if (!opener || !star) continue;
    const r = row.getBoundingClientRect();
    const o = opener.getBoundingClientRect();
    const s = star.getBoundingClientRect();
    if (Math.abs(r.width - o.width) > 1 || s.right > o.right + 1) {
      throw new Error(`Channel star clips the full-width opener: ${opener.textContent.trim()}`);
    }
    checked += 1;
  }
  return { checked };
}
