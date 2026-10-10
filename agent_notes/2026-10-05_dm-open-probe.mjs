import { openSession, resolveAuthToken, sleep } from '/Users/nicholasbardy/git/unleashd/tools/lib/headless-chrome.mjs';
const base = process.argv[2];
const ws = 'project_88cdc98e-13d1-426a-9544-7e7830a2b5c6';
const dms = process.argv.slice(3);
const s = await openSession({ baseUrl: base, token: resolveAuthToken(), clockMs: Date.now() });
try {
  await s.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await s.goto(`${base}/buddies/workspaces/${ws}/channels`, 1500);
  await s.waitForNetworkIdle(500, 20000, /usage|history/);
  for (const dm of dms) {
    const r = await s.evaluate(`new Promise((resolve) => {
      const tasks = [];
      const po = new PerformanceObserver((l) => l.getEntries().forEach(e => tasks.push(Math.round(e.duration))));
      po.observe({ type: 'longtask', buffered: false });
      performance.setResourceTimingBufferSize(10000); performance.clearResourceTimings(); const t0 = performance.now();
      history.pushState({}, '', location.pathname + '?dm=${dm}');
      dispatchEvent(new PopStateEvent('popstate'));
      let firstAt = null, last = -1, stableSince = 0;
      const tick = () => {
        const tl = document.querySelector('.channel-dm-timeline');
        const n = tl ? tl.querySelectorAll('li').length : -1;
        const now = performance.now();
        if (n > 0 && firstAt === null) firstAt = now - t0;
        if (n !== last) { last = n; stableSince = now; }
        if (n > 0 && now - stableSince > 1500 || now - t0 > 30000) {
          po.disconnect(); const res = performance.getEntriesByType('resource').filter(e => e.startTime > t0).map(e => [e.name.replace(location.origin,'').slice(0,90), Math.round(e.startTime - t0), Math.round(e.duration), 'queue', Math.round(e.requestStart - e.startTime), 'server', Math.round(e.responseStart - e.requestStart), 'body', Math.round(e.responseEnd - e.responseStart), e.nextHopProtocol]);
          resolve({ firstRowsMs: Math.round(firstAt), settledMs: Math.round(stableSince - t0), rows: n,
            dom: document.querySelectorAll('*').length, longTasks: tasks, nres: res.length, lastEnd: Math.max(0,...res.map(r=>r[1]+r[2])), api: res.filter(r=>r[0].includes('/api/')), slow: res.sort((a,b)=>b[2]-a[2]).slice(0,4), navs: performance.getEntriesByType('navigation').length, ws: [...document.querySelectorAll('*')].length });
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`);
    console.log(dm, JSON.stringify(r));
    history: await s.evaluate(`history.back()`); await sleep(1500);
  }
} finally { await s.close(); }
