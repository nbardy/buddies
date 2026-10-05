// Separate entry keeps this review reproducible without the unfinished Assembly draft.
import type React from 'react';
import { AbsoluteFill, Composition, registerRoot, Sequence } from 'remotion';
import * as Native from './NativeMultimedia';
import * as Overload from './Overload';
import * as Benefits from './PostIntroBenefits';
import * as Picker from './PickerRefresh';

const NATIVE_IN = Overload.DURATION + Benefits.DURATION;
const REVIEW_DURATION = NATIVE_IN + Native.DURATION;
const Review: React.FC = () => (
  <AbsoluteFill>
    <Sequence durationInFrames={Overload.DURATION}><Overload.Overload type="slam" /></Sequence>
    <Sequence from={Overload.DURATION} durationInFrames={Benefits.DURATION}><Benefits.PostIntroBenefits /></Sequence>
    <Sequence from={Overload.DURATION} layout="none"><Benefits.BenefitsSound /></Sequence>
    <Sequence from={NATIVE_IN} durationInFrames={Native.DURATION}><Native.NativeMultimedia /></Sequence>
  </AbsoluteFill>
);

registerRoot(() => (
  <>
    <Composition id="PostIntroBenefits" component={Benefits.BenefitsWithSound} durationInFrames={Benefits.DURATION} fps={60} width={1920} height={1080} />
    <Composition id="PostIntroReview" component={Review} durationInFrames={REVIEW_DURATION} fps={60} width={1920} height={1080} />
    <Composition id="PickerRefresh" component={Picker.PickerRefresh} durationInFrames={Picker.DURATION} fps={60} width={1920} height={1080} />
  </>
));
