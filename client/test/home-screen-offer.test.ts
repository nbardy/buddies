import assert from 'node:assert/strict';
import test from 'node:test';
import { homeScreenOffer } from '../src/views/home-screen-guide/home-screen-offer';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
// iPadOS Safari defaults to "Request Desktop Website": a Mac user agent.
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const PIXEL =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

test('an installed launch is never offered the guide, however it reports standalone', () => {
  // iOS Home Screen launches set navigator.standalone; older iOS never matches
  // the display-mode query, so either signal alone must count as installed.
  const base = { userAgent: IPHONE, maxTouchPoints: 5, displayModeStandalone: false };
  assert.deepEqual(homeScreenOffer({ ...base, standalone: true }), { kind: 'installed' });
  assert.deepEqual(homeScreenOffer({ ...base, userAgent: PIXEL, displayModeStandalone: true }), {
    kind: 'installed',
  });
});

test('steps follow the device, including an iPad that sends a Mac user agent', () => {
  const offer = (userAgent: string, maxTouchPoints: number) =>
    homeScreenOffer({ userAgent, maxTouchPoints, standalone: false, displayModeStandalone: false });
  assert.deepEqual(offer(IPHONE, 5), { kind: 'browser', platform: 'ios' });
  assert.deepEqual(offer(IPAD_DESKTOP_UA, 5), { kind: 'browser', platform: 'ios' });
  assert.deepEqual(offer(IPAD_DESKTOP_UA, 0), { kind: 'browser', platform: 'other' });
  assert.deepEqual(offer(PIXEL, 5), { kind: 'browser', platform: 'android' });
});
