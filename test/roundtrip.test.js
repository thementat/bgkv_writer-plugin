"use strict";

/*
  Round-trip tests across the encode and decode sides.

  These could not exist before the merge: the encoder lived in
  signalk-bgkv-writer and the decoder in signalk-bgkv-reader, two packages that
  never loaded together, each carrying its own transcription of the PGN 130824
  wire spec. The tables had already drifted on the `bearing` flag. Now both
  sides read one KEY_DEFS row, and these tests assert that encode∘decode is the
  identity for every key the decode side handles — so any future edit to a row
  that breaks one direction fails here.
*/

const { makeMockApp } = require('./helpers/mock-app');
const bgkvFactory = require('../index.js');

function makeApp() {
  const app = makeMockApp();
  app.emit = function (event, payload) {
    app._emitted = app._emitted || [];
    app._emitted.push({ event, payload });
  };
  return app;
}

function freshPlugin(app) {
  return bgkvFactory(app || makeApp());
}

// Strip the 2-byte proprietary header the encoder prepends, leaving the
// key/value stream the parser expects.
function payloadBody(plugin, payloadBuf) {
  const header = plugin._proprietaryHeader;
  expect(Array.from(payloadBuf.slice(0, header.length))).toEqual(Array.from(header));
  return payloadBuf.slice(header.length);
}

function encodeThenDecode(plugin, key, path, value) {
  const app = plugin._app;
  app._setSelfPath(path, { value });
  const payload = plugin._buildPayload([{ key, path }]);
  expect(payload).not.toBeNull();
  const kvs = plugin._parseBGKeyValues(payloadBody(plugin, payload));
  expect(kvs).toHaveLength(1);
  expect(kvs[0].key).toBe(key);
  const def = plugin._keyDefs.find((d) => d.key === key);
  const raw = plugin._decodeNumber(kvs[0].bytes, def.bytes, def.signed);
  let out = raw * def.scale;
  if (def.bearing) {
    const TWO_PI = 2 * Math.PI;
    out = ((out % TWO_PI) + TWO_PI) % TWO_PI;
  }
  return out;
}

function pluginWithApp() {
  const app = makeApp();
  const plugin = bgkvFactory(app);
  plugin._app = app;
  return plugin;
}

describe('PGN 130824 — one shared key table', () => {
  test('every decode key carries the fields both sides need', () => {
    const plugin = freshPlugin();
    for (const [key, def] of plugin._readDefs) {
      expect(typeof def.scale).toBe('number');
      expect([1, 2, 4]).toContain(def.bytes);
      expect(typeof def.defaultPath).toBe('string');
      expect(def.defaultPath.length).toBeGreaterThan(0);
      expect(def.key).toBe(key);
    }
  });

  test('decode set is exactly the 23 keys the standalone reader mapped', () => {
    const plugin = freshPlugin();
    // Frozen list carried over from signalk-bgkv-reader's KEY_MAP, so the
    // merge cannot silently widen or narrow what gets published to Signal K.
    const expected = [28,29,30,31,52,60,65,77,79,81,85,86,89,105,109,130,135,155,194,195,199,233,235];
    expect([...plugin._readDefs.keys()].sort((a, b) => a - b)).toEqual(expected);
  });

  test('every bearing-flagged key is signed int16 (the wrap assumes it)', () => {
    const plugin = freshPlugin();
    const bearings = plugin._keyDefs.filter((d) => d.bearing);
    expect(bearings.length).toBeGreaterThan(0);
    for (const def of bearings) {
      expect(def.signed).toBe(true);
      expect(def.bytes).toBe(2);
      expect(def.scale).toBe(0.0001);
    }
  });
});

describe('PGN 130824 — encode ∘ decode is the identity', () => {
  test('bearing keys round-trip across the full [0, 2π) circle', () => {
    const plugin = pluginWithApp();
    const bearingReadKeys = [...plugin._readDefs.values()].filter((d) => d.bearing);
    expect(bearingReadKeys.length).toBeGreaterThan(0);

    for (const def of bearingReadKeys) {
      for (let deg = 0; deg < 360; deg += 7) {
        const rad = (deg * Math.PI) / 180;
        const out = encodeThenDecode(plugin, def.key, def.defaultPath, rad);
        // 1e-4 rad quantisation on the wire; allow one LSB either way.
        const err = Math.min(
          Math.abs(out - rad),
          Math.abs(out - rad - 2 * Math.PI),
          Math.abs(out - rad + 2 * Math.PI)
        );
        expect(err).toBeLessThan(0.0002);
      }
    }
  });

  test('the 187.7° saturation bug stays fixed for every bearing key', () => {
    // Pre-fix, any bearing >= ~187.7 deg encoded to raw 32767, the SINT16
    // "data not available" sentinel, and receivers fell back to last-good.
    const plugin = pluginWithApp();
    for (const def of [...plugin._readDefs.values()].filter((d) => d.bearing)) {
      const rad = (200 * Math.PI) / 180;
      const payload = (() => {
        plugin._app._setSelfPath(def.defaultPath, { value: rad });
        return plugin._buildPayload([{ key: def.key, path: def.defaultPath }]);
      })();
      const kvs = plugin._parseBGKeyValues(payloadBody(plugin, payload));
      const raw = plugin._decodeNumber(kvs[0].bytes, def.bytes, false);
      expect(raw).not.toBe(0x7fff);
      expect(encodeThenDecode(plugin, def.key, def.defaultPath, rad)).toBeCloseTo(rad, 3);
    }
  });

  test('non-bearing scalar keys round-trip at their own scale', () => {
    const plugin = pluginWithApp();
    const cases = [
      [85, 7.5],    // True wind speed, m/s
      [77, 12.25],  // Apparent wind speed, m/s
      [65, 6.4],    // Speed through water, m/s
      [89, -0.75],  // True wind angle, signed rad
      [52, 0.3],    // Roll, signed rad
      [194, 18.5]   // Depth below transducer, 4-byte unsigned
    ];
    for (const [key, value] of cases) {
      const def = plugin._keyDefs.find((d) => d.key === key);
      const out = encodeThenDecode(plugin, key, def.defaultPath, value);
      expect(out).toBeCloseTo(value, 2);
    }
  });

  test('decodeNumber handles a 4-byte value with bit 31 set (no 32-bit overflow)', () => {
    // The shift-and-OR form this replaced returned a negative number here,
    // because JS bitwise operators coerce to 32-bit signed.
    const plugin = freshPlugin();
    const bytes = Buffer.from([0x00, 0x00, 0x00, 0x80]); // 2147483648 LE
    expect(plugin._decodeNumber(bytes, 4, false)).toBe(2147483648);
    expect(plugin._decodeNumber(bytes, 4, true)).toBe(-2147483648);
  });
});

