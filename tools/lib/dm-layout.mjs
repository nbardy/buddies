/** Runs in the browser against the real DM, including hydrated and queued rows. */
export function inspectDmLayout() {
  const timeline = document.querySelector('.channel-dm-timeline');
  if (!timeline) throw new Error('DM timeline did not load');
  const issues = [];
  let continuations = 0;
  for (const list of timeline.querySelectorAll('ol')) {
    // A settled DM may have no consecutive owner messages. Probe the same missing-gutter
    // row with its real body, then remove it before the screenshot; never write server data.
    const firstLead = list.querySelector('[class*="--lead"]');
    const probe = firstLead?.cloneNode(true);
    if (probe) {
      probe.className = probe.className.replace('--lead', '--continuation');
      probe.querySelector('.channel-browser-avatar, .mobile-channel-post__avatar')?.remove();
      probe
        .querySelector('.channel-browser-message-heading, .mobile-channel-post__heading')
        ?.remove();
      firstLead.after(probe);
    }
    let lead = null;
    try {
      for (const row of list.children) {
        const content = row.querySelector(
          '.channel-browser-message-content, .mobile-channel-post__content'
        );
        if (!content) continue;
        const rect = content.getBoundingClientRect();
        if (row.className.includes('--lead')) lead = rect;
        if (!row.className.includes('--continuation')) continue;
        continuations += 1;
        if (!lead || Math.abs(rect.left - lead.left) > 2 || Math.abs(rect.width - lead.width) > 2) {
          issues.push({
            text: content.textContent.slice(0, 80),
            left: rect.left,
            width: rect.width,
            leadLeft: lead?.left,
            leadWidth: lead?.width,
          });
        }
      }
    } finally {
      probe?.remove();
    }
  }
  if (issues.length) throw new Error(`DM continuation layout collapsed: ${JSON.stringify(issues)}`);
  return { continuations };
}
