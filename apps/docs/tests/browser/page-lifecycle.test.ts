import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPageLifecycle } from '../../src/page-lifecycle';

let removeLifecycle: (() => void) | undefined;

afterEach(() => {
  removeLifecycle?.();
  removeLifecycle = undefined;
});

describe('documentation page lifecycle', () => {
  it('keeps the terminal alive when a page enters and leaves the back-forward cache', () => {
    const dispose = vi.fn();
    const restore = vi.fn();
    removeLifecycle = installPageLifecycle({ dispose, restore });

    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    expect(dispose).not.toHaveBeenCalled();

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(restore).toHaveBeenCalledOnce();
  });

  it('still disposes on a later permanent page hide', () => {
    const dispose = vi.fn();
    removeLifecycle = installPageLifecycle({ dispose, restore: vi.fn() });

    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));

    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not restore after an ordinary initial page show', () => {
    const restore = vi.fn();
    removeLifecycle = installPageLifecycle({ dispose: vi.fn(), restore });

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));

    expect(restore).not.toHaveBeenCalled();
  });
});
