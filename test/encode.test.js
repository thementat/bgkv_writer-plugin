"use strict";

/*
  Regression-witness tests for the PGN 130824 Wind Direction (key 109) bug.

  Pre-fix, this file was committed against the broken code: every test below
  asserted the BROKEN output (Infinity → 0x7FFF, TWD ≥ ~187° saturated to
  the SINT16 sentinel) and passed. After the fix to encodeNumber and the
  introduction of bearing-wrap on keys 80/105/109/311, the assertions are
  inverted: non-finite values produce no emission, and bearings round-trip
  cleanly through the writer + reader pipeline.

  Tests are split across two describe blocks so the broken-behaviour
  baseline can be re-witnessed simply by running this file against the
  pre-fix index.js.
*/

const { makeMockApp } = require('./helpers/mock-app');
const bgkvFactory = require('../index.js');

function makeApp() {
  const app = makeMockApp();
  app.emit = function (event, payload) {
    app._emitted = app._emitted || [];
    app._emitted.push({ event, payload });
  };
  app._emittedOut = () => (app._emitted || []).filter((e) => e.event === 'nmea2000out');
  return app;
}

function startPlugin(app, opts) {
  const plugin = bgkvFactory(app);
  plugin.start(opts);
  return plugin;
}

// Parse a "<ts>,<prio>,<pgn>,<src>,<dst>,<len>,<hex>,<hex>,..." line emitted
// by sendOnce into the raw payload bytes. Returns null if no row.
function lastEmittedPayloadBytes(app) {
  const out = app._emittedOut();
  if (out.length === 0) return null;
  const row = out[out.length - 1].payload;
  const parts = row.split(',');
  const len = Number(parts[5]);
  return parts.slice(6, 6 + len).map((h) => parseInt(h, 16));
}

// Decode a single-mapping PGN 130824 payload into the raw int value of its
// first key/value pair. Assumes 2-byte little-endian, matching keys 80/89/109.
// Returns { key, rawSigned } or null if no value bytes.
function decodeFirstKv(payloadBytes) {
  if (!payloadBytes || payloadBytes.length < 6) return null;
  // payloadBytes[0..1] = PROPRI_HEADER (0x7d, 0x99)
  // payloadBytes[2..3] = 12-bit key + 4-bit length, little-endian
  const header = payloadBytes[2] | (payloadBytes[3] << 8);
  const key = header & 0xfff;
  const len = (header >> 12) & 0x0f;
  if (len !== 2) return null;
  const lo = payloadBytes[4];
  const hi = payloadBytes[5];
  const u = lo | (hi << 8);
  const rawSigned = (u & 0x8000) ? u - 0x10000 : u;
  return { key, rawSigned, lenBytes: len };
}

