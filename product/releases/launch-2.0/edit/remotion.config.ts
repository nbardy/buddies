import { Config } from '@remotion/cli/config';

// Every render and still goes through render.mjs, the machine-wide queue (at most 2 at once). On
// 2026-10-04 direct `remotion render` calls bypassed it: ~6 renders ran at once (load ~240 on 10
// cores) and the full render timed out fetching a footage frame after 32 min. Guard: this throw.
const rendering = ['render', 'still', 'benchmark'].some((command) => process.argv.includes(command));
if (rendering && !process.env.REMOTION_RENDER_QUEUE) {
  throw new Error('Render through the queue: `node render.mjs render|still …` (edit/README.md).');
}

// Raw recordings stay in ../footage (never copied); staticFile() resolves there.
Config.setPublicDir('../footage');
Config.setVideoImageFormat('jpeg');
Config.setCodec('h264');
// CRF is passed per render (package.json scripts): a global CRF makes `--codec=wav` renders fail.
