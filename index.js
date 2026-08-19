"use strict";

/*
  Signal K Plugin: B&G Key/Value (PGN 130824)

  Bidirectional B&G proprietary key/value plugin, formed by merging the former
  signalk-bgkv-writer and signalk-bgkv-reader plugins. Both halves share one
  KEY_DEFS table, so the encode and decode sides can no longer disagree about a
  key's scale, width, signedness or bearing convention — the drift that table
  duplication used to allow.

  Encode side (enableWriter, default on):
  Encodes B&G proprietary key/value PGN 130824 from selected Signal K paths.
  Each mapping can have its own send interval, priority, and destination.
  Values are packed into fast-packet frames and sent via raw SocketCAN or
  app.emit('nmea2000out') as a fallback.

  When emulate=true, the plugin claims its own NMEA 2000 address as an
  "H5000 CPU" device using a raw SocketCAN socket, completely independent of
  the canboatjs gateway that SignalK already runs on can0.

  Decode side (enableReader, default off):
  Parses fast-packet PGN 130824 off the server's N2K JSON stream and emits
  Signal K deltas for the keys marked `read: true` in KEY_DEFS. When the
  encode side is also running it suppresses our own transmissions by source
  address — a self-echo guard the standalone reader could not implement,
  because it had no way to learn which address the writer had claimed.
*/

