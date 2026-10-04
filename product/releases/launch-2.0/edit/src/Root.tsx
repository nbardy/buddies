import { Composition } from 'remotion';
import * as Assembly from './Assembly';
import * as Close from './Close';
import * as DesignIteration from './DesignIteration';
import * as DesignReview from './DesignReview';
import * as FeatureFlash from './FeatureFlash';
import * as MultiHarness from './MultiHarness';
import * as NativeMultimedia from './NativeMultimedia';
import * as Overload from './Overload';

export const Root: React.FC = () => (
  <>
    <Composition
      id="Overload"
      component={Overload.Overload}
      durationInFrames={Overload.DURATION}
      fps={Overload.FPS}
      width={Overload.WIDTH}
      height={Overload.HEIGHT}
    />
    <Composition
      id="DesignIteration"
      component={DesignIteration.DesignIteration}
      durationInFrames={DesignIteration.DURATION}
      fps={DesignIteration.FPS}
      width={DesignIteration.WIDTH}
      height={DesignIteration.HEIGHT}
    />
    <Composition
      id="DesignReview"
      component={DesignReview.DesignReview}
      durationInFrames={DesignReview.DURATION}
      fps={DesignReview.FPS}
      width={DesignReview.WIDTH}
      height={DesignReview.HEIGHT}
    />
    <Composition
      id="NativeMultimedia"
      component={NativeMultimedia.NativeMultimedia}
      durationInFrames={NativeMultimedia.DURATION}
      fps={NativeMultimedia.FPS}
      width={NativeMultimedia.WIDTH}
      height={NativeMultimedia.HEIGHT}
    />
    <Composition
      id="FeatureFlash"
      component={FeatureFlash.FeatureFlash}
      durationInFrames={FeatureFlash.DURATION}
      fps={FeatureFlash.FPS}
      width={FeatureFlash.WIDTH}
      height={FeatureFlash.HEIGHT}
    />
    <Composition
      id="MultiHarness"
      component={MultiHarness.MultiHarness}
      durationInFrames={MultiHarness.DURATION}
      fps={MultiHarness.FPS}
      width={MultiHarness.WIDTH}
      height={MultiHarness.HEIGHT}
    />
    <Composition
      id="Assembly"
      component={Assembly.Assembly}
      defaultProps={{ score: 'halftime' } satisfies Assembly.AssemblyProps}
      durationInFrames={Assembly.DURATION}
      fps={Assembly.FPS}
      width={Assembly.WIDTH}
      height={Assembly.HEIGHT}
    />
    <Composition
      id="Close"
      component={Close.Close}
      durationInFrames={Close.DURATION}
      fps={Close.FPS}
      width={Close.WIDTH}
      height={Close.HEIGHT}
    />
  </>
);
