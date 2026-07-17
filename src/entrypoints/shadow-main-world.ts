import { defineUnlistedScript } from '#imports';

export default defineUnlistedScript(() => {
  const attachedEvent = 'tayamun:open-shadow-attached';
  const cleanupEvent = 'tayamun:shadow-bridge-cleanup';
  const bridgeKey = Symbol.for('tayamun.shadow-bridge.q7m3');
  const prototype = Element.prototype;
  type BridgeRecord = {
    original: typeof Element.prototype.attachShadow;
    patched: typeof Element.prototype.attachShadow;
  };
  const bridgeHost = prototype as typeof prototype & {
    [key: symbol]: BridgeRecord | undefined;
  };

  // Content scripts can be reinjected during development or extension reloads.
  // Keep one wrapper per realm instead of stacking attachShadow patches.
  if (bridgeHost[bridgeKey]) return;

  const original = prototype.attachShadow;
  const patched = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const root = original.call(this, init);
    if (init.mode === 'open') {
      this.dispatchEvent(new CustomEvent(attachedEvent, { bubbles: true, composed: true }));
    }
    return root;
  };
  bridgeHost[bridgeKey] = { original, patched };
  prototype.attachShadow = patched;

  document.addEventListener(
    cleanupEvent,
    () => {
      const record = bridgeHost[bridgeKey];
      if (record?.patched === prototype.attachShadow) prototype.attachShadow = record.original;
      delete bridgeHost[bridgeKey];
    },
    { once: true },
  );
});
