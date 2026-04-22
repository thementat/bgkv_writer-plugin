"use strict";

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

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('bgkv_writer-plugin — canonical paths + sourceFilter', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('KEY_DEFS defaultPath entries are canonical (no path-suffix conventions)', () => {
    const schema = bgkvFactory({ ...makeMockApp(), emit() {} }).schema();
    const enumItems = schema.properties.mappings.items.properties.path.anyOf[0].enum;
    // Fallback: also inspect requires. defaultPath entries are the seed of pathEnum.
    for (const p of enumItems) {
      expect(p.endsWith('.sourced')).toBe(false);
      expect(p.endsWith('.calculated')).toBe(false);
      expect(p.endsWith('.filtered')).toBe(false);
      expect(p.endsWith('.calibrated')).toBe(false);
    }
    // sourceFilter is exposed per mapping
    expect(schema.properties.mappings.items.properties.sourceFilter).toBeDefined();
    expect(schema.properties.mappings.items.properties.sourceFilter.default).toBe('');
  });

  test('without sourceFilter, reads value from app.getSelfPath (default source)', () => {
    jest.useFakeTimers();
    const app = makeApp();
    // B&G key 65 = Water Speed, defaultPath = navigation.speedThroughWater
    app._setSelfPath('navigation.speedThroughWater', { value: 3.5 });

    const plugin = startPlugin(app, {
      emulate: false,
      mappings: [
        { key: 65, path: 'navigation.speedThroughWater', intervalMs: 100 }
      ],
      keepAliveEnabled: false
    });

    jest.advanceTimersByTime(150);
    const out = app._emittedOut();
    expect(out.length).toBeGreaterThan(0);
    // Frame format: "<ts>,<prio>,130824,<src>,<dst>,<len>,<hex-bytes>"
    const row = out[out.length - 1].payload;
    expect(row.split(',')[2]).toBe('130824');
    // Payload must be more than the 2-byte PROPRI_HEADER
    const len = Number(row.split(',')[5]);
    expect(len).toBeGreaterThan(2);

    plugin.stop();
  });

  test('with sourceFilter, ingests only matching $source deltas and ignores others', () => {
    jest.useFakeTimers();
    const app = makeApp();
    // getSelfPath returns something the plugin MUST NOT use when sourceFilter is set.
    app._setSelfPath('navigation.speedThroughWater', { value: 99.9 });

    const plugin = startPlugin(app, {
      emulate: false,
      mappings: [
        {
          key: 65,
          path: 'navigation.speedThroughWater',
          sourceFilter: 'sources-plugin',
          intervalMs: 100
        }
      ],
      keepAliveEnabled: false
    });

    // Non-matching source — must be ignored
    app._emitDelta({
      context: 'vessels.self',
      updates: [{
        source: { label: 'Stiletto.17' },
        $source: 'Stiletto.17',
        values: [{ path: 'navigation.speedThroughWater', value: 77.0 }]
      }]
    });

    // With only the getSelfPath fallback blocked (sourceFilter set) and no matching delta yet,
    // payload should be empty, so no emission yet.
    jest.advanceTimersByTime(150);
    expect(app._emittedOut().length).toBe(0);

    // Matching source — expected to populate the filtered cache
    app._emitDelta({
      context: 'vessels.self',
      updates: [{
        source: { label: 'sources-plugin' },
        $source: 'sources-plugin',
        values: [{ path: 'navigation.speedThroughWater', value: 4.2 }]
      }]
    });

    jest.advanceTimersByTime(150);
    const out = app._emittedOut();
    expect(out.length).toBeGreaterThan(0);

    // Verify the encoded value. scale = 0.01 for key 65 → raw = 420 = 0x01A4
    // Header bytes (PGN 130824) = 0x7D 0x99; then key/length = 12-bit key 65 = 0x041 + length 2
    //   combined = (0x041) | (0x2 << 12) = 0x2041 → little-endian: 0x41, 0x20
    // Then raw value 420 little-endian: 0xA4, 0x01
    const row = out[out.length - 1].payload;
    const parts = row.split(',');
    const len = Number(parts[5]);
    const hex = parts.slice(6, 6 + len).join(',').split(',').map((h) => parseInt(h, 16));
    // hex[0..1] = PROPRI_HEADER
    expect(hex[0]).toBe(0x7d);
    expect(hex[1]).toBe(0x99);
    // hex[2..3] = key/length
    expect(hex[2]).toBe(0x41);
    expect(hex[3]).toBe(0x20);
    // hex[4..5] = value 420 little-endian
    expect(hex[4]).toBe(0xa4);
    expect(hex[5]).toBe(0x01);

    plugin.stop();
  });
});
