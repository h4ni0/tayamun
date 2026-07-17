import { defineContentScript, injectScript } from '#imports';
import { browser } from 'wxt/browser';
import { TayamunDirectionEngine } from '../core/engine';
import { getSiteSettings, watchSiteSettings } from '../settings';
import '../core/content.css';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  allFrames: true,
  async main(context) {
    const hostname = window.location.hostname;
    if (!hostname) return;

    const cleanupAttribute = 'data-tayamun-cleaning-q7m3';
    const cleanupCompleteEvent = 'tayamun:cleanup-complete';
    let engine: TayamunDirectionEngine | undefined;
    let unwatch: () => void = () => undefined;
    let cleanedUp = false;
    let cleanupPromise: Promise<void> | undefined;

    const handleMessage = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'tayamun:get-hostname'
      ) {
        return Promise.resolve({ hostname });
      }
      return undefined;
    };
    const handleShadowAttached = (event: Event) => {
      const source = event.composedPath()[0];
      if (source instanceof window.Element && source.shadowRoot) {
        engine?.registerOpenShadowRoot(source.shadowRoot);
      }
    };
    const handlePageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) void cleanup(false);
    };
    const updateCleanupCount = (change: 1 | -1): void => {
      const root = document.documentElement;
      if (!root) return;
      const current = Number.parseInt(root.getAttribute(cleanupAttribute) ?? '0', 10) || 0;
      const next = Math.max(0, current + change);
      if (next === 0) {
        root.removeAttribute(cleanupAttribute);
        document.dispatchEvent(new CustomEvent(cleanupCompleteEvent));
      } else {
        root.setAttribute(cleanupAttribute, String(next));
      }
    };
    const cleanup = (restore = true): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      cleanedUp = true;
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('tayamun:open-shadow-attached', handleShadowAttached, true);
      document.dispatchEvent(new CustomEvent('tayamun:shadow-bridge-cleanup'));
      browser.runtime.onMessage.removeListener(handleMessage);
      unwatch();
      if (restore) updateCleanupCount(1);
      cleanupPromise = (engine?.destroy(restore) ?? Promise.resolve()).finally(() => {
        if (restore) updateCleanupCount(-1);
      });
      return cleanupPromise;
    };
    const waitForPriorCleanup = (): Promise<void> => {
      if (!document.documentElement?.hasAttribute(cleanupAttribute)) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          if (document.documentElement?.hasAttribute(cleanupAttribute)) return;
          document.removeEventListener(cleanupCompleteEvent, done);
          resolve();
        };
        document.addEventListener(cleanupCompleteEvent, done);
        done();
      });
    };

    // Register messaging before the initial DOM scan. Large pages can take time
    // to scan, but their popup must remain usable so a setting can be changed.
    browser.runtime.onMessage.addListener(handleMessage);
    document.addEventListener('tayamun:open-shadow-attached', handleShadowAttached, true);
    const shadowBridge = injectScript('/shadow-main-world.js', { keepInDom: false });
    void shadowBridge.then(
      () => {
        if (cleanedUp) document.dispatchEvent(new CustomEvent('tayamun:shadow-bridge-cleanup'));
      },
      () => undefined,
    );
    context.onInvalidated(() => {
      void cleanup(true);
    });
    context.setInterval(() => undefined, 1_000);
    window.addEventListener('pagehide', handlePageHide);

    try {
      await waitForPriorCleanup();
      if (cleanedUp) return;
      engine = new TayamunDirectionEngine(document, await getSiteSettings(hostname));
      if (cleanedUp) return;
      unwatch = watchSiteSettings(hostname, (settings) => engine?.updateSettings(settings));
      engine.start();
    } catch {
      void cleanup();
    }
  },
});
