/** Operations needed to suspend or permanently release a live terminal demo page. */
export interface PageLifecycleHandlers {
  /** Permanently releases the terminal when the document is not entering the back-forward cache. */
  readonly dispose: () => void;
  /** Remeasures and restores interaction after a back-forward-cache restoration. */
  readonly restore: () => void;
}

/**
 * Keeps a terminal alive while the browser stores its page in the back-forward cache.
 *
 * Mobile Safari uses `pagehide` for both permanent navigations and pages it intends to restore.
 * Disposing on the latter cleanly exits the browser shell and leaves a dead terminal after return.
 */
export function installPageLifecycle(
  handlers: PageLifecycleHandlers,
  target: Window = window
): () => void {
  const handlePageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) handlers.dispose();
  };
  const handlePageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) handlers.restore();
  };

  target.addEventListener('pagehide', handlePageHide);
  target.addEventListener('pageshow', handlePageShow);

  return () => {
    target.removeEventListener('pagehide', handlePageHide);
    target.removeEventListener('pageshow', handlePageShow);
  };
}
