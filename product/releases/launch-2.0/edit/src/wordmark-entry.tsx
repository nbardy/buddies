// Separate entry: the rebrand drafts render without touching Root.tsx (another cut is mid-edit there).
// pnpm exec remotion still src/wordmark-entry.tsx BuddiesWordmark out/buddies-<option>.png --props='{"option":"aurora"}'
import { Composition, registerRoot } from 'remotion';
import * as W from './BuddiesWordmark';

registerRoot(() => (
  <Composition
    id="BuddiesWordmark"
    component={W.BuddiesWordmark}
    defaultProps={{ option: 'aurora' } satisfies W.Props}
    durationInFrames={1}
    fps={60}
    width={W.WIDTH}
    height={W.HEIGHT}
  />
));
