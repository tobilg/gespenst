import { describe, expect, it } from 'vitest';
import { demoTerminalRuntime, isAppleMobileBrowser } from '../../src/demo-runtime';

describe('documentation terminal runtime selection', () => {
  it('uses the main-thread accelerated renderer ladder on an iPhone', () => {
    const iphone = {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
      platform: 'iPhone',
      maxTouchPoints: 5,
    };
    expect(isAppleMobileBrowser(iphone)).toBe(true);
    expect(demoTerminalRuntime(iphone)).toEqual({ worker: false, renderer: 'auto' });
  });

  it('detects an iPad requesting a desktop-class user agent', () => {
    expect(
      demoTerminalRuntime({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      })
    ).toEqual({ worker: false, renderer: 'auto' });
  });

  it('keeps the accelerated worker path on a desktop browser', () => {
    expect(
      demoTerminalRuntime({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      })
    ).toEqual({ worker: 'dedicated', renderer: 'auto' });
  });
});