module.exports = function (app) {
  const plugin = {};

  plugin.id = "bgkv";
  plugin.name = "SSS: B&G Key/Value (PGN 130824)";
  plugin.description =
    "Encodes Signal K values into, and decodes them out of, B&G proprietary key/value PGN 130824";

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
  // Per-(path, sourceFilter) latest-value cache, fed by the delta listener below.
  // Keyed as `${path}||${sourceFilter}`; only mappings with a non-empty sourceFilter
  // read from this cache, everything else reads via app.getSelfPath.
  const filteredValues = new Map();
  let deltaListener = null;

  // Decode-side state. fpBuffers holds partial fast-packet reassembly keyed
  // `src:pgn`; writerActive gates the self-echo guard in handlePgn130824.
  const fpBuffers = new Map();
  let n2kUnsubscribe = [];
  let writerActive = false;

  const KEEPALIVE_DATA = Buffer.from([0x41, 0x9F, 0x01, 0x17, 0x10, 0x01, 0x00, 0x00]);

  // PGN 130847 stub payload — Navico header [0x13, 0x99] + 54 × 0xFF = 56 bytes.
  // Pre-computed once; buildFastPacketFrames only reads this buffer (never writes it).
  const PGN130847_PAYLOAD = Buffer.concat([Buffer.from([0x13, 0x99]), Buffer.alloc(54, 0xFF)]);

  // scale = physical units per raw integer (raw * scale => value)
  //
  // bearing: true marks keys whose H5000 wire format is signed int16 in
  // [-π, π) but whose Signal K canonical path uses [0, 2π). buildPayload
  // applies wrapPi before encoding for these, and handlePgn130824 applies the
  // inverse (mod 2π) on decode. One flag now drives both directions.
  //
  // read: true marks keys the decode side publishes to defaultPath when it
  // sees them on the bus. Encoding is driven by user mappings and needs no
  // flag; decoding has no per-key UI, so this is the whole decode key set.
  //
  // TODO(bearing-keys): keys 80, 105, 109, 311 are flagged. The following
  // are also bearing-semantic and saturate to 0x7FFF for any value ≥ ~187.7°,
  // but were left unflagged pending confirmation that the H5000 signed-wire
  // convention applies to each: 154 (Heading on Opposite Tack), 211 (DR
  // Bearing), 233 (COG, defaultPath navigation.courseOverGroundTrue —
  // structurally identical to 109), 272 (Start Line Bearing), 306 (Opposite
  // Tack COG), 307 (Opposite Tack Target HDG), 309 (Next Leg Bearing), 336
  // (Avg True Wind Direction, redundant with 80), 384 (Pilot Net Course).
  // Since the merge there is one table: adding `bearing: true` to a row fixes
  // the encode and decode sides together, and the round-trip test in
  // test/roundtrip.test.js covers every bearing-flagged key automatically.
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
    { key: 28, name: "Outside Temp 1", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.outside.temperature", read: true },
    { key: 29, name: "Outside Temp 2", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.outside.temperature", read: true },
    { key: 30, name: "Water Temp 1", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.water.temperature", read: true },
    { key: 31, name: "Water Temp 2", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.water.temperature", read: true },
    { key: 50, name: "Tacking Performance", scale: 0.1, bytes: 2, signed: true },
    { key: 52, name: "Attitude Roll", scale: 0.0001, bytes: 2, signed: true, defaultPath: "navigation.attitude.roll", read: true },
    { key: 53, name: "Optimum Wind Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 56, name: "User 1", scale: 0.01, bytes: 4, signed: true },
    { key: 57, name: "User 2", scale: 0.01, bytes: 4, signed: true },
    { key: 58, name: "User 3", scale: 0.01, bytes: 4, signed: true },
    { key: 59, name: "User 4", scale: 0.01, bytes: 4, signed: true },
    { key: 60, name: "Roll Rate", scale: 0.0001, bytes: 2, signed: true, defaultPath: "navigation.rateOfTurn", read: true },
    { key: 64, name: "Forestay", scale: 0.001, bytes: 4, signed: false },
    { key: 65, name: "Water Speed", scale: 0.01, bytes: 2, signed: false, defaultPath: "navigation.speedThroughWater", read: true },
    { key: 77, name: "Wind Speed Apparent", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.wind.speedApparent", read: true },
    { key: 79, name: "Wind Speed Apparent 2", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.wind.speedApparent", read: true },
    { key: 80, name: "Avg True Wind Dir", scale: 0.0001, bytes: 2, signed: true, bearing: true },
    { key: 81, name: "Wind Angle Apparent", scale: 0.0001, bytes: 2, signed: true, defaultPath: "environment.wind.angleApparent", read: true },
    { key: 83, name: "Target TWA", scale: 0.0001, bytes: 2, signed: true },
    { key: 85, name: "Wind Speed True", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.wind.speedTrue", read: true },
    { key: 86, name: "Wind Speed True 2", scale: 0.01, bytes: 2, signed: false, defaultPath: "environment.wind.speedTrue", read: true },
    { key: 89, name: "Wind Angle True", scale: 0.0001, bytes: 2, signed: true, defaultPath: "environment.wind.angleTrueWater", read: true },
    { key: 100, name: "Unknown 100", scale: 1, bytes: 2, signed: true },
    { key: 102, name: "Keel Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 103, name: "Canard Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 104, name: "Keel Trim Tab Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 105, name: "Course / Heading", scale: 0.0001, bytes: 2, signed: true, bearing: true, defaultPath: "navigation.headingTrue", read: true },
    { key: 109, name: "Wind Direction", scale: 0.0001, bytes: 2, signed: true, bearing: true, defaultPath: "environment.wind.directionTrue", read: true },
    { key: 111, name: "Next Leg AWA", scale: 0.0001, bytes: 2, signed: true },
    { key: 113, name: "Next Leg AWS", scale: 0.01, bytes: 2, signed: false },
    { key: 117, name: "Race Timer", scale: 0.001, bytes: 4, signed: true },
    { key: 124, name: "Polar Performance", scale: 0.1, bytes: 2, signed: true },
    { key: 125, name: "Target Boat Speed", scale: 0.01, bytes: 2, signed: true },
    { key: 126, name: "Polar Speed", scale: 0.01, bytes: 2, signed: false },
    { key: 127, name: "VMG to Wind", scale: 0.01, bytes: 2, signed: false },
    { key: 129, name: "DR Distance", scale: 0.01, bytes: 4, signed: false },
    { key: 130, name: "Leeway Angle", scale: 0.0001, bytes: 2, signed: true, defaultPath: "navigation.leewayAngle", read: true },
    { key: 131, name: "Current Drift", scale: 0.01, bytes: 2, signed: false },
    { key: 132, name: "Current Set", scale: 0.0001, bytes: 2, signed: true },
    { key: 135, name: "Barometric Pressure", scale: 100, bytes: 2, signed: false, defaultPath: "environment.outside.pressure", read: true },
    { key: 152, name: "Distance to Start Line", scale: 0.01, bytes: 4, signed: true },
    { key: 154, name: "Heading on Opposite Tack", scale: 0.0001, bytes: 2, signed: true },
    { key: 155, name: "Attitude Pitch", scale: 0.0001, bytes: 2, signed: true, defaultPath: "navigation.attitude.pitch", read: true },
    { key: 156, name: "Mast Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 157, name: "Wind Angle to Mast", scale: 0.0001, bytes: 2, signed: true },
    { key: 158, name: "Pitch Angle", scale: 0.0001, bytes: 2, signed: true },
    { key: 163, name: "Daggerboard Position", scale: 1, bytes: 2, signed: false },
    { key: 164, name: "Boom Position", scale: 1, bytes: 2, signed: false },
    { key: 185, name: "MOB DR Bearing", scale: 0.0001, bytes: 2, signed: true },
    { key: 186, name: "MOB DR Range", scale: 0.01, bytes: 4, signed: false },
    { key: 194, name: "Depth", scale: 0.01, bytes: 4, signed: false, defaultPath: "environment.depth.belowTransducer", read: true },
    { key: 195, name: "Depth 2", scale: 0.01, bytes: 4, signed: false, defaultPath: "environment.depth.belowKeel", read: true },
    { key: 199, name: "Aft Depth", scale: 0.01, bytes: 4, signed: false, defaultPath: "environment.depth.astem", read: true },
    { key: 205, name: "Odometer", scale: 0.01, bytes: 4, signed: false },
    { key: 207, name: "Trip Distance", scale: 0.01, bytes: 4, signed: false },
    { key: 211, name: "DR Bearing", scale: 0.0001, bytes: 2, signed: true },
    { key: 233, name: "Course Over Ground", scale: 0.0001, bytes: 2, signed: true, defaultPath: "navigation.courseOverGroundTrue", read: true },
    { key: 235, name: "Speed Over Ground", scale: 0.01, bytes: 2, signed: false, defaultPath: "navigation.speedOverGround", read: true },
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
    { key: 311, name: "Ground Wind Direction", scale: 0.0001, bytes: 2, signed: true, bearing: true },
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
        enableWriter: {
          type: "boolean",
          title: "Enable encode side (Signal K → PGN 130824 on the bus)",
          description: "Transmits the mappings below, plus the H5000 emulation PGNs when emulation is on. This is the former bgkv-writer plugin.",
          default: true
        },
        enableReader: {
          type: "boolean",
          title: "Enable decode side (PGN 130824 on the bus → Signal K)",
          description: "Parses B&G key/value PGN 130824 seen on the bus and publishes the known keys as Signal K deltas. This is the former bgkv-reader plugin.",
          default: false
        },
        readerContext: {
          type: "string",
          title: "Decode: Signal K context for updates",
          default: "vessels.self"
        },
        readerSourceLabel: {
          type: "string",
          title: "Decode: source label to attach to values",
          default: "B&G 130824"
        },
        readerEnabledKeys: {
          type: "array",
          title: "Decode: only process these B&G keys (optional, empty = all known keys)",
          items: { type: "number" }
        },
        ignoreOwnTransmissions: {
          type: "boolean",
          title: "Decode: ignore PGN 130824 sent by this plugin's own emulated address",
          description: "Prevents the decode side from re-publishing the values the encode side just transmitted, which would otherwise compete for source arbitration with the values that produced them. Only has an effect when both halves are enabled.",
          default: true
        },
        emitWindPgn130306: {
          type: "boolean",
          title: "Emit standard wind PGN 130306 (apparent wind)",
          description: "When enabled, transmits back-calculated AWA/AWS from sailprocessor as PGN 130306 (reference=Apparent) at 10 Hz from the H5000 emulator address. Requires emulation enabled.",
          default: false
        },
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
              },
              sourceFilter: {
                type: "string",
                title: "Ingest only this $source (optional)",
                description: "When set (e.g. \"sources-plugin\" or \"sailprocessor.calibrated\"), the plugin reads this mapping from deltas whose $source matches. Leave empty to use the server's default source resolution.",
                default: ""
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
    // Reject non-finite inputs. Math.round(Infinity) === Infinity and
    // Math.min(32767, Infinity) === 32767, so without this guard a non-finite
    // value silently encodes to the SINT16 "data not available" sentinel
    // (0xFF 0x7F) — receivers fall back to last-good and the displayed value
    // sticks. A null return signals the caller to drop the mapping for this tick.
    if (!Number.isFinite(val)) return null;
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

  // Wrap a bearing in [0, 2π) (Signal K convention) into [-π, π) (B&G H5000
  // signed-int16 internal convention). Required for bearing-flagged KEY_DEFS
  // before encoding — without it, any bearing ≥ ~187.7° saturates at 0x7FFF.
  function wrapPi(rad) {
    const TWO_PI = 2 * Math.PI;
    return ((rad + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  }

  function toPluginUnits(path, value) {
    if (value == null) return null;
    return value;
  }

  // Manufacturer Code 381 (B&G/Navico), Reserved 0b11, Industry Group 4 (Marine)
  // Bit layout: [mfg_code:11][reserved:2][industry:3] = 0x7D 0x99
  const PROPRI_HEADER = [0x7d, 0x99];

  function readMappingValue(map, def) {
    const path = map.path || def.defaultPath;
    const filter = (map.sourceFilter || "").trim();
    if (filter) {
      const cached = filteredValues.get(`${path}||${filter}`);
      return cached === undefined ? null : cached;
    }
    const skVal = app.getSelfPath ? app.getSelfPath(path) : null;
    if (skVal == null) return null;
    if (typeof skVal === "object") {
      // SK can surface { value: null, timestamp: ... } when a path is
      // declared but no value has been published. Return null, not the wrapper.
      return skVal.value != null ? skVal.value : null;
    }
    return skVal;
  }

  function buildPayload(mappings) {
    const bytes = [...PROPRI_HEADER];
    let appendedAny = false;

    mappings.forEach((map) => {
      const def = KEY_DEFS.find((d) => d.key === map.key);
      if (!def) return;
      const val = readMappingValue(map, def);
      const converted = toPluginUnits(map.path || def.defaultPath, val);
      if (converted == null || Number.isNaN(converted)) return;

      // Bearing keys (e.g. 109 Wind Direction, 105 Heading) use signed int16
      // representing [-π, π). Signal K bearings are [0, 2π) — wrap before
      // scaling so values ≥ π don't saturate to the 0x7FFF "no data" sentinel.
      let valueForEncode = converted;
      if (def.bearing) valueForEncode = wrapPi(valueForEncode);

      const raw = valueForEncode / def.scale;
      const valueBytes = encodeNumber(raw, def.bytes, def.signed);
      // encodeNumber returns null for non-finite input — skip silently rather
      // than emit a bogus SINT sentinel that receivers misinterpret.
      if (valueBytes === null) return;

      // Pack 12-bit key + 4-bit length
      const len = valueBytes.length;
      const header = (def.key & 0xfff) | ((len & 0x0f) << 12);
      bytes.push(header & 0xff, (header >> 8) & 0xff);
      bytes.push(...valueBytes);
      appendedAny = true;
    });

    if (!appendedAny) {
      // Nothing to send — signal empty to callers so they can skip emission entirely.
      return null;
    }

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
    // buildPayload returns null when no mapping contributed a value
    if (!payload) return;

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

  // PGN 130306 — Wind Data (single 8-byte frame, NOT fast-packet).
  // SID rolls 0..252; 0xFF is reserved as the "data not available" sentinel.
  let pgn130306Sid = 0;
  let pgn130306DebugLogged = false;

  function buildPgn130306Payload(awaRad, awsMps, referenceCode) {
    const buf = Buffer.alloc(8, 0xFF);
    buf[0] = pgn130306Sid & 0xFF;
    pgn130306Sid = (pgn130306Sid + 1) % 253;

    if (Number.isFinite(awsMps) && awsMps >= 0) {
      const ws = Math.round(awsMps * 100);
      buf.writeUInt16LE(Math.max(0, Math.min(0xFFFE, ws)), 1);
    } else {
      buf.writeUInt16LE(0xFFFF, 1);
    }

    // Wind angle wire format is unsigned [0, 2π); SK publishes signed ±π
    // (atan2 output) so wrap before scaling — anything else would fail to round-trip.
    if (Number.isFinite(awaRad)) {
      const TWO_PI = Math.PI * 2;
      let a = awaRad % TWO_PI;
      if (a < 0) a += TWO_PI;
      const waRaw = Math.round(a * 10000);
      buf.writeUInt16LE(Math.max(0, Math.min(0xFFFE, waRaw)), 3);
    } else {
      buf.writeUInt16LE(0xFFFF, 3);
    }

    buf[5] = (referenceCode & 0x07) | 0xF8;
    return buf;
  }

  function sendPgn130306Apparent() {
    let awa = NaN, aws = NaN;
    try {
      const awaNode = app.getSelfPath ? app.getSelfPath('environment.wind.angleApparent') : null;
      const awsNode = app.getSelfPath ? app.getSelfPath('environment.wind.speedApparent') : null;
      const awaVal = awaNode && typeof awaNode === 'object' ? awaNode.value : awaNode;
      const awsVal = awsNode && typeof awsNode === 'object' ? awsNode.value : awsNode;
      if (awaVal != null) awa = Number(awaVal);
      if (awsVal != null) aws = Number(awsVal);
    } catch (e) {
      app.debug(`PGN 130306 read error: ${e.message}`);
      return;
    }

    // No wind available — leave the WS310's frames as-is rather than claiming
    // the PGN slot with all-0xFFFF data, which can displace it in receivers.
    if (!Number.isFinite(awa) && !Number.isFinite(aws)) return;

    const payload = buildPgn130306Payload(awa, aws, 2 /* apparent */);
    const canId = computeCanId(130306, 2 /* priority */, sourceAddress, 0xFF);

    if (!pgn130306DebugLogged) {
      app.debug(`PGN 130306 first send: canId=0x${canId.toString(16).toUpperCase().padStart(8, '0')}, src=0x${sourceAddress.toString(16).padStart(2, '0')}`);
      pgn130306DebugLogged = true;
    }

    if (rawCanChannel) {
      try {
        rawCanChannel.send({ id: canId, ext: true, data: payload });
      } catch (e) {
        app.debug(`sendPgn130306Apparent error: ${e.message}`);
      }
    } else {
      const ts = new Date().toISOString();
      const hex = Array.from(payload).map(b => b.toString(16).padStart(2, '0')).join(',');
      app.emit("nmea2000out", `${ts},2,130306,${sourceAddress},255,8,${hex}`);
    }
  }

  // ===========================================================================
  // Decode side: PGN 130824 → Signal K
  // (merged in from the former signalk-bgkv-reader plugin)
  // ===========================================================================

  // The decode key set, derived from the single shared KEY_DEFS table rather
  // than a second hand-maintained copy of the wire spec.
  const READ_DEFS = new Map(
    KEY_DEFS.filter((d) => d.read && d.defaultPath).map((d) => [d.key, d])
  );

  function toTwosComplementSigned(value, bits) {
    // 2 ** rather than 1 << : bitwise operators are 32-bit signed in JS, so
    // 1 << 32 wraps to 1 and would silently mis-sign every 4-byte key.
    const signBit = 2 ** (bits - 1);
    return value >= signBit ? value - (2 ** bits) : value;
  }

  // Bitstream reader for the nibble-packed key/value sequence.
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

  // Parse the B&G key/value stream from raw bytes. The caller strips the
  // 2-byte proprietary header (PROPRI_HEADER) first — this starts at the
  // first key.
  function parseBGKeyValues(dataBuf) {
    const reader = new BitReader(dataBuf);
    const result = [];

    while (reader.bitsRemaining() >= 16) {
      // 12-bit key, 4-bit length — the inverse of the header word buildPayload
      // writes as (key & 0xfff) | ((len & 0x0f) << 12).
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

  function pgnSourceAddress(pgn) {
    const fields = pgn.fields || {};
    const src = pgn.src ?? pgn.Source ?? fields.src ?? fields.Source;
    return typeof src === 'number' ? src : null;
  }

  // Fast-packet reassembly for the ISO FP used by PGN 130824.
  // Frames are 8 bytes. First frame (frameNum=0): [seq(5b)|frame(3b=0), totalLen, d0..d5]
  // Subsequent frames (frameNum>0): [seq(5b)|frame(3b>0), d..]
  function handleFastPacket(pgn, rawBytes) {
    const src = pgnSourceAddress(pgn);
    const key = (src == null ? 'na' : src) + ':' + (pgn.pgn || 130824);
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
    // Little-endian, as is typical for N2K/canboat proprietary payloads.
    // Accumulated by multiplication rather than shift-and-OR: << is 32-bit
    // signed, so a 4-byte value with bit 31 set would come back negative.
    let val = 0;
    const n = Math.min(bytes.length, expectedBytes);
    for (let i = 0; i < n; i++) {
      val += bytes[i] * (2 ** (8 * i));
    }
    if (signed) {
      val = toTwosComplementSigned(val, expectedBytes * 8);
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

      // Self-echo guard. When the encode side is emulating an H5000 on the same
      // bus, our own transmissions come back through the server's N2K pipeline.
      // Decoding them would republish, under this plugin's own $source, the
      // values the encode side just read from sailprocessor — putting the
      // plugin into source arbitration against its own inputs. The standalone
      // reader could never do this: it had no way to know which address the
      // writer had claimed.
      const src = pgnSourceAddress(pgn);
      if (
        options.ignoreOwnTransmissions !== false &&
        writerActive &&
        src != null &&
        src === sourceAddress
      ) {
        return;
      }

      // Prefer fully-assembled Data arrays
      let dataArray = coerceToByteArray(fields.Data || fields.data || fields.Bytes || fields.bytes);
      let buf = null;

      // If canboat already parsed the PGN — it broke out Manufacturer Code and
      // Industry Code as their own fields — then Data is an assembled payload
      // whatever its length, and needs no fast-packet handling. Discriminating
      // on those fields rather than on length matters for short payloads: a
      // single-key message is only 2-4 bytes once the proprietary header is
      // split off, and the old length test (>8 assembled, ==8 raw frame,
      // anything else dropped) threw those away silently.
      const preParsed = typeof fields["Manufacturer Code"] === 'number';

      if (preParsed && Array.isArray(dataArray) && dataArray.length >= 2) {
        buf = Buffer.from(dataArray);
      } else if (Array.isArray(dataArray) && dataArray.length > 8) {
        buf = Buffer.from(dataArray);
      } else if (Array.isArray(dataArray) && dataArray.length === 8) {
        // Looks like a raw 8-byte frame: try fast-packet assembly
        const assembled = handleFastPacket(pgn, dataArray);
        if (!assembled) return; // wait for more frames
        buf = assembled;
      } else if (!dataArray) {
        // Some streams place frame bytes outside fields; try common fallbacks
        const fallback = coerceToByteArray(pgn.data || pgn.bytes || pgn.Data || pgn.Bytes);
        if (Array.isArray(fallback) && fallback.length === 8) {
          const assembled = handleFastPacket(pgn, fallback);
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
      const only = options.readerEnabledKeys || options.enabledKeys;

      kvs.forEach(({ key, bytes }) => {
        if (Array.isArray(only) && only.length > 0 && !only.includes(key)) return;
        const def = READ_DEFS.get(key);
        if (!def) return; // key not in the decode set

        const raw = decodeNumber(bytes, def.bytes, def.signed);
        let value = raw * def.scale;
        if (def.bearing) {
          // Wire format is signed [-π, π); Signal K canonical bearings are
          // [0, 2π). Exact inverse of the wrapPi the encode side applies.
          const TWO_PI = 2 * Math.PI;
          value = ((value % TWO_PI) + TWO_PI) % TWO_PI;
        }

        outValues.push({ path: def.defaultPath, value });
      });

      const delta = buildDelta(
        options.readerContext || options.context || 'vessels.self',
        options.readerSourceLabel || options.sourceLabel || plugin.name,
        outValues
      );
      if (delta) {
        app.handleMessage(plugin.id, delta);
      }
    } catch (e) {
      app.error('BGKV decode error: ' + e.message);
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

  function startReader(cfg) {
    if (typeof app.on !== 'function') {
      app.debug(plugin.name + ': decode side unavailable (app.on missing)');
      return;
    }
    const handler = (data) => onAnyN2k(data, cfg);
    const attached = [];
    for (const ev of ['nmea2000Json', 'N2KAnalyzerOut', 'n2kJson']) {
      try {
        app.on(ev, handler);
        attached.push(ev);
      } catch (_) {}
    }
    n2kUnsubscribe = attached.map((ev) => () => {
      try { app.removeListener(ev, handler); } catch (_) {}
    });
    fpBuffers.clear();
    app.debug(
      plugin.name + ': decode side listening for PGN 130824 on ' +
      (attached.join(', ') || '(no event source available)')
    );
  }

  function stopReader() {
    n2kUnsubscribe.forEach((u) => u());
    n2kUnsubscribe = [];
    fpBuffers.clear();
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
    stopReader();
    writerActive = false;

    // The two halves are independently switchable. Defaults preserve the
    // posture the separate plugins were left in: encode on, decode off.
    const readerEnabled = cfg.enableReader === true;
    const writerEnabled = cfg.enableWriter !== false;
    const readerNote = readerEnabled ? " + decode on" : "";

    sourceAddress = cfg.defaultSourceAddress ?? 14;

    if (readerEnabled) {
      startReader(cfg);
    }

    if (!writerEnabled) {
      app.setPluginStatus(
        plugin.id,
        readerEnabled ? "Decode only (encode side disabled)" : "Idle: both halves disabled"
      );
      return;
    }

    if (!cfg.mappings || cfg.mappings.length === 0) {
      app.setPluginStatus(
        plugin.id,
        readerEnabled
          ? "Decode only (no mappings configured to send)"
          : "No mappings configured; nothing to send."
      );
      return;
    }

    // From here the encode side is live, so the decode side must suppress our
    // own transmissions.
    writerActive = true;

    // Wire a delta listener if any mapping specifies a sourceFilter.
    // Updates the filteredValues cache keyed by `${path}||${sourceFilter}`.
    const filterMappings = (cfg.mappings || []).filter(
      (m) => m && typeof m.sourceFilter === "string" && m.sourceFilter.trim().length > 0
    );
    filteredValues.clear();
    if (deltaListener && app && app.signalk && typeof app.signalk.removeListener === "function") {
      try { app.signalk.removeListener("delta", deltaListener); } catch (_) {}
      deltaListener = null;
    }
    if (filterMappings.length > 0 && app && app.signalk && typeof app.signalk.on === "function") {
      // Index filters by path so we can look up the wanted source labels per-delta.
      const wantByPath = new Map();
      filterMappings.forEach((m) => {
        const key = m.path || (KEY_DEFS.find((d) => d.key === m.key) || {}).defaultPath;
        if (!key) return;
        const filt = m.sourceFilter.trim();
        if (!wantByPath.has(key)) wantByPath.set(key, new Set());
        wantByPath.get(key).add(filt);
      });
      deltaListener = function onDelta(delta) {
        if (!delta || !Array.isArray(delta.updates)) return;
        for (const upd of delta.updates) {
          const label = upd.$source || (upd.source && upd.source.label);
          if (!label) continue;
          if (!Array.isArray(upd.values)) continue;
          for (const v of upd.values) {
            if (!v || !v.path) continue;
            const wanted = wantByPath.get(v.path);
            if (!wanted || !wanted.has(label)) continue;
            const raw = v.value;
            const extracted = raw && typeof raw === "object" && raw.value != null ? raw.value : raw;
            filteredValues.set(`${v.path}||${label}`, extracted);
          }
        }
      };
      app.signalk.on("delta", deltaListener);
    }

    function startDataTimers() {
      cfg.mappings.forEach((map) => {
        const interval = map.intervalMs || 1000;
        const sendCfg = {
          key: map.key,
          path: map.path,
          sourceFilter: map.sourceFilter,
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

      if (cfg.emitWindPgn130306 === true) {
        pgn130306DebugLogged = false;
        // 10 Hz to match the WS310's native rate
        timers.push(setInterval(sendPgn130306Apparent, 100));
        app.debug('PGN 130306 (Apparent Wind) emission enabled at 10 Hz');
      }

      if (rawCanChannel) {
        // Heartbeat every 60 s — required by NMEA 2000 for all nodes
        timers.push(setInterval(sendHeartbeat, 60000));
        // Periodic address re-assertion every 60 s (some devices expect this)
        timers.push(setInterval(() => sendAddressClaim(sourceAddress), 60000));
      }

      const wind130306Note = cfg.emitWindPgn130306 === true ? ', PGN 130306 wind on' : '';
      app.debug(`${plugin.name}: ${timers.length} timer(s) running, src=0x${sourceAddress.toString(16).padStart(2, '0')}${wind130306Note}`);
    }

    if (cfg.emulate !== true) {
      const wind130306Note = cfg.emitWindPgn130306 === true ? " + PGN 130306" : "";
      app.setPluginStatus(plugin.id, `Running (emulation disabled)${wind130306Note}${readerNote}`);
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
      app.setPluginStatus(plugin.id, `Warning: socketcan unavailable, emulation disabled${readerNote}`);
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
        const wind130306Note = cfg.emitWindPgn130306 === true ? " + PGN 130306" : "";
        app.setPluginStatus(plugin.id, `H5000 emulation on ${canDevice}, addr ${addrHex}${wind130306Note}${readerNote}`);
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
    if (deltaListener && app && app.signalk && typeof app.signalk.removeListener === "function") {
      try { app.signalk.removeListener("delta", deltaListener); } catch (_) {}
    }
    deltaListener = null;
    filteredValues.clear();
    ourNAME = null;
    stopReader();
    writerActive = false;
    app.debug(`${plugin.name} stopped`);
  };

  // Test-only: lets the test suite drive the encoder + SID counter without
  // standing up the full timer machinery, and drive the decode side against
  // the encode side's real output for round-trip coverage.
  plugin._buildPgn130306Payload = buildPgn130306Payload;
  plugin._buildPayload = buildPayload;
  plugin._parseBGKeyValues = parseBGKeyValues;
  plugin._decodeNumber = decodeNumber;
  plugin._encodeNumber = encodeNumber;
  plugin._keyDefs = KEY_DEFS;
  plugin._readDefs = READ_DEFS;
  plugin._proprietaryHeader = PROPRI_HEADER;

  return plugin;
};