describe('decode side — lifecycle and self-echo guard', () => {
  function bgFrame(plugin, key, path, value, src) {
    const app = plugin._app;
    app._setSelfPath(path, { value });
    const payload = plugin._buildPayload([{ key, path }]);
    return {
      pgn: 130824,
      src,
      fields: { 'Manufacturer Code': 381, 'Industry Code': 4, Data: Array.from(payloadBody(plugin, payload)) }
    };
  }

  test('decode side is not attached when enableReader is false', () => {
    const plugin = pluginWithApp();
    plugin.start({ enableWriter: false });
    expect(plugin._app._n2kListenerCount()).toBe(0);
    plugin.stop();
  });

  test('with enableReader, a 130824 frame becomes a Signal K delta', () => {
    const plugin = pluginWithApp();
    plugin.start({ enableWriter: false, enableReader: true });
    expect(plugin._app._n2kListenerCount()).toBe(1);

    const frame = bgFrame(plugin, 85, 'environment.wind.speedTrue', 9.5, 22);
    plugin._app._clear();
    plugin._app._emitN2k(frame);

    const delivered = plugin._app._delivered();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].pluginId).toBe('bgkv');
    const values = delivered[0].delta.updates[0].values;
    expect(values).toHaveLength(1);
    expect(values[0].path).toBe('environment.wind.speedTrue');
    expect(values[0].value).toBeCloseTo(9.5, 2);
    plugin.stop();
  });

  test('stop() detaches the decode side', () => {
    const plugin = pluginWithApp();
    plugin.start({ enableWriter: false, enableReader: true });
    plugin.stop();
    expect(plugin._app._n2kListenerCount()).toBe(0);
    plugin._app._clear();
    plugin._app._emitN2k(bgFrame(plugin, 85, 'environment.wind.speedTrue', 9.5, 22));
    expect(plugin._app._delivered()).toHaveLength(0);
  });

  test('frames from our own emulated address are ignored, others are not', () => {
    jest.useFakeTimers();
    const plugin = pluginWithApp();
    // Encode side live at address 14, decode side on.
    plugin.start({
      enableReader: true,
      defaultSourceAddress: 14,
      mappings: [{ key: 85, path: 'environment.wind.speedTrue', intervalMs: 1000 }]
    });

    plugin._app._clear();
    plugin._app._emitN2k(bgFrame(plugin, 85, 'environment.wind.speedTrue', 9.5, 14));
    expect(plugin._app._delivered()).toHaveLength(0); // our own echo

    plugin._app._clear();
    plugin._app._emitN2k(bgFrame(plugin, 85, 'environment.wind.speedTrue', 9.5, 35));
    expect(plugin._app._delivered()).toHaveLength(1); // a real H5000 elsewhere

    plugin.stop();
    jest.useRealTimers();
  });

  test('ignoreOwnTransmissions=false lets the echo through', () => {
    jest.useFakeTimers();
    const plugin = pluginWithApp();
    plugin.start({
      enableReader: true,
      ignoreOwnTransmissions: false,
      defaultSourceAddress: 14,
      mappings: [{ key: 85, path: 'environment.wind.speedTrue', intervalMs: 1000 }]
    });
    plugin._app._clear();
    plugin._app._emitN2k(bgFrame(plugin, 85, 'environment.wind.speedTrue', 9.5, 14));
    expect(plugin._app._delivered()).toHaveLength(1);
    plugin.stop();
    jest.useRealTimers();
  });

  test('readerEnabledKeys filters which keys are published', () => {
    const plugin = pluginWithApp();
    plugin.start({ enableWriter: false, enableReader: true, readerEnabledKeys: [77] });
    plugin._app._clear();
    plugin._app._emitN2k(bgFrame(plugin, 85, 'environment.wind.speedTrue', 9.5, 22));
    expect(plugin._app._delivered()).toHaveLength(0);
    plugin.stop();
  });

  test('non-B&G manufacturer codes are rejected', () => {
    const plugin = pluginWithApp();
    plugin.start({ enableWriter: false, enableReader: true });
    const frame = bgFrame(plugin, 85, 'environment.wind.speedTrue', 9.5, 22);
    frame.fields['Manufacturer Code'] = 275; // Navico, not B&G
    plugin._app._clear();
    plugin._app._emitN2k(frame);
    expect(plugin._app._delivered()).toHaveLength(0);
    plugin.stop();
  });
});
