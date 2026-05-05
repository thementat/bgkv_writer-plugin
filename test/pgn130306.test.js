"use strict";

/*
  Tests for PGN 130306 (Wind Data) emission gated by emitWindPgn130306.

  Covers:
  - the schema flag exists and defaults off
  - encoder layout (buildPgn130306Payload) for several AWA/AWS shapes
  - SID rolls 0..252 then wraps to 0
  - the timer respects the gate flag
  - the no-emulation fallback emits PGN 130306 frames via app.emit('nmea2000out')
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
  app._emittedFor = (pgn) =>
    app._emittedOut().filter((e) => e.payload.split(',')[2] === String(pgn));
  return app;
}

function startPlugin(app, opts) {
  const plugin = bgkvFactory(app);
  plugin.start(opts);
  return plugin;
}

function inertMapping() {
  // Key 65 = Water Speed; we never set the path so buildPayload contributes nothing
  // and the 130824 sendOnce timer emits no frames. Lets us isolate 130306 emissions.
  return { key: 65, path: 'navigation.speedThroughWater', intervalMs: 1000 };
}

describe('PGN 130306 — schema + gate flag', () => {
  test('schema exposes emitWindPgn130306 default false at the top of properties', () => {
    const schema = bgkvFactory({ ...makeMockApp(), emit() {} }).schema();
    expect(schema.properties.emitWindPgn130306).toBeDefined();
    expect(schema.properties.emitWindPgn130306.type).toBe('boolean');
    expect(schema.properties.emitWindPgn130306.default).toBe(false);
    // Ordering hint: emitWindPgn130306 listed before emulate in the properties block
    const keys = Object.keys(schema.properties);
    expect(keys.indexOf('emitWindPgn130306')).toBeLessThan(keys.indexOf('emulate'));
  });
});

describe('PGN 130306 — buildPgn130306Payload encoder', () => {
  function freshEncoder() {
    const app = makeApp();
    const plugin = bgkvFactory(app);
    return plugin._buildPgn130306Payload;
  }

  test('AWA=0, AWS=5 m/s, ref=2 → speed 0x01F4 LE, angle 0x0000, ref byte 0xFA', () => {
    const enc = freshEncoder();
    const buf = enc(0, 5, 2);
    // SID is the first call on a fresh encoder → 0
    expect(buf[0]).toBe(0);
    expect(buf[1]).toBe(0xF4); // 500 LE low
    expect(buf[2]).toBe(0x01); // 500 LE high
    expect(buf[3]).toBe(0x00); // angle low
    expect(buf[4]).toBe(0x00); // angle high
    expect(buf[5]).toBe(0xFA); // (2 & 0x07) | 0xF8
    expect(buf[6]).toBe(0xFF);
    expect(buf[7]).toBe(0xFF);
  });

  test('AWA=π/2 (90°), AWS=10 m/s → angle 0x3D5C, speed 0x03E8', () => {
    const enc = freshEncoder();
    const buf = enc(Math.PI / 2, 10, 2);
    // speed = 1000 = 0x03E8
    expect(buf.readUInt16LE(1)).toBe(1000);
    // angle raw = round(π/2 * 10000) = 15708 = 0x3D5C
    expect(buf.readUInt16LE(3)).toBe(15708);
    expect(buf[5]).toBe(0xFA);
  });

  test('AWA=-π/4 (signed) wraps to 7π/4 → angle raw 54978 = 0xD6C2', () => {
    const enc = freshEncoder();
    const buf = enc(-Math.PI / 4, 0, 2);
    // 7π/4 * 10000 = 54977.8718... → rounds to 54978
    const raw = buf.readUInt16LE(3);
    expect(raw).toBe(54978);
  });

  test('AWA=NaN, AWS=5 m/s → angle 0xFFFF, speed encoded normally', () => {
    const enc = freshEncoder();
    const buf = enc(NaN, 5, 2);
    expect(buf[3]).toBe(0xFF);
    expect(buf[4]).toBe(0xFF);
    expect(buf.readUInt16LE(1)).toBe(500);
    expect(buf[5]).toBe(0xFA);
  });

  test('reference byte is always 0xFA for apparent (verifies the 0xF8 mask)', () => {
    const enc = freshEncoder();
    for (let i = 0; i < 10; i++) {
      const buf = enc(0.1 * i, 1 + i, 2);
      expect(buf[5]).toBe(0xFA);
    }
  });

  test('SID rolls 0..252 then wraps to 0 on the 254th call', () => {
    const enc = freshEncoder();
    const seen = [];
    for (let i = 0; i < 254; i++) {
      const buf = enc(0, 0, 2);
      seen.push(buf[0]);
    }
    // First 253 calls produce SIDs 0..252 in order
    for (let i = 0; i <= 252; i++) {
      expect(seen[i]).toBe(i);
    }
    // 254th call (index 253) wraps back to 0
    expect(seen[253]).toBe(0);
    // 0xFF sentinel never appears in normal rolling
    expect(seen.includes(0xFF)).toBe(false);
  });
});

describe('PGN 130306 — timer + fallback path', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('with emitWindPgn130306=false, no 130306 frames are emitted even when AWA/AWS present', () => {
    jest.useFakeTimers();
    const app = makeApp();
    app._setSelfPath('environment.wind.angleApparent', { value: 1.0 });
    app._setSelfPath('environment.wind.speedApparent', { value: 5.0 });

    const plugin = startPlugin(app, {
      emulate: false,
      emitWindPgn130306: false,
      mappings: [inertMapping()],
      keepAliveEnabled: false
    });

    jest.advanceTimersByTime(1000);
    plugin.stop();

    expect(app._emittedFor(130306).length).toBe(0);
  });

  test('with emitWindPgn130306=true and emulation off, fallback emits PGN 130306 frames at 10 Hz', () => {
    jest.useFakeTimers();
    const app = makeApp();
    app._setSelfPath('environment.wind.angleApparent', { value: Math.PI / 4 });
    app._setSelfPath('environment.wind.speedApparent', { value: 6.5 });

    const plugin = startPlugin(app, {
      emulate: false,
      emitWindPgn130306: true,
      mappings: [inertMapping()],
      keepAliveEnabled: false
    });

    jest.advanceTimersByTime(1000); // 10 ticks at 100ms each
    plugin.stop();

    const wind = app._emittedFor(130306);
    expect(wind.length).toBeGreaterThanOrEqual(9);
    expect(wind.length).toBeLessThanOrEqual(11);

    // Verify framing of the most recent emission
    const row = wind[wind.length - 1].payload;
    const parts = row.split(',');
    expect(parts[1]).toBe('2');         // priority
    expect(parts[2]).toBe('130306');    // pgn
    expect(parts[4]).toBe('255');       // dst broadcast
    expect(parts[5]).toBe('8');         // length
    const hex = parts.slice(6, 14).map((h) => parseInt(h, 16));
    expect(hex.length).toBe(8);
    // Reference byte is always 0xFA (apparent)
    expect(hex[5]).toBe(0xFA);
    // Speed = round(6.5 * 100) = 650 = 0x028A
    expect(hex[1] | (hex[2] << 8)).toBe(650);
    // Angle = round(π/4 * 10000) = 7854
    expect(hex[3] | (hex[4] << 8)).toBe(7854);
  });

  test('when AWA and AWS are both unavailable, no 130306 frame is emitted', () => {
    jest.useFakeTimers();
    const app = makeApp();
    // Deliberately do not set selfPath for either wind path

    const plugin = startPlugin(app, {
      emulate: false,
      emitWindPgn130306: true,
      mappings: [inertMapping()],
      keepAliveEnabled: false
    });

    jest.advanceTimersByTime(500);
    plugin.stop();

    expect(app._emittedFor(130306).length).toBe(0);
  });
});
