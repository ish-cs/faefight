import { describe, expect, it } from 'vitest';
import { isChromium, isMobileDevice } from '../../src/client/device';
import { defaultSettings, sanitizeSettings } from '../../src/client/settings/store';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
};

describe('computer-only gate', () => {
  it('phones and tablets are mobile', () => {
    expect(isMobileDevice({ coarse: true, anyFine: false, width: 390, ua: UA.iphone })).toBe(true);
    expect(isMobileDevice({ coarse: true, anyFine: false, width: 412, ua: UA.android })).toBe(true);
    // iPad reports a Mac UA; its touch-only pointer gives it away.
    expect(isMobileDevice({ coarse: true, anyFine: false, width: 1024, ua: UA.ipad })).toBe(true);
    // Narrow + mobile UA even if the pointer media query is unreliable.
    expect(isMobileDevice({ coarse: false, anyFine: true, width: 390, ua: UA.android })).toBe(true);
  });

  it('computers are not, including touch laptops and narrow desktop windows', () => {
    expect(isMobileDevice({ coarse: false, anyFine: true, width: 1440, ua: UA.chromeMac })).toBe(false);
    expect(isMobileDevice({ coarse: true, anyFine: true, width: 1366, ua: UA.edge })).toBe(false); // touchscreen laptop with a trackpad
    expect(isMobileDevice({ coarse: false, anyFine: true, width: 600, ua: UA.chromeMac })).toBe(false);
  });
});

describe('Chrome note', () => {
  it('Chromium browsers pass, others get the note', () => {
    expect(isChromium(UA.chromeMac)).toBe(true);
    expect(isChromium(UA.edge)).toBe(true);
    expect(isChromium(UA.firefox)).toBe(false);
    expect(isChromium(UA.ipad)).toBe(false); // Safari
    expect(isChromium(UA.chromeIos)).toBe(false); // WebKit underneath
  });
});

describe('How to play is remembered in settings', () => {
  it('unseen by default; the seen flag survives sanitizing', () => {
    expect(defaultSettings().onboarding.howToSeen).toBe(false);
    expect(sanitizeSettings({ onboarding: { howToSeen: true } }).onboarding.howToSeen).toBe(true);
    expect(sanitizeSettings({ onboarding: { howToSeen: 'yes' } }).onboarding.howToSeen).toBe(false);
  });
});
