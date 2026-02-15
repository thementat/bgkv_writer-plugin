B&G Key/Value Reader (PGN 130824)

This Signal K plugin decodes B&G proprietary key/value data carried in NMEA2000 PGN 130824 (0x1FF08) and maps common keys into Signal K paths.

What it does
- Listens for canboat-style N2K JSON with `pgn: 130824`.
- Parses the nibble-packed sequence of entries: 12-bit key, 4-bit length, followed by `length` bytes of value.
- Converts a subset of known keys to Signal K updates using SI units (rad, m/s, K, Pa, m).
 - If only raw 8-byte frames are present (no assembled Data array), the plugin reassembles ISO Fast-Packet frames for PGN 130824 and then parses the resulting payload.

Mapped keys (examples)
- `77/79` → `environment.wind.speedApparent` (m/s)
- `81` → `environment.wind.angleApparent` (rad)
- `85/86` → `environment.wind.speedTrue` (m/s)
- `89` → `environment.wind.angleTrueWater` (rad)
- `65` → `navigation.speedThroughWater` (m/s)
- `235` → `navigation.speedOverGround` (m/s)
- `233` → `navigation.courseOverGroundTrue` (rad)
- `105` → `navigation.headingTrue` (rad)
- `28/29` → `environment.outside.temperature` (K)
- `30/31` → `environment.water.temperature` (K)
- `194/195/199` → `environment.depth.*` (m)
- `135` → `environment.outside.pressure` (Pa)
- `52/155` → `navigation.attitude.roll/pitch` (rad)
- `60` → `navigation.rateOfTurn` (rad/s)
- `130` → `navigation.leewayAngle` (rad)

Install
1. Place this folder in `signalk-server-node/plugins/` or add it via the server’s plugin UI.
2. Ensure your server produces canboat-style N2K JSON events (e.g., from a connected NMEA2000 interface).

Configuration
- `enabledKeys` Optional array of B&G key numbers to process. If empty/omitted, the plugin processes all known keys.
- `context` Signal K context (default: `vessels.self`).
- `sourceLabel` Label attached to updates (default: `B&G 130824`).

Notes and limitations
- 130824 is not fully reverse engineered; this plugin maps a practical subset commonly found on B&G systems.
- Some keys use “Excess-K” offset encoding in B&G docs. Where values were unambiguous (typical angles, speeds, temps), the plugin treats them as two’s complement numeric types per table hints. If you have captures showing offsets for specific keys, please open an issue or PR.
- The plugin can consume: a fully-assembled byte array in one of `fields.Data`, `fields.data`, `fields.Bytes`, `fields.bytes`; or raw 8-byte frames found there (or at top level `data/bytes`) that will be reassembled via ISO Fast Packet.

Development
- Entry point: `index.js`
- Package metadata: `package.json`