function wrapTwoPi(rad) {
  return ((rad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

describe('bgkv-writer — encodeNumber non-finite handling (post-fix)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // After the fix, a non-finite input value causes the mapping to be skipped
  // silently. With no other mappings contributing, buildPayload returns null
  // and sendOnce emits nothing. This converts a silent-corruption bug
  // (0xFF 0x7F decoded as the SINT16 "data not available" sentinel) into a
  // clean drop.

  function expectNoEmissionForValue(val) {
    jest.useFakeTimers();
    const app = makeApp();
    app._setSelfPath('environment.wind.directionTrue', { value: val });

    const plugin = startPlugin(app, {
      emulate: false,
      mappings: [
        { key: 109, path: 'environment.wind.directionTrue', intervalMs: 100 }
      ],
      keepAliveEnabled: false
    });

    jest.advanceTimersByTime(150);
    const out = app._emittedOut();
    plugin.stop();
    expect(out.length).toBe(0);
  }

  test('Infinity → no emission (was: 0xFF 0x7F garbage)', () => {
    expectNoEmissionForValue(Infinity);
  });

  test('-Infinity → no emission (was: 0x00 0x80 garbage)', () => {
    expectNoEmissionForValue(-Infinity);
  });

  test('NaN → no emission', () => {
    expectNoEmissionForValue(NaN);
  });

  test('readMappingValue treats { value: null } as no data (no emission)', () => {
    jest.useFakeTimers();
    const app = makeApp();
    // SK occasionally surfaces { value: null, timestamp: ... } when a path
    // has been declared but no value has been published yet. Pre-fix, this
    // returned the whole object, which then divided by scale to NaN and
    // (with the old encodeNumber) produced 0x00 0x00 garbage.
    app._setSelfPath('environment.wind.directionTrue', { value: null, timestamp: '2026-04-30T00:00:00Z' });

    const plugin = startPlugin(app, {
      emulate: false,
      mappings: [
        { key: 109, path: 'environment.wind.directionTrue', intervalMs: 100 }
      ],
      keepAliveEnabled: false
    });

    jest.advanceTimersByTime(150);
    const out = app._emittedOut();
    plugin.stop();
    expect(out.length).toBe(0);
  });
});

describe('bgkv-writer — bearing wrap on PGN 130824 keys (post-fix)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // Bearing keys (80, 105, 109, 311) are signed int16 with scale 0.0001,
  // giving an encoded range of [-π, π) — the H5000 internal convention.
  // SK publishes bearings in [0, 2π). The writer must wrap into [-π, π)
  // before encoding, and the reader must invert (mod 2π) on decode.
  //
  // Pre-fix: TWD = 4.5 rad → raw 45000 → clamped to 32767 → bytes [0xFF,0x7F]
  // Post-fix: TWD = 4.5 rad → wrapPi → -1.7832 → raw -17832 → bytes [0x58,0xBA]

  function emitOnceForKey(key, path, value) {
    jest.useFakeTimers();
    const app = makeApp();
    app._setSelfPath(path, { value });
    const plugin = startPlugin(app, {
      emulate: false,
      mappings: [{ key, path, intervalMs: 100 }],
      keepAliveEnabled: false
    });
    jest.advanceTimersByTime(150);
    const bytes = lastEmittedPayloadBytes(app);
    plugin.stop();
    return bytes;
  }

  test('TWD = 4.5 rad (≈258°) wraps into [-π, π) instead of saturating', () => {
    const bytes = emitOnceForKey(109, 'environment.wind.directionTrue', 4.5);
    expect(bytes).not.toBeNull();
    const kv = decodeFirstKv(bytes);
    expect(kv).not.toBeNull();
    expect(kv.key).toBe(109);
    // 4.5 - 2π ≈ -1.78318 → raw -17832 (rounded)
    // Pre-fix this was 32767 (saturated). Post-fix it's a negative value
    // representing the equivalent bearing on the [-π, π) side.
    expect(kv.rawSigned).toBeCloseTo(-17832, -1);   // tolerance ~1 LSB
    expect(kv.rawSigned).toBeGreaterThanOrEqual(-31416);
    expect(kv.rawSigned).toBeLessThan(31416);
  });

  test('TWD = 0 rad encodes as 0', () => {
    const bytes = emitOnceForKey(109, 'environment.wind.directionTrue', 0);
    const kv = decodeFirstKv(bytes);
    expect(kv.rawSigned).toBe(0);
  });

  test('TWD = π/2 rad encodes within signed range (no wrap needed)', () => {
    const bytes = emitOnceForKey(109, 'environment.wind.directionTrue', Math.PI / 2);
    const kv = decodeFirstKv(bytes);
    // π/2 / 0.0001 = 15708 (exactly fits in signed int16)
    expect(kv.rawSigned).toBe(15708);
  });

  test('round-trip: TWD across [0, 2π) recovers within < 0.0002 rad', () => {
    // Inverse of the writer's wrapPi: signed value → unsigned bearing.
    function readerInverseWrap(signedRad) {
      return wrapTwoPi(signedRad);
    }

    const samples = [
      0,
      0.1,
      Math.PI / 4,
      Math.PI / 2,
      Math.PI - 0.001,
      Math.PI,                  // boundary — wraps to -π
      Math.PI + 0.001,
      3 * Math.PI / 2,
      2 * Math.PI - 0.01
    ];

    for (const sk of samples) {
      const bytes = emitOnceForKey(109, 'environment.wind.directionTrue', sk);
      const kv = decodeFirstKv(bytes);
      expect(kv).not.toBeNull();
      const decodedSigned = kv.rawSigned * 0.0001;
      const recovered = readerInverseWrap(decodedSigned);
      const diff = Math.min(
        Math.abs(recovered - sk),
        Math.abs(recovered - sk - 2 * Math.PI),
        Math.abs(recovered - sk + 2 * Math.PI)
      );
      expect(diff).toBeLessThan(0.0002);
    }
  });

  test('Course/Heading (key 105) gets the same bearing wrap', () => {
    // 5.0 rad ≈ 286° true — would saturate without wrap.
    const bytes = emitOnceForKey(105, 'navigation.headingTrue', 5.0);
    const kv = decodeFirstKv(bytes);
    expect(kv.key).toBe(105);
    // 5.0 - 2π ≈ -1.28318 → raw ≈ -12832
    expect(kv.rawSigned).toBeCloseTo(-12832, -1);
    expect(kv.rawSigned).toBeLessThan(0);
  });

  test('non-bearing signed key (Wind Angle True, key 89) is NOT wrapped', () => {
    // AWA in [-π, π] is already in the encodable range and must not be
    // wrapped — wrapping would distort negative angles.
    // -1.5 rad (port reach AWA) → raw -15000, NOT wrapped to anything else.
    const bytes = emitOnceForKey(89, 'environment.wind.angleTrueWater', -1.5);
    const kv = decodeFirstKv(bytes);
    expect(kv.key).toBe(89);
    expect(kv.rawSigned).toBe(-15000);
  });
});
