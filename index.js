/*
  Signal K Plugin: B&G Key/Value Reader (PGN 130824)

  Parses proprietary fast-packet PGN 130824 (0x1FF08) for B&G key/value data
  and emits Signal K deltas for commonly known keys.

  Note: This implementation parses the B&G nibble-packed sequence of
  (12-bit key, 4-bit length, <length> bytes value) and maps a subset of
  known keys to Signal K paths with SI units.
*/

"use strict";

module.exports = function (app) {
  const plugin = {};

  plugin.id = 'bgkv-reader';
  plugin.name = 'B&G Key/Value Reader (PGN 130824)';
  plugin.description = 'Decodes B&G proprietary key/value PGN 130824 into Signal K paths.';

  let unsubscribe = [];
  const fpBuffers = new Map(); // fast-packet buffers keyed by src:pgn

  plugin.schema = {
    type: 'object',
    properties: {
      enabledKeys: {
        type: 'array',
        title: 'Only process these B&G keys (optional)',
        items: { type: 'number' }
      },
      context: {
        type: 'string',
        title: 'Signal K context for updates',
        default: 'vessels.self'
      },
      sourceLabel: {
        type: 'string',
        title: 'Source label to attach to values',
        default: 'B&G 130824'
      }
    }
  };

  // Known key mapping: key -> { path, scale, bytes, signed, bearing?, unitNote }
  // scale is applied as raw * scale (e.g., 0.0001 for rad in 1e-4)
  // bearing: keys whose H5000 wire encoding is signed int16 in [-π, π) but
  // whose Signal K canonical path uses [0, 2π). The reader applies
  // (value + 2π) mod 2π after scaling for these. The writer applies the
  // inverse wrap before encoding.
  const KEY_MAP = new Map([
    // Wind
    [77,  { path: 'environment.wind.speedApparent', scale: 0.01,  bytes: 2, signed: false }],
    [79,  { path: 'environment.wind.speedApparent', scale: 0.01,  bytes: 2, signed: false }],
    [81,  { path: 'environment.wind.angleApparent', scale: 0.0001, bytes: 2, signed: true }],
    [85,  { path: 'environment.wind.speedTrue',     scale: 0.01,  bytes: 2, signed: false }],
    [86,  { path: 'environment.wind.speedTrue',     scale: 0.01,  bytes: 2, signed: false }],
    [89,  { path: 'environment.wind.angleTrueWater',scale: 0.0001, bytes: 2, signed: true }],
    [109, { path: 'environment.wind.directionTrue', scale: 0.0001, bytes: 2, signed: true, bearing: true }],

    // Speed / Course
    [65,  { path: 'navigation.speedThroughWater',   scale: 0.01,  bytes: 2, signed: false }],
    [235, { path: 'navigation.speedOverGround',     scale: 0.01,  bytes: 2, signed: false }],
    [233, { path: 'navigation.courseOverGroundTrue',scale: 0.0001, bytes: 2, signed: true }],
    [105, { path: 'navigation.headingTrue',         scale: 0.0001, bytes: 2, signed: true, bearing: true }],

    // Temperatures (Signal K uses Kelvin)
    [28,  { path: 'environment.outside.temperature', scale: 0.01, bytes: 2, signed: false }],
    [29,  { path: 'environment.outside.temperature', scale: 0.01, bytes: 2, signed: false }],
    [30,  { path: 'environment.water.temperature',   scale: 0.01, bytes: 2, signed: false }],
    [31,  { path: 'environment.water.temperature',   scale: 0.01, bytes: 2, signed: false }],

    // Depths
    [194, { path: 'environment.depth.belowTransducer', scale: 0.01, bytes: 4, signed: false }],
    [195, { path: 'environment.depth.belowKeel',       scale: 0.01, bytes: 4, signed: false }],
    [199, { path: 'environment.depth.astem',           scale: 0.01, bytes: 4, signed: false }],

    // Pressure
    [135, { path: 'environment.outside.pressure',   scale: 100,   bytes: 2, signed: false }],

    // Attitude
    [52,  { path: 'navigation.attitude.roll',       scale: 0.0001, bytes: 2, signed: true }],
    [155, { path: 'navigation.attitude.pitch',      scale: 0.0001, bytes: 2, signed: true }],
    [60,  { path: 'navigation.rateOfTurn',          scale: 0.0001, bytes: 2, signed: true }],

    // Leeway
    [130, { path: 'navigation.leewayAngle',         scale: 0.0001, bytes: 2, signed: true }]
  ]);

  function toTwosComplementSigned(value, bits) {
    const signBit = 1 << (bits - 1);
    return (value & signBit) ? value - (1 << bits) : value;
  }

  // Bitstream reader for nibble-packed sequence
  class BitReader {
    constructor(buf) {
      this.buf = buf;
      this.bitPos = 0; // bit index from start
    }

    bitsRemaining() {
      return this.buf.length * 8 - this.bitPos;
    }

    readBits(n) {
      if (n <= 0) return 0;
      let result = 0;
      for (let i = 0; i < n; i++) {
        const byteIndex = (this.bitPos >> 3);
        const bitIndex = this.bitPos & 7; // 0..7, LSB-first in a byte
        const bit = (this.buf[byteIndex] >> bitIndex) & 1;
        result |= (bit << i);
        this.bitPos++;
      }
      return result;
    }

    alignToByte() {
      const mod = this.bitPos & 7;
      if (mod !== 0) this.bitPos += (8 - mod);
    }
  }

  // Parse B&G key/value stream from raw bytes
  function parseBGKeyValues(dataBuf) {
    const reader = new BitReader(dataBuf);
    const result = [];

    // The PGN container includes Manufacturer Code (11 bits) and Industry Code (3 bits)
    // at the start in canboat fielding, but in the canboat JSON we generally receive those
    // separately and the proprietary payload in a single Data array. So we treat the
    // provided buffer as starting at the first key. If upstream includes leading header
    // bits, they must be stripped before calling this.

    while (reader.bitsRemaining() >= 16) {
      // 12-bit key, 4-bit length
      const key = reader.readBits(12);
      const len = reader.readBits(4);
      if (len === 0) {
        // Avoid infinite loop on malformed message
        break;
      }
      if (reader.bitsRemaining() < len * 8) {
        break; // incomplete
      }
      // Values are byte-aligned per definition after reading length nibble
      const bytes = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = reader.readBits(8);
      }

      result.push({ key, bytes });
    }
    return result;
  }

  // Try to coerce a data field into a byte array
  function coerceToByteArray(dataField) {
    if (!dataField) return null;
    if (Array.isArray(dataField)) {
      // Already an array of numbers or hex strings
      if (dataField.length === 0) return [];
      if (typeof dataField[0] === 'number') return dataField.slice();
      // hex strings like "0x12" or "12"
      return dataField.map((s) =>
        typeof s === 'string' ? parseInt(s.replace(/^0x/i, ''), 16) : s
      );
    }
    if (typeof dataField === 'string') {
      // common forms: "01 23 45 67 89 ab cd ef" or "0123456789abcdef"
      const s = dataField.trim();
      const parts = s.includes(' ') ? s.split(/\s+/) : s.match(/.{1,2}/g) || [];
      return parts.map((p) => parseInt(p.replace(/^0x/i, ''), 16)).filter((n) => !Number.isNaN(n));
    }
    return null;
  }

  // Fast-packet reassembly for ISO FP used by PGN 130824
  // Frames are 8 bytes. First frame (frameNum=0): [seq(5b)|frame(3b=0), totalLen, d0, d1, d2, d3, d4, d5]
  // Subsequent frames (frameNum>0): [seq(5b)|frame(3b>0), d..]
  function handleFastPacket(pgn, fields, rawBytes) {
    const src = pgn.src || pgn.Source || pgn.fields?.src || pgn.fields?.Source;
    const key = `${src || 'na'}:${pgn.pgn || 130824}`;
    if (!Array.isArray(rawBytes) || rawBytes.length !== 8) return null;
    const frameNum = (rawBytes[0] >> 5) & 0x07;
    const seq = rawBytes[0] & 0x1f; // sequence cycles 0..31
    let state = fpBuffers.get(key);

    if (!state) {
      if (frameNum !== 0) return null; // cannot start from a continuation frame
      const totalLen = rawBytes[1];
      if (totalLen == null || totalLen > 223) return null; // rudimentary guard
      const data = [];
      for (let i = 2; i < 8; i++) data.push(rawBytes[i]);
      state = { seq, totalLen, data, frameNum, lastUpdate: Date.now() };
      fpBuffers.set(key, state);
    } else {
      // Only accept the next frame numbers, but be tolerant of seq wrap
      // Append payload bytes 1..7 for continuation frames
      for (let i = 1; i < 8; i++) state.data.push(rawBytes[i]);
      state.frameNum = frameNum;
      state.seq = seq;
      state.lastUpdate = Date.now();
    }

    // Trim to total length and emit when complete
    if (state.data.length >= state.totalLen) {
      const assembled = Buffer.from(state.data.slice(0, state.totalLen));
      fpBuffers.delete(key);
      return assembled;
    }
    return null;
  }

  function decodeNumber(bytes, expectedBytes, signed) {
    // Use little-endian as is typical for N2K/canboat proprietary payloads
    let val = 0;
    const n = Math.min(bytes.length, expectedBytes);
    for (let i = 0; i < n; i++) {
      val |= (bytes[i] << (8 * i));
    }
    const bits = expectedBytes * 8;
    if (signed) {
      val = toTwosComplementSigned(val, bits);
    }
    return val;
  }

  function buildDelta(context, sourceLabel, values) {
    if (values.length === 0) return null;
    return {
      context,
      updates: [
        {
          source: { label: sourceLabel },
          timestamp: new Date().toISOString(),
          values
        }
      ]
    };
  }

  function handlePgn130824(pgn, options) {
    try {
      // Expect canboat-style JSON: pgn.pgn === 130824 and pgn.fields.Data is array of bytes
      const fields = pgn.fields || {};
      if (typeof fields["Manufacturer Code"] === 'number' && fields["Manufacturer Code"] !== 381) {
        return; // Not B&G
      }
      if (typeof fields["Industry Code"] === 'number' && fields["Industry Code"] !== 4) {
        return; // Not Marine industry per spec
      }

      // Prefer fully-assembled Data arrays
      let dataArray = coerceToByteArray(fields.Data || fields.data || fields.Bytes || fields.bytes);
      let buf = null;

      if (Array.isArray(dataArray) && dataArray.length > 8) {
        buf = Buffer.from(dataArray);
      } else if (Array.isArray(dataArray) && dataArray.length === 8) {
        // Looks like a raw 8-byte frame: try fast-packet assembly
        const assembled = handleFastPacket(pgn, fields, dataArray);
        if (!assembled) return; // wait for more frames
        buf = assembled;
      } else if (!dataArray) {
        // Some streams place frame bytes outside fields; try common fallbacks
        const fallback = coerceToByteArray(pgn.data || pgn.bytes || pgn.Data || pgn.Bytes);
        if (Array.isArray(fallback) && fallback.length === 8) {
          const assembled = handleFastPacket(pgn, fields, fallback);
          if (!assembled) return;
          buf = assembled;
        } else if (Array.isArray(fallback) && fallback.length > 8) {
          buf = Buffer.from(fallback);
        } else {
          return;
        }
      } else {
        return;
      }

      const kvs = parseBGKeyValues(buf);
      const outValues = [];

      kvs.forEach(({ key, bytes }) => {
        if (options.enabledKeys && Array.isArray(options.enabledKeys) && options.enabledKeys.length > 0) {
          if (!options.enabledKeys.includes(key)) return;
        }
        const map = KEY_MAP.get(key);
        if (!map) return; // unknown key not mapped

        // Only decode numeric types here per our map
        const raw = decodeNumber(bytes, map.bytes, map.signed);
        let value = raw * map.scale;
        if (map.bearing) {
          // Wire format is signed [-π, π); Signal K canonical bearings are [0, 2π).
          const TWO_PI = 2 * Math.PI;
          value = ((value % TWO_PI) + TWO_PI) % TWO_PI;
        }

        outValues.push({ path: map.path, value });
      });

      const delta = buildDelta(options.context || 'vessels.self', options.sourceLabel || plugin.name, outValues);
      if (delta) {
        app.handleMessage(plugin.id, delta);
      }
    } catch (e) {
      app.error(`BGKV decode error: ${e.message}`);
    }
  }

  function onAnyN2k(msg, options) {
    if (!msg) return;
    const pgn = msg.pgn || msg.PGN || msg;
    const pgnNumber = typeof pgn === 'number' ? pgn : (pgn && pgn.pgn);
    if (pgnNumber === 130824 || (pgn && pgn.pgn === 130824)) {
      const p = typeof pgn === 'number' ? msg : pgn;
      handlePgn130824(p, options);
    }
  }

  plugin.start = function (options) {
    // Subscribe to several commonly seen event names for N2K JSON
    const handlers = [];
    const handler = (data) => onAnyN2k(data, options || {});

    for (const ev of ['nmea2000Json', 'N2KAnalyzerOut', 'n2kJson']) {
      try {
        app.on(ev, handler);
        handlers.push(ev);
      } catch (_) {}
    }

    unsubscribe = handlers.map((ev) => () => {
      try { app.removeListener(ev, handler); } catch (_) {}
    });
    app.debug(`${plugin.name} started: listening for PGN 130824`);
  };

  plugin.stop = function () {
    unsubscribe.forEach((u) => u());
    unsubscribe = [];
    app.debug(`${plugin.name} stopped`);
  };

  return plugin;
};
