"use strict";

/*
  Signal K Plugin: B&G Key/Value Writer (PGN 130824)

  Encodes B&G proprietary key/value PGN 130824 from selected Signal K paths.
  Each mapping can have its own send interval, priority, and destination.
  Values are packed into fast-packet frames and sent via raw SocketCAN or
  app.emit('nmea2000out') as a fallback.

  When emulate=true, the plugin claims its own NMEA 2000 address as an
  "H5000 CPU" device using a raw SocketCAN socket, completely independent of
  the canboatjs gateway that SignalK already runs on can0.
*/

module.exports = function (app) {
  const plugin = {};

  plugin.id = "bgkv_writer-plugin";
  plugin.name = "B&G Key/Value Writer (PGN 130824)";
  plugin.description =
    "Encodes Signal K values into B&G proprietary key/value PGN 130824";

  let timers = [];
  let claimTimer = null;
  let latestPathSuggestions = [];
  let pathRefreshTimer = null;
  let rawCanChannel = null;
  let sourceAddress = 14;
  let seqCounter = 0;       // shared sequence counter for PGN 130824 / 126996 / 126998
  let seq130847Counter = 0; // dedicated sequence counter for PGN 130847 (racing + serial)
  let heartbeatSeq = 0;
  let ourNAME = null;
  let pluginOptions = {};

  const KEEPALIVE_DATA = Buffer.from([0x41, 0x9F, 0x01, 0x17, 0x10, 0x01, 0x00, 0x00]);

  // PGN 130847 stub payload — Navico header [0x13, 0x99] + 54 × 0xFF = 56 bytes.
  // Pre-computed once; buildFastPacketFrames only reads this buffer (never writes it).
  const PGN130847_PAYLOAD = Buffer.concat([Buffer.from([0x13, 0x99]), Buffer.alloc(54, 0xFF)]);

  // scale = physical units per raw integer (raw * scale => value)
  const KEY_DEFS = [
    { key: 0, name: "Altitude", scale: 1, bytes: 2, signed: true },
    { key: 11, name: "Rudder Angle", scale: 0.0001, bytes: 2, signed: true, defaultPath: "steering.rudderAngle" },
    { key: 16, name: "User 5", scale: 0.01, bytes: 4, signed: true },
    { key: 17, name: "User 6", scale: 0.01, bytes: 4, signed: true },
    { key: 18, name: "User 7", scale: 0.01, bytes: 4, signed: true },
    { key: 19, name: "User 8", scale: 0.01, bytes: 4, signed: true },
    { key: 20, name: "User 9", scale: 0.01, bytes: 4, signed: true },
    { key: 21, name: "User 10", scale: 0.01, bytes: 4, signed: true },
    { key: 22, name: "User 11", scale: 0.01, bytes: 4, signed: true },
    { key: 23, name: "User 12", scale: 0.01, bytes: 4, signed: true },
    { key: 24, name: "User 13", scale: 0.01, bytes: 4, signed: true },
    { key: 25, name: "User 14", scale: 0.01, bytes: 4, signed: true },
    { key: 26, name: "User 15", scale: 0.01, bytes: 4, signed: true },
    { key: 27, name: "User 16", scale: 0.01, bytes: 4, signed: true },
    { key: 28, name: "Outside Temp 1", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.outside.temperature" },
    { key: 29, name: "Outside Temp 2", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.outside.temperature" },
    { key: 30, name: "Water Temp 1", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.water.temperature" },
    { key: 31, name: "Water Temp 2", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.water.temperature" },
    { key: 50, name: "Tacking Performance", scale: 0.1, bytes: 2, signed: true },
    { key: 52, name: "Attitude Roll", scale: 0.0001, bytes: 2, signed: true, defaultPath: "navigation.attitude.roll" },
    { key: 53, name: "Optimum Wind Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 56, name: "User 1", scale: 0.01, bytes: 4, signed: true },
    { key: 57, name: "User 2", scale: 0.01, bytes: 4, signed: true },
    { key: 58, name: "User 3", scale: 0.01, bytes: 4, signed: true },
    { key: 59, name: "User 4", scale: 0.01, bytes: 4, signed: true },
    { key: 60, name: "Roll Rate", scale: 0.0001, bytes: 2, signed: true, defaultPath: "navigation.rateOfTurn" },
    { key: 64, name: "Forestay", scale: 0.001, bytes: 4, signed: false },
    { key: 65, name: "Water Speed", scale: 0.01, bytes: 2, signed: false, defaultPath: "navigation.speedThroughWater" },
    { key: 77, name: "Wind Speed Apparent", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.wind.speedApparent" },
    { key: 79, name: "Wind Speed Apparent 2", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.wind.speedApparent" },
    { key: 80, name: "Avg True Wind Dir", scale: 0.0001, bytes: 2, signed: true },
    { key: 81, name: "Wind Angle Apparent", scale: 0.0001, bytes: 2, signed: true, defaultPath: "environment.wind.angleApparent" },
    { key: 83, name: "Target TWA", scale: 0.0001, bytes: 2, signed: true },
    { key: 85, name: "Wind Speed True", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.wind.speedTrue" },
    { key: 86, name: "Wind Speed True 2", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.wind.speedTrue" },
    { key: 89, name: "Wind Angle True", scale: 0.0001, bytes: 2, signed: true, defaultPath: "environment.wind.angleTrueWater" },
    { key: 100, name: "Unknown 100", scale: 1, bytes: 2, signed: true },
    { key: 102, name: "Keel Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 103, name: "Canard Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 104, name: "Keel Trim Tab Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 105, name: "Course / Heading", scale: 0.0001, bytes: 2, signed: true, defaultPath: "navigation.headingTrue" },
    { key: 109, name: "Wind Direction", scale: 0.0001, bytes: 2, signed: true, defaultPath: "environment.wind.directionTrue" },
    { key: 111, name: "Next Leg AWA", scale: 0.0001, bytes: 2, signed: true },
    { key: 113, name: "Next Leg AWS", scale: 0.01, bytes: 2, signed: false },
    { key: 117, name: "Race Timer", scale: 0.001, bytes: 4, signed: true },
    { key: 124, name: "Polar Performance", scale: 0.1, bytes: 2, signed: true },
    { key: 125, name: "Target Boat Speed", scale: 0.01, bytes: 2, signed: true },
    { key: 126, name: "Polar Speed", scale: 0.01, bytes: 2, signed: false },
    { key: 127, name: "VMG to Wind", scale: 0.01, bytes: 2, signed: false },
    { key: 129, name: "DR Distance", scale: 0.01, bytes: 4, signed: false },
    { key: 130, name: "Leeway Angle", scale: 0.0001, bytes: 2, signed: true, defaultPath: "navigation.leewayAngle" },
    { key: 131, name: "Current Drift", scale: 0.01, bytes: 2, signed: false },
    { key: 132, name: "Current Set", scale: 0.0001, bytes: 2, signed: true },
    { key: 135, name: "Barometric Pressure", scale: 100, bytes: 2, signed: false, defaultPath: "environment.outside.pressure" },
    { key: 152, name: "Distance to Start Line", scale: 0.01, bytes: 4, signed: true },
    { key: 154, name: "Heading on Opposite Tack", scale: 0.0001, bytes: 2, signed: true },
    { key: 155, name: "Attitude Pitch", scale: 0.0001, bytes: 2, signed: true, defaultPath: "navigation.attitude.pitch" },
    { key: 156, name: "Mast Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 157, name: "Wind Angle to Mast", scale: 0.0001, bytes: 2, signed: true },
    { key: 158, name: "Pitch Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 163, name: "Daggerboard Position", scale: 1, bytes: 2, signed: false },
    { key: 164, name: "Boom Position", scale: 1, bytes: 2, signed: false },
    { key: 185, name: "MOB DR Bearing", scale: 0.0001, bytes: 2, signed: true },
    { key: 186, name: "MOB DR Range", scale: 0.01, bytes: 4, signed: false },
    { key: 194, name: "Depth", scale: 0.01, bytes: 4, signed: false, defaultPath: "environment.depth.belowTransducer" },
    { key: 195, name: "Depth 2", scale: 0.01, bytes: 4, signed: false, defaultPath: "environment.depth.belowKeel" },
    { key: 199, name: "Aft Depth", scale: 0.01, bytes: 4, signed: false, defaultPath: "environment.depth.astem" },
    { key: 205, name: "Odometer", scale: 0.01, bytes: 4, signed: false },
    { key: 207, name: "Trip Distance", scale: 0.01, bytes: 4, signed: false },
    { key: 211, name: "DR Bearing", scale: 0.0001, bytes: 2, signed: true },
    { key: 233, name: "Course Over Ground", scale: 0.0001, bytes: 2, signed: true, defaultPath: "navigation.courseOverGroundTrue" },
    { key: 235, name: "Speed Over Ground", scale: 0.01, bytes: 2, signed: false, defaultPath: "navigation.speedOverGround" },
    { key: 239, name: "Remote 0", scale: 0.001, bytes: 2, signed: false },
    { key: 240, name: "Remote 1", scale: 0.001, bytes: 2, signed: false },
    { key: 241, name: "Remote 2", scale: 0.001, bytes: 2, signed: false },
    { key: 242, name: "Remote 3", scale: 0.001, bytes: 2, signed: false },
    { key: 243, name: "Remote 4", scale: 0.001, bytes: 2, signed: false },
    { key: 244, name: "Remote 5", scale: 0.001, bytes: 2, signed: false },
    { key: 245, name: "Remote 6", scale: 0.001, bytes: 2, signed: false },
    { key: 246, name: "Remote 7", scale: 0.001, bytes: 2, signed: false },
    { key: 247, name: "Remote 8", scale: 0.001, bytes: 2, signed: false },
    { key: 248, name: "Remote 9", scale: 0.001, bytes: 2, signed: false },
    { key: 256, name: "Layline Time", scale: 0.001, bytes: 4, signed: false },
    { key: 258, name: "Layline Distance", scale: 0.01, bytes: 4, signed: false },
    { key: 259, name: "Layline Distance 2", scale: 0.01, bytes: 4, signed: false },
    { key: 260, name: "Sailing Time to WP", scale: 0.001, bytes: 4, signed: false },
    { key: 261, name: "Sailing Distance to WP", scale: 0.01, bytes: 4, signed: false },
    { key: 262, name: "Sailing ETA", scale: 0.001, bytes: 4, signed: false },
    { key: 265, name: "Trip Time", scale: 0.001, bytes: 4, signed: false },
    { key: 270, name: "Bow Latitude", scale: 1e-7, bytes: 4, signed: true },
    { key: 271, name: "Bow Longitude", scale: 1e-7, bytes: 4, signed: true },
    { key: 272, name: "Start Line Bearing", scale: 0.0001, bytes: 2, signed: true },
    { key: 273, name: "Start Line Bias", scale: 0.0001, bytes: 2, signed: true },
    { key: 274, name: "Start Line Dist Port", scale: 0.01, bytes: 4, signed: false },
    { key: 275, name: "Start Line Dist Stbd", scale: 0.01, bytes: 4, signed: false },
    { key: 280, name: "Bias Advantage Boat Lengths", scale: 0.1, bytes: 2, signed: true },
    { key: 281, name: "Dist to Start Line Boat Lengths", scale: 0.1, bytes: 2, signed: true },
    { key: 282, name: "Backstay", scale: 0.001, bytes: 4, signed: false },
    { key: 283, name: "Boom Vang", scale: 0.001, bytes: 4, signed: false },
    { key: 284, name: "Chain Length", scale: 0.01, bytes: 4, signed: false },
    { key: 285, name: "VMG Performance", scale: 0.1, bytes: 2, signed: true },
    { key: 286, name: "Inner Forestay Load", scale: 0.001, bytes: 4, signed: false },
    { key: 287, name: "Inner Forestay Halyard Load", scale: 0.001, bytes: 4, signed: false },
    { key: 288, name: "Jib Furl", scale: 0.01, bytes: 4, signed: false },
    { key: 289, name: "Jib Halyard Load", scale: 0.001, bytes: 4, signed: false },
    { key: 290, name: "Outhaul Load", scale: 0.001, bytes: 4, signed: false },
    { key: 291, name: "Plow Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 292, name: "Cunningham", scale: 0.001, bytes: 4, signed: false },
    { key: 293, name: "Jacuzzi Temp", scale: 0.01, bytes: 2, signed: false },
    { key: 294, name: "Pool Temp", scale: 0.01, bytes: 2, signed: false },
    { key: 296, name: "Keel Draught", scale: 0.01, bytes: 2, signed: true },
    { key: 297, name: "Boom Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 298, name: "Code Zero Load", scale: 0.001, bytes: 4, signed: false },
    { key: 301, name: "Distance Behind Start Line", scale: 0.01, bytes: 4, signed: true },
    { key: 302, name: "Distance Behind Start Line (BL)", scale: 0.1, bytes: 2, signed: true },
    { key: 305, name: "Bias Advantage", scale: 0.01, bytes: 4, signed: false },
    { key: 306, name: "Opposite Tack COG", scale: 0.0001, bytes: 2, signed: true },
    { key: 307, name: "Opposite Tack Target HDG", scale: 0.0001, bytes: 2, signed: true },
    { key: 308, name: "Mast Rake", scale: 0.0001, bytes: 2, signed: true },
    { key: 309, name: "Next Leg Bearing", scale: 0.0001, bytes: 2, signed: true },
    { key: 310, name: "Next Leg Target Speed", scale: 0.01, bytes: 2, signed: true },
    { key: 311, name: "Ground Wind Direction", scale: 0.0001, bytes: 2, signed: true },
    { key: 312, name: "Ground Wind Speed", scale: 0.01, bytes: 2, signed: true },
    { key: 313, name: "Mast Cant Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 314, name: "Rudder Toe In", scale: 0.0001, bytes: 2, signed: true },
    { key: 315, name: "Daggerboard Port", scale: 1, bytes: 2, signed: false },
    { key: 316, name: "Daggerboard Starboard", scale: 1, bytes: 2, signed: false },
    { key: 317, name: "User 17", scale: 0.01, bytes: 4, signed: true },
    { key: 318, name: "User 18", scale: 0.01, bytes: 4, signed: true },
    { key: 319, name: "User 19", scale: 0.01, bytes: 4, signed: true },
    { key: 320, name: "User 20", scale: 0.01, bytes: 4, signed: true },
    { key: 321, name: "User 21", scale: 0.01, bytes: 4, signed: true },
    { key: 322, name: "User 22", scale: 0.01, bytes: 4, signed: true },
    { key: 323, name: "User 23", scale: 0.01, bytes: 4, signed: true },
    { key: 324, name: "User 24", scale: 0.01, bytes: 4, signed: true },
    { key: 325, name: "User 25", scale: 0.01, bytes: 4, signed: true },
    { key: 326, name: "User 26", scale: 0.01, bytes: 4, signed: true },
    { key: 327, name: "User 27", scale: 0.01, bytes: 4, signed: true },
    { key: 328, name: "User 28", scale: 0.01, bytes: 4, signed: true },
    { key: 329, name: "User 29", scale: 0.01, bytes: 4, signed: true },
    { key: 330, name: "User 30", scale: 0.01, bytes: 4, signed: true },
    { key: 331, name: "User 31", scale: 0.01, bytes: 4, signed: true },
    { key: 332, name: "User 32", scale: 0.01, bytes: 4, signed: true },
    { key: 336, name: "Avg True Wind Direction", scale: 0.0001, bytes: 2, signed: true },
    { key: 337, name: "Wind Phase", scale: 0.0001, bytes: 2, signed: true },
    { key: 338, name: "Wind Lift", scale: 0.0001, bytes: 2, signed: true },
    { key: 380, name: "Active Perf Mode", scale: 1, bytes: 2, signed: true },
    { key: 381, name: "Gust Bear Away", scale: 0.0001, bytes: 2, signed: true },
    { key: 382, name: "TWS Bear Away", scale: 0.0001, bytes: 2, signed: true },
    { key: 383, name: "Heel Compensation", scale: 0.0001, bytes: 2, signed: true },
    { key: 384, name: "Pilot Net Course", scale: 0.0001, bytes: 2, signed: true },
    { key: 385, name: "Pilot Target Wind Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 386, name: "Pilot Weather Helm", scale: 0.0001, bytes: 2, signed: true },
    { key: 387, name: "Pilot Mean Heel", scale: 0.0001, bytes: 2, signed: true }
  ];

  const DEFAULT_PATH_OPTIONS = Array.from(
    new Set(KEY_DEFS.map((d) => d.defaultPath).filter(Boolean))
  );

  function buildSchema() {
    const pathEnum = Array.from(
      new Set([...DEFAULT_PATH_OPTIONS, ...latestPathSuggestions])
    ).sort();
    return {
      type: "object",
      required: ["mappings"],
      properties: {
        emulate: {
          type: "boolean",
          title: "Enable B&G H5000 device emulation (required for Triton recognition)",
          description: "When enabled, claims NMEA 2000 address and sends Product Information PGN. Required for Triton instruments to recognize this as an H5000-compatible device.",
          default: false
        },
        candevice: {
          type: "string",
          title: "CAN device path (leave empty for autodetect)",
          description: "Path to CAN bus device (e.g., 'can0', 'slcan0'). Leave empty to auto-detect from Signal K CAN bus providers.",
          default: ""
        },
        defaultSourceAddress: {
          type: "number",
          title: "Default source address (H5000-compatible default is 14)",
          default: 14
        },
        modelId: {
          type: "string",
          title: "Model ID (shown on chartplotter device list)",
          default: "H5000 CPU"
        },
        serialNumber: {
          type: "string",
          title: "Serial Number (shown on chartplotter device list)",
          default: "005469"
        },
        keepAliveEnabled: {
          type: "boolean",
          title:
            "Send Navico keepalive PGN 65305 (helps Triton treat this as H5000)",
          default: true
        },
        mappings: {
          type: "array",
          title: "B&G keys to send",
          items: {
            type: "object",
            required: ["key", "path"],
            properties: {
              key: {
                type: "number",
                title: "B&G key",
                enum: KEY_DEFS.map((k) => k.key),
                enumNames: KEY_DEFS.map((k) => `${k.key} – ${k.name}`)
              },
              path: {
                type: "string",
                title: "Signal K path (suggested list is refreshed periodically)",
                anyOf: [
                  {
                    type: "string",
                    title: "Choose a path",
                    enum: pathEnum
                  },
                  {
                    type: "string",
                    title: "Custom path (type manually)"
                  }
                ]
              },
              intervalMs: {
                type: "number",
                title: "Send interval (ms)",
                default: 1000
              },
              priority: {
                type: "number",
                title: "N2K priority",
                default: 6
              },
              destination: {
                type: "number",
                title: "Destination address (255 = broadcast)",
                default: 255
              },
              sourceAddress: {
                type: "number",
                title: "Source address override (optional)"
              }
            }
          }
        }
      }
    };
  }

  plugin.schema = buildSchema;

  function refreshPathSuggestions() {
    try {
      if (app && app.streambundle && app.streambundle.getAvailablePaths) {
        latestPathSuggestions = app.streambundle.getAvailablePaths();
      }
    } catch (_) {
      // ignore
    }
  }

  refreshPathSuggestions();
  if (app && app.streambundle && app.streambundle.getAvailablePaths) {
    pathRefreshTimer = setInterval(refreshPathSuggestions, 15000);
  }

  // ===========================================================================
  // Encoding helpers (unchanged)
  // ===========================================================================

  function encodeNumber(val, bytes, signed) {
    const bits = bytes * 8;
    const max = signed ? (2 ** (bits - 1)) - 1 : (2 ** bits) - 1;
    const min = signed ? -(2 ** (bits - 1)) : 0;
    const clamped = Math.max(min, Math.min(max, Math.round(val)));
    const out = [];
    let tmp = clamped >= 0 ? clamped : clamped + (2 ** bits);
    for (let i = 0; i < bytes; i++) {
      out.push(tmp & 0xff);
      tmp = Math.floor(tmp / 256);
    }
    return out;
  }

  function toPluginUnits(path, value) {
    if (value == null) return null;
    return value;
  }

  // Manufacturer Code 381 (B&G/Navico), Reserved 0b11, Industry Group 4 (Marine)
  // Bit layout: [mfg_code:11][reserved:2][industry:3] = 0x7D 0x99
  const PROPRI_HEADER = [0x7d, 0x99];

  function buildPayload(mappings) {
    const bytes = [...PROPRI_HEADER];

    mappings.forEach((map) => {
      const def = KEY_DEFS.find((d) => d.key === map.key);
      if (!def) return;
      const skVal = app.getSelfPath
        ? app.getSelfPath(map.path || def.defaultPath)
        : null;
      const val =
        skVal && typeof skVal === "object" && skVal.value != null
          ? skVal.value
          : skVal;
      const converted = toPluginUnits(map.path || def.defaultPath, val);
      if (converted == null || Number.isNaN(converted)) return;

      const raw = converted / def.scale;
      const valueBytes = encodeNumber(raw, def.bytes, def.signed);

      // Pack 12-bit key + 4-bit length
      const len = valueBytes.length;
      const header = (def.key & 0xfff) | ((len & 0x0f) << 12);
      bytes.push(header & 0xff, (header >> 8) & 0xff);
      bytes.push(...valueBytes);
    });

    // PGN 130824 is always a fast-packet PGN — pad to guarantee > 8 bytes
    // so receivers don't confuse it for a single-frame message.
    while (bytes.length <= 8) {
      bytes.push(0xff);
    }

    return Buffer.from(bytes);
  }

  // ===========================================================================
  // CAN ID utilities
  // ===========================================================================

  // Compute a 29-bit extended CAN ID from PGN, priority, source, and optional
  // destination.  For PDU1 PGNs (PF < 0xF0) the destination fills the PS byte;
  // for PDU2 PGNs the PS byte is part of the PGN itself.
  function computeCanId(pgn, priority, src, dst) {
    const dp = (pgn >> 16) & 0x01;
    const pf = (pgn >> 8) & 0xFF;
    const ps = pf < 0xF0 ? ((dst !== undefined ? dst : 0xFF) & 0xFF) : (pgn & 0xFF);
    return ((priority & 0x07) << 26) | (dp << 24) | (pf << 16) | (ps << 8) | (src & 0xFF);
  }

  // Decode a 29-bit CAN ID into PGN, destination, and source address.
  function parseCanId(id) {
    const dp = (id >>> 24) & 0x01;
    const pf = (id >>> 16) & 0xFF;
    const ps = (id >>> 8) & 0xFF;
    const sa = id & 0xFF;
    let pgn, dst;
    if (pf < 0xF0) {
      // PDU1: PS is the destination address; PGN has zero in PS byte
      pgn = (dp << 16) | (pf << 8);
      dst = ps;
    } else {
      // PDU2: PS is the group extension, part of PGN; destination is broadcast
      pgn = (dp << 16) | (pf << 8) | ps;
      dst = 0xFF;
    }
    return { pgn, dst, sa };
  }

  // ===========================================================================
  // NMEA 2000 NAME (64-bit device identity)
  // ===========================================================================

  // Build an 8-byte NAME buffer using the same identity fields as the Teensy
  // H5000 emulator (manufacturer 275 / Navico, class 90, function 190,
  // industry group 4 / Marine).  uniqueNumber must be distinct from the
  // Teensy's (1448861) to avoid a NAME collision.
  function buildNAME(uniqueNumber) {
    const buf = Buffer.alloc(8, 0);
    const mfgCode = 275;      // Navico
    const devClass = 90;      // Internal Environment
    const devFunction = 190;
    const industryGroup = 4;  // Marine

    // bits 0-20: unique number, bits 21-31: manufacturer code
    const word0 = ((uniqueNumber & 0x1FFFFF) | ((mfgCode & 0x7FF) << 21)) >>> 0;
    buf.writeUInt32LE(word0, 0);

    // byte 4: device instance lower (3 bits) + upper (5 bits) — both 0
    buf[4] = 0;
    // byte 5: device function
    buf[5] = devFunction & 0xFF;
    // byte 6: reserved (bit 0 = 0) + device class (bits 1-7)
    buf[6] = (devClass & 0x7F) << 1;
    // byte 7: system instance (0) + industry group + self-configurable (1)
    buf[7] = ((industryGroup & 0x07) << 4) | 0x80;

    return buf;
  }

  // Compare two 8-byte NAME buffers as unsigned 64-bit integers (MSB first).
  // Returns -1 if a < b, 0 if equal, +1 if a > b.  Lower NAME wins arbitration.
  function compareNAME(a, b) {
    for (let i = 7; i >= 0; i--) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  // ===========================================================================
  // Fast-packet framing
  // ===========================================================================

  // Split a payload buffer into NMEA 2000 fast-packet CAN frames.
  // Byte 0 of each frame: [seq(3 bits) << 5] | [frameNumber(5 bits)]
  // seq is a 3-bit counter (0-7) that increments per message.
  // IMPORTANT: seq must be masked to 3 bits before shifting.  A 5-bit value
  // (e.g. seq=8) would give (8<<5)=256 which wraps to 0x00 in a Buffer byte,
  // making the 9th message look identical to the 1st and confusing receivers.
  function buildFastPacketFrames(canId, payload) {
    const seq = seqCounter & 0x07;          // 3-bit: (seq<<5) is always 0..0xE0 — no byte overflow
    seqCounter = (seqCounter + 1) & 0x07;
    const frames = [];

    const f0 = Buffer.alloc(8, 0xFF);
    f0[0] = (seq << 5) | 0x00;
    f0[1] = payload.length;
    payload.copy(f0, 2, 0, Math.min(6, payload.length));
    frames.push({ id: canId, ext: true, data: f0 });

    let offset = 6;
    let frameNum = 1;
    while (offset < payload.length) {
      const f = Buffer.alloc(8, 0xFF);
      f[0] = (seq << 5) | (frameNum & 0x1F);   // frameNum max=19 < 32, mask explicit for safety
      payload.copy(f, 1, offset, Math.min(offset + 7, payload.length));
      frames.push({ id: canId, ext: true, data: f });
      offset += 7;
      frameNum++;
    }

    return frames;
  }

  // Dedicated fast-packet framing for PGN 130847 — uses seq130847Counter so that
  // the sequence number seen by receivers increments by exactly 1 per 130847 message,
  // independent of the shared seqCounter used by PGN 130824/126996/126998.
  function buildFastPacketFrames130847(canId, payload) {
    const seq = seq130847Counter & 0x07;
    seq130847Counter = (seq130847Counter + 1) & 0x07;
    const frames = [];

    const f0 = Buffer.alloc(8, 0xFF);
    f0[0] = (seq << 5) | 0x00;
    f0[1] = payload.length;
    payload.copy(f0, 2, 0, Math.min(6, payload.length));
    frames.push({ id: canId, ext: true, data: f0 });

    let offset = 6;
    let frameNum = 1;
    while (offset < payload.length) {
      const f = Buffer.alloc(8, 0xFF);
      f[0] = (seq << 5) | (frameNum & 0x1F);
      payload.copy(f, 1, offset, Math.min(offset + 7, payload.length));
      frames.push({ id: canId, ext: true, data: f });
      offset += 7;
      frameNum++;
    }

    return frames;
  }

  // Send an array of pre-built CAN frames with 1ms spacing between each frame.
  // Spacing prevents MCP2515 TX FIFO overflow and gives low-priority frames time
  // to win bus arbitration before the next frame is queued.
  // Frame 0 is sent immediately (0ms delay); subsequent frames are scheduled at
  // 1ms, 2ms, 3ms … so a 9-frame message completes in ~8ms.
  function sendFramesPaced(frames, debugTag) {
    frames.forEach((frame, i) => {
      setTimeout(() => {
        try { rawCanChannel.send(frame); } catch (e) { app.debug(`${debugTag} frame ${i} error: ${e.message}`); }
      }, i);
    });
  }

  // ===========================================================================
  // Product Information payload (PGN 126996, 134 bytes)
  // ===========================================================================

  function buildProductInfoPayload(modelId, serialCode) {
    // 0xFF-init matches NMEA 2000 convention (0xFF = data not available for unused bytes)
    // and matches what the working Teensy H5000 emulator sends.
    const buf = Buffer.alloc(134, 0xFF);
    buf.writeUInt16LE(2100, 0);                            // NMEA 2000 Version
    buf.writeUInt16LE(246, 2);                             // Product Code
    buf.write(modelId || "H5000 CPU", 4, 32, "ascii");    // Model ID
    buf.write("2.0.45.0.29", 36, 32, "ascii");            // Software Version
    // bytes 68-99: Model Version — leave as 0xFF (data not available)
    buf.write(serialCode || "005469", 100, 32, "ascii");  // Serial Code
    buf.writeUInt8(2, 132);                                // Certification Level
    buf.writeUInt8(1, 133);                                // Load Equivalency
    return buf;
  }

  // ===========================================================================
  // Address claiming and ISO request handling
  // ===========================================================================

  function sendAddressClaim(address) {
    if (!rawCanChannel || !ourNAME) return;
    // PGN 60928, priority 6, addressed to global (0xFF)
    const canId = computeCanId(60928, 6, address, 0xFF);
    try {
      // Pass a copy of ourNAME so the native binding always gets a fresh buffer
      rawCanChannel.send({ id: canId, ext: true, data: Buffer.from(ourNAME) });
      app.debug(`Address claim sent for 0x${address.toString(16).padStart(2, '0')}, canId=0x${canId.toString(16).toUpperCase()}`);
    } catch (e) {
      app.debug(`sendAddressClaim error: ${e.message}`);
    }
  }

  function sendProductInfoResponse() {
    if (!rawCanChannel) return;
    const payload = buildProductInfoPayload(pluginOptions.modelId, pluginOptions.serialNumber);
    const canId = computeCanId(126996, 6, sourceAddress, 0xFF);
    const frames = buildFastPacketFrames(canId, payload);
    app.debug(`Sending Product Info (${frames.length} frames, seq=${frames[0].data[0] >> 5})`);
    // 1ms inter-frame spacing — 20 frames completes in ~19ms, avoiding MCP2515 TX FIFO overflow.
    sendFramesPaced(frames, 'Product Info');
  }

  // PGN 130847 (0x1FF1F) — B&G proprietary sailing/race data.
  // Triton2 polls this every ~700 ms at startup; 1 Hz broadcast keeps it satisfied.
  // Payload: Navico manufacturer header [0x13, 0x99] + 54 bytes 0xFF = 56 bytes total.
  // Header encoding: mfg_code=275 (Navico), reserved=0b11, industry=4 (Marine)
  //   → 16-bit LE: 275 | (3<<11) | (4<<13) = 0x9913 → bytes [0x13, 0x99]
  // Priority 7 matches real H5000 CPU captures.
  function sendPgn130847() {
    if (!rawCanChannel) return;
    const canId = computeCanId(130847, 7, sourceAddress, 0xFF);
    const frames = buildFastPacketFrames130847(canId, PGN130847_PAYLOAD);
    sendFramesPaced(frames, 'PGN 130847');
  }

  // PGN 130847 serial number variant — 12-byte fast-packet broadcast at ~30s intervals.
  // Payload: [0x13, 0x99] header + type byte 0x09 + 6-byte ASCII serial + 3 × 0xFF padding.
  // Receivers distinguish this from the 56-byte racing data by the total-length byte (0x0C vs 0x38)
  // in fast-packet frame 0.  Also sent in response to ISO Requests for PGN 130847.
  function buildPgn130847SerialPayload(serialNumber) {
    const buf = Buffer.alloc(12, 0xFF);
    buf[0] = 0x13;
    buf[1] = 0x99;
    buf[2] = 0x09;   // type: H5000 device
    const serial = (serialNumber || '005469').slice(0, 9);
    buf.write(serial, 3, serial.length, 'ascii');
    return buf;
  }

  function sendPgn130847Serial() {
    if (!rawCanChannel) return;
    const payload = buildPgn130847SerialPayload(pluginOptions.serialNumber);
    const canId = computeCanId(130847, 7, sourceAddress, 0xFF);
    const frames = buildFastPacketFrames130847(canId, payload);
    sendFramesPaced(frames, 'PGN 130847 serial');
  }

  // PGN 126998 (0x1F016) — NMEA 2000 Config Info.
  // Polled during device enumeration; stub stops re-polling.
  function sendPgn126998Response() {
    if (!rawCanChannel) return;
    const payload = Buffer.alloc(32, 0xFF);
    const canId = computeCanId(126998, 6, sourceAddress, 0xFF);
    const frames = buildFastPacketFrames(canId, payload);
    sendFramesPaced(frames, 'PGN 126998');
  }

  function handleIncoming(msg) {
    if (!msg || msg.rtr) return;
    const data = Buffer.isBuffer(msg.data) ? msg.data : Buffer.from(msg.data);
    const { pgn, dst, sa } = parseCanId(msg.id);

    // ---- Address conflict resolution (PGN 60928) ----
    // Another device is claiming the same address we hold.
    if (pgn === 60928 && sa === sourceAddress && ourNAME) {
      if (data.length < 8) return;
      const theirNAME = data.slice(0, 8);
      // Ignore our own frame reflected back (same NAME)
      if (compareNAME(theirNAME, ourNAME) === 0) return;

      if (compareNAME(theirNAME, ourNAME) < 0) {
        // They have a lower (winning) NAME — we must vacate
        let next = sourceAddress + 1;
        if (next > 253) next = 1;
        app.debug(`Address conflict at 0x${sourceAddress.toString(16)}, moving to 0x${next.toString(16)}`);
        sourceAddress = next;
        sendAddressClaim(sourceAddress);
      } else {
        // We have the lower NAME — re-assert our claim
        sendAddressClaim(sourceAddress);
      }
    }

    // ---- ISO Request (PGN 59904) ----
    if (pgn === 59904 && (dst === sourceAddress || dst === 0xFF)) {
      if (data.length < 3) return;
      const requestedPgn = data[0] | (data[1] << 8) | (data[2] << 16);
      if (requestedPgn === 126996) {
        sendProductInfoResponse();
      } else if (requestedPgn === 60928) {
        sendAddressClaim(sourceAddress);
      } else if (requestedPgn === 130847) {
        sendPgn130847Serial();   // ISO Request response uses 12-byte serial variant
      } else if (requestedPgn === 126998) {
        sendPgn126998Response();
      }
    }
  }

  // ===========================================================================
  // Data transmission
  // ===========================================================================

  function sendOnce(cfg) {
    const payload = buildPayload([cfg]);
    // Payload with only the 2-byte manufacturer header means no data
    if (!payload || payload.length <= PROPRI_HEADER.length) return;

    const priority = cfg.priority || 6;
    const src = cfg.sourceAddress ?? sourceAddress;
    const dst = cfg.destination ?? 255;

    if (rawCanChannel) {
      const canId = computeCanId(130824, priority, src, dst);
      sendFramesPaced(buildFastPacketFrames(canId, payload), 'PGN 130824');
    } else {
      // Fallback: route through canboatjs gateway
      const ts = new Date().toISOString();
      const hex = Array.from(payload).map(b => b.toString(16).padStart(2, '0')).join(',');
      app.emit("nmea2000out", `${ts},${priority},130824,${src},${dst},${payload.length},${hex}`);
    }
  }

  function sendKeepAlive() {
    const src = sourceAddress;
    if (rawCanChannel) {
      // PGN 65305, priority 7, broadcast — single 8-byte frame (no fast-packet)
      const canId = computeCanId(65305, 7, src, 0xFF);
      try { rawCanChannel.send({ id: canId, ext: true, data: KEEPALIVE_DATA }); } catch (e) { app.debug(`sendKeepAlive error: ${e.message}`); }
    } else {
      const ts = new Date().toISOString();
      const hex = Array.from(KEEPALIVE_DATA).map(b => b.toString(16).padStart(2, '0')).join(',');
      app.emit("nmea2000out", `${ts},7,65305,${src},255,8,${hex}`);
    }
  }

  // PGN 126993 — Heartbeat (required by NMEA 2000; sent every 60 s)
  // CAN ID: 0x1DF011[src]  (priority 7, DP=1, PF=0xF0, PS=0x11)
  // Payload: [60 EA] [seq] [FF FF FF FF FF]  (8 bytes, single frame)
  function sendHeartbeat() {
    if (!rawCanChannel) return;
    const data = Buffer.from([0x60, 0xEA, heartbeatSeq & 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    heartbeatSeq = (heartbeatSeq + 1) & 0xFF;
    const canId = computeCanId(126993, 7, sourceAddress, 0xFF);
    try { rawCanChannel.send({ id: canId, ext: true, data }); } catch (e) { app.debug(`sendHeartbeat error: ${e.message}`); }
  }

  // ===========================================================================
  // Plugin lifecycle
  // ===========================================================================

  plugin.start = function (options) {
    const cfg = options || {};
    pluginOptions = cfg;

    timers.forEach(t => clearInterval(t));
    timers = [];
    if (claimTimer) { clearTimeout(claimTimer); claimTimer = null; }

    if (rawCanChannel) {
      try { rawCanChannel.stop(); } catch (_) {}
      rawCanChannel = null;
    }
    ourNAME = null;

    if (!cfg.mappings || cfg.mappings.length === 0) {
      app.setPluginStatus(plugin.id, "No mappings configured; nothing to send.");
      return;
    }

    sourceAddress = cfg.defaultSourceAddress ?? 14;

    function startDataTimers() {
      cfg.mappings.forEach((map) => {
        const interval = map.intervalMs || 1000;
        const sendCfg = {
          key: map.key,
          path: map.path,
          priority: map.priority || 6,
          destination: map.destination ?? 255,
          // Per-mapping override only; otherwise sendOnce uses module-level sourceAddress
          sourceAddress: map.sourceAddress
        };
        timers.push(setInterval(() => sendOnce(sendCfg), interval));
      });

      if (cfg.keepAliveEnabled !== false) {
        timers.push(setInterval(sendKeepAlive, 1000));
      }

      // PGN 130847 racing data at 1 Hz — dedicated interval, same pattern as keepalive.
      // sendPgn130847 guards against rawCanChannel being null.
      timers.push(setInterval(sendPgn130847, 1000));
      // PGN 130847 serial number variant at 30 s — matches real H5000 behaviour.
      timers.push(setInterval(sendPgn130847Serial, 30000));

      if (rawCanChannel) {
        // Heartbeat every 60 s — required by NMEA 2000 for all nodes
        timers.push(setInterval(sendHeartbeat, 60000));
        // Periodic address re-assertion every 60 s (some devices expect this)
        timers.push(setInterval(() => sendAddressClaim(sourceAddress), 60000));
      }

      app.debug(`${plugin.name}: ${timers.length} timer(s) running, src=0x${sourceAddress.toString(16).padStart(2, '0')}`);
    }

    if (cfg.emulate !== true) {
      app.setPluginStatus(plugin.id, "Running (emulation disabled)");
      startDataTimers();
      app.emit("nmea2000OutAvailable");
      return;
    }

    // --- H5000 emulation via raw SocketCAN ---

    // Resolve CAN device name
    let canDevice = (cfg.candevice || '').trim();
    if (!canDevice) {
      if (app.config && app.config.settings && app.config.settings.pipedProviders) {
        app.config.settings.pipedProviders.forEach(provider => {
          if (provider.enabled === true && !canDevice) {
            (provider.pipeElements || []).forEach(element => {
              if (element.type === "providers/canbus" && !canDevice) {
                canDevice = (element.options && element.options.canDevice) || '';
              }
            });
          }
        });
      }
      if (!canDevice) canDevice = 'can0';
    }

    // Try to load socketcan
    let socketcan;
    try {
      socketcan = require('socketcan');
    } catch (e) {
      app.debug(`socketcan not available (${e.message}); falling back to app.emit`);
      app.setPluginStatus(plugin.id, "Warning: socketcan unavailable, emulation disabled");
      startDataTimers();
      app.emit("nmea2000OutAvailable");
      return;
    }

    // Open raw CAN channel
    try {
      rawCanChannel = socketcan.createRawChannel(canDevice, true /* timestamps */);
      rawCanChannel.addListener('onMessage', handleIncoming);
      rawCanChannel.start();
    } catch (e) {
      app.debug(`Cannot open CAN channel '${canDevice}': ${e.message}`);
      app.setPluginError(plugin.id, `Cannot open CAN '${canDevice}': ${e.message}`);
      rawCanChannel = null;
      startDataTimers();
      app.emit("nmea2000OutAvailable");
      return;
    }

    // Build our 64-bit NAME.  Unique number 1731561 is distinct from the
    // Teensy's 1448861 so they will never have the same NAME.
    ourNAME = buildNAME(1731561);

    // Defer the initial address claim by one event-loop tick so the libuv
    // file-descriptor watcher registered by rawCanChannel.start() is fully
    // set up before we write to the socket.  Then observe the bus for 250 ms
    // for competing claims (NMEA 2000 spec) before starting data timers.
    process.nextTick(() => {
      sendAddressClaim(sourceAddress);
      sendHeartbeat();

      claimTimer = setTimeout(() => {
        claimTimer = null;
        const addrHex = `0x${sourceAddress.toString(16).padStart(2, '0')}`;
        app.debug(`Address ${addrHex} claimed on ${canDevice}`);
        app.setPluginStatus(plugin.id, `H5000 emulation on ${canDevice}, addr ${addrHex}`);
        startDataTimers();
        // Broadcast Product Info unsolicited — real H5000 CPU does this on bus join.
        // Without this the Zeus shows '---' until it happens to send an ISO Request,
        // which may be too early or never if it already found the device unresponsive.
        sendProductInfoResponse();
      }, 250);
    });

    app.emit("nmea2000OutAvailable");
    app.debug(`${plugin.name}: H5000 emulation started on ${canDevice}, preferred addr 0x${sourceAddress.toString(16).padStart(2, '0')}`);
  };

  plugin.stop = function () {
    timers.forEach(t => clearInterval(t));
    timers = [];
    if (claimTimer) { clearTimeout(claimTimer); claimTimer = null; }
    if (pathRefreshTimer) { clearInterval(pathRefreshTimer); pathRefreshTimer = null; }
    if (rawCanChannel) {
      try { rawCanChannel.stop(); } catch (_) {}
      rawCanChannel = null;
    }
    ourNAME = null;
    app.debug(`${plugin.name} stopped`);
  };

  return plugin;
};
