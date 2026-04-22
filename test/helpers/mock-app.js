"use strict";

function makeMockApp() {
  const delivered = [];
  const subscribers = [];
  const deltaListeners = [];
  const metadata = new Map();
  const selfPathStore = new Map();

  const app = {
    handleMessage(pluginId, delta /* , version */) {
      delivered.push({ pluginId, delta });
    },
    setProviderStatus() {},
    setPluginStatus() {},
    setPluginError() {},
    error: () => {},
    debug: () => {},
    getSelfPath(p) {
      if (selfPathStore.has(p)) return selfPathStore.get(p);
      return undefined;
    },
    getPath() { return undefined; },
    getMetadata(p) {
      if (metadata.has(p)) return metadata.get(p);
      return undefined;
    },
    signalk: {
      on(event, cb) {
        if (event === 'delta') deltaListeners.push(cb);
      },
      removeListener(event, cb) {
        if (event !== 'delta') return;
        const idx = deltaListeners.indexOf(cb);
        if (idx >= 0) deltaListeners.splice(idx, 1);
      },
      retrieve: () => ({ vessels: { self: {} } })
    },
    subscriptionmanager: {
      subscribe(sub, unsubs, errCb, cb) {
        subscribers.push({ sub, cb });
        if (Array.isArray(unsubs)) unsubs.push(() => {});
      }
    },

    // Test helpers
    _setSelfPath(path, value) { selfPathStore.set(path, value); },
    _setMetadata(path, meta) { metadata.set(path, meta); },
    _emitDelta(delta) {
      for (const cb of deltaListeners) cb(delta);
    },
    _emitToSubscribers(delta) {
      for (const s of subscribers) s.cb(delta);
    },
    _delivered() { return delivered; },
    _clear() {
      delivered.length = 0;
    }
  };

  return app;
}

module.exports = { makeMockApp };
