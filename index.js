"use strict";

/*
  Signal K Plugin: B&G Key/Value Writer (PGN 130824)

  Encodes B&G proprietary key/value PGN 130824 from selected Signal K paths.
  Each mapping can have its own send interval, priority, and destination.
  Values are packed into fast-packet frames and emitted via `nmea2000out`.
*/

module.exports = function (app) {
  const plugin = {};

  plugin.id = "bgkv_writer-plugin";
  plugin.name = "B&G Key/Value Writer (PGN 130824)";
  plugin.description =
    "Encodes Signal K values into B&G proprietary key/value PGN 130824";

  let timers = [];
  let seq = 0;
  let latestPathSuggestions = [];
  let pathRefreshTimer = null;
  let simpleCan = null;
  let sourceAddress = 14;
  const KEEPALIVE_PGN =
    "%s,7,65305,%s,255,8,41,9f,01,17,1c,01,00,00"; // borrowed from bandg performance plugin

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

  function encodeNumber(val, bytes, signed) {
    const max = signed ? (1 << (bytes * 8 - 1)) - 1 : (1 << (bytes * 8)) - 1;
    const min = signed ? -(1 << (bytes * 8 - 1)) : 0;
    const clamped = Math.max(min, Math.min(max, Math.round(val)));
    const out = [];
    let tmp = clamped >= 0 ? clamped : clamped + (1 << (bytes * 8));
    for (let i = 0; i < bytes; i++) {
      out.push(tmp & 0xff);
      tmp >>= 8;
    }
    return out;
  }

  function toPluginUnits(path, value) {
    if (value == null) return null;
    // Convert from Signal K default units into what B&G payload expects.
    // Temperature keys use Kelvin scaling (centi-K); no offset needed.
    // Rates/angles use radians already; speeds/distances are metric in SK.
    return value;
  }

  function buildPayload(mappings) {
    const bytes = [];

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

    return Buffer.from(bytes);
  }

  function buildFastPacketFrames(payload) {
    if (!payload || payload.length === 0) return [];
    const frames = [];
    const totalLen = payload.length;
    let offset = 0;
    const localSeq = seq++ & 0x1f; // 5 bits
    let frameNum = 0;

    while (offset < totalLen) {
      const frame = Buffer.alloc(8, 0xff);
      frame[0] = ((frameNum & 0x07) << 5) | localSeq;
      if (frameNum === 0) {
        frame[1] = totalLen;
        const copyLen = Math.min(6, totalLen);
        payload.copy(frame, 2, 0, copyLen);
        offset += copyLen;
      } else {
        const copyLen = Math.min(7, totalLen - offset);
        payload.copy(frame, 1, offset, offset + copyLen);
        offset += copyLen;
      }
      frames.push(frame);
      frameNum++;
    }
    return frames;
  }

  function frameToActisense(frame, opts) {
    const ts = new Date().toISOString();
    const priority = opts.priority ?? 6;
    const src = opts.src ?? 0;
    const dst = opts.destination ?? 255;
    const hex = Array.from(frame)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(",");
    return `${ts},${priority},130824,${src},${dst},8,${hex}`;
  }

  function sendN2k(msg) {
    if (simpleCan) {
      simpleCan.sendPGN(msg);
    } else {
      app.emit("nmea2000out", msg);
    }
  }

  function sendOnce(cfg) {
    const payload = buildPayload([cfg]);
    if (!payload || payload.length === 0) return;
    const frames = buildFastPacketFrames(payload);
    const opts = {
      priority: cfg.priority || 6,
      destination: cfg.destination ?? 255,
      src: cfg.sourceAddress ?? sourceAddress
    };

    frames.forEach((frame) => {
      const line = frameToActisense(frame, opts);
      sendN2k(line);
    });
  }

  function sendKeepAlive(src) {
    const msg = require("util").format(
      KEEPALIVE_PGN,
      new Date().toISOString(),
      src ?? sourceAddress
    );
    sendN2k(msg);
  }

  plugin.start = function (options) {
    const cfg = options || {};
    timers.forEach((t) => clearInterval(t));
    timers = [];
    
    // Clean up any existing SimpleCan instance
    if (simpleCan) {
      try {
        simpleCan.stop();
      } catch (e) {
        app.debug(`Error stopping SimpleCan: ${e.message}`);
      }
      simpleCan = null;
    }

    if (!cfg.mappings || cfg.mappings.length === 0) {
      app.setPluginStatus(
        plugin.id,
        "No mappings configured; nothing to send."
      );
      return;
    }

    sourceAddress = cfg.defaultSourceAddress ?? 14;

    // Initialize H5000 device emulation if enabled
    if (cfg.emulate === true) {
      try {
        const SimpleCan = require("@canboat/canboatjs").SimpleCan;
        app.debug(`Using device id: ${sourceAddress}`);
        
        var canDevice = cfg.candevice;
        var deviceAddress;

        if (typeof canDevice === "undefined" || canDevice === "") {
          // Auto-detect CAN device from Signal K providers
          app.debug("Trying to detect canDevice");
          if (app.config && app.config.settings && app.config.settings.pipedProviders) {
            app.config.settings.pipedProviders.forEach(provider => {
              if (provider.enabled === true && typeof deviceAddress === "undefined") {
                provider.pipeElements.forEach(element => {
                  if (element.type === "providers/canbus" && typeof deviceAddress === "undefined") {
                    app.debug("Found providers/canbus");
                    if (typeof element.options.canDevice !== "undefined") {
                      app.debug(`element.options.canDevice: ${element.options.canDevice}`);
                      canDevice = element.options.canDevice;
                    }
                  }
                });
              }
            });
          }
        } else {
          app.debug(`Using configured canDevice: ${canDevice}`);
        }

        simpleCan = new SimpleCan({
          app,
          canDevice: canDevice,
          preferredAddress: sourceAddress,
          transmitPGNs: [126996],
          addressClaim: {
            "Unique Number": 1731561,
            "Manufacturer Code": "Navico",
            "Device Function": 190,
            "Device Class": "Internal Environment",
            "Device Instance Lower": 0,
            "Device Instance Upper": 0,
            "System Instance": 0,
            "Industry Group": "Marine"
          },
          productInfo: {
            "NMEA 2000 Version": 2100,
            "Product Code": 246,
            "Model ID": "H5000 CPU",
            "Software Version Code": "2.0.45.0.29",
            "Model Version": "",
            "Model Serial Code": "005469",
            "Certification Level": 2,
            "Load Equivalency": 1
          }
        });

        simpleCan.start();
        if (canDevice) {
          app.setPluginStatus(plugin.id, `H5000 emulation enabled, connected to ${canDevice}`);
        } else {
          app.setPluginStatus(plugin.id, "H5000 emulation enabled");
        }
        app.debug(`SimpleCan started, device address: ${simpleCan.candevice ? simpleCan.candevice.address : "unknown"}`);
        deviceAddress = simpleCan.candevice ? simpleCan.candevice.address : sourceAddress;
        sourceAddress = deviceAddress;
      } catch (e) {
        app.setPluginError(plugin.id, `Failed to initialize H5000 emulation: ${e.message}`);
        app.debug(`SimpleCan initialization error: ${e.stack}`);
        // Continue without emulation
        simpleCan = null;
      }
    }

    cfg.mappings.forEach((map) => {
      const interval = map.intervalMs || 1000;
      const sendCfg = {
        key: map.key,
        path: map.path,
        priority: map.priority || 6,
        destination: map.destination ?? 255,
        sourceAddress:
          map.sourceAddress ??
          cfg.defaultSourceAddress ??
          sourceAddress
      };
      const t = setInterval(() => sendOnce(sendCfg), interval);
      timers.push(t);
    });

    if (cfg.keepAliveEnabled !== false) {
      // Use 1000ms interval when emulated (matches signalk-bandg-performance-plugin)
      // Use 2000ms when not emulated
      const keepAliveInterval = cfg.emulate === true ? 1000 : 2000;
      timers.push(setInterval(() => sendKeepAlive(sourceAddress), keepAliveInterval));
    }

    app.emit("nmea2000OutAvailable"); // hint for bridges that we intend to send
    app.debug(`${plugin.name} started with ${timers.length} mapping timers${cfg.emulate === true ? " (H5000 emulation enabled)" : ""}`);
  };

  plugin.stop = function () {
    timers.forEach((t) => clearInterval(t));
    timers = [];
    if (pathRefreshTimer) {
      clearInterval(pathRefreshTimer);
      pathRefreshTimer = null;
    }
    if (simpleCan) {
      try {
        simpleCan.stop();
      } catch (e) {
        app.debug(`Error stopping SimpleCan: ${e.message}`);
      }
      simpleCan = null;
    }
    app.debug(`${plugin.name} stopped`);
  };

  return plugin;
};
