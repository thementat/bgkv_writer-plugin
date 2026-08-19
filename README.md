# @salishseasystems/signalk-bgkv

Signal K plugin for B&G proprietary PGN 130824 (key/value), in **both**
directions, plus optional H5000 CPU device emulation.

This plugin is the merge of the former `@salishseasystems/signalk-bgkv-writer`
and `@salishseasystems/signalk-bgkv-reader`. Both of those histories are
preserved in this repository.

## Why they were merged

The two plugins each carried their own transcription of the PGN 130824 wire
spec — `KEY_DEFS` in the writer, `KEY_MAP` in the reader — describing the same
keys with the same scales, widths and signedness. They had already drifted:
the writer flagged keys 80, 105, 109 and 311 as `bearing`, the reader only 105
and 109. A drift on `scale` or `signed` would have been silent in both
directions.

There is now one `KEY_DEFS` table. The encode side is driven by the user's
mappings; the decode side handles the rows marked `read: true`. Both read the
same `scale` / `bytes` / `signed` / `bearing` fields, and `test/roundtrip.test.js`
asserts that decode inverts encode for every decodable key — a test that could
not exist while the two halves lived in separate packages.

## The two halves

| Setting | Default | Effect |
| --- | --- | --- |
| `enableWriter` | `true` | Transmit the configured mappings as PGN 130824, plus the emulation PGNs |
| `enableReader` | `false` | Parse PGN 130824 off the bus and publish the known keys to Signal K |

The defaults reproduce the posture the separate plugins were left in: encode
on, decode off. Either half can run without the other.

### Self-echo guard

When both halves run and the encode side is emulating an H5000, our own
transmissions come back through the server's N2K pipeline. Decoding them would
republish, under this plugin's own `$source`, the values the encode side just
read from sailprocessor — putting the plugin into source arbitration against
its own inputs. The decode side therefore drops PGN 130824 whose source address
equals our claimed address (`ignoreOwnTransmissions`, default on).

The standalone reader could not do this: it had no way to learn which address
the writer had claimed. Frames from a *real* H5000 at a different address are
unaffected.

## Encode side

### Path conventions

Each mapping references the canonical Signal K path for the B&G key. No
`.sourced` / `.calculated` / `.filtered` / `.calibrated` path suffixes.

Per-mapping `sourceFilter` (schema field) pins the mapping to a specific
`$source`:

| Mapping option    | Behaviour                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| empty / unset     | Read the path via `app.getSelfPath` — server's default source resolution                           |
| `"sources-plugin"`| Ingest only deltas whose `$source === "sources-plugin"` for that path                              |
| `"sailprocessor.calibrated"` | Ingest only the calibrated-stage output from sailprocessor-plugin                       |

When any mapping declares a `sourceFilter`, the plugin registers an
`app.signalk.on('delta')` listener and maintains a per-(path, `$source`)
cache keyed on `${path}||${sourceFilter}`.

If no mapping contributes a value for a given send interval, the plugin
emits nothing rather than a padded empty PGN 130824 frame.

### PGN 130306 emission

When `emitWindPgn130306` is enabled (off by default), the plugin transmits
standard NMEA 2000 PGN 130306 (Wind Data) at 10 Hz with reference=Apparent.
The values come from `environment.wind.angleApparent` and
`environment.wind.speedApparent` via `app.getSelfPath` — configure SignalK
to prefer `sailprocessor-plugin` as the source for those paths so the
calibrated, back-calculated values are emitted.

The frame uses priority 2, broadcast (dst 0xFF), and the H5000 emulator's
claimed source address, which means it appears on the bus as a competing
source with the masthead unit. To get B&G displays / autopilot to use the
calibrated values, set the AWA / AWS data source on the Triton2 and the
H5000 pilot to point at the H5000 CPU (this plugin) instead of the wind
sensor.

Requires `emulate` enabled — without H5000 emulation the plugin falls back
to `app.emit('nmea2000out')` which emits under the canboatjs gateway's
source address, defeating the purpose.

## Decode side

Listens for canboat-style N2K JSON (`nmea2000Json`, `N2KAnalyzerOut`,
`n2kJson`) with `pgn: 130824`, parses the nibble-packed sequence of
(12-bit key, 4-bit length, `length` bytes of value), and publishes the known
keys as Signal K updates in SI units (rad, m/s, K, Pa, m).

If only raw 8-byte frames are present, ISO Fast-Packet frames are reassembled
before parsing. If canboat has already parsed the PGN — Manufacturer Code and
Industry Code appear as their own fields — `Data` is treated as an assembled
payload at any length.

The 23 decodable keys are those marked `read: true` in `KEY_DEFS`:

- `77/79` → `environment.wind.speedApparent` (m/s)
- `81` → `environment.wind.angleApparent` (rad)
- `85/86` → `environment.wind.speedTrue` (m/s)
- `89` → `environment.wind.angleTrueWater` (rad)
- `109` → `environment.wind.directionTrue` (rad, bearing)
- `65` → `navigation.speedThroughWater` (m/s)
- `235` → `navigation.speedOverGround` (m/s)
- `233` → `navigation.courseOverGroundTrue` (rad)
- `105` → `navigation.headingTrue` (rad, bearing)
- `28/29` → `environment.outside.temperature` (K)
- `30/31` → `environment.water.temperature` (K)
- `194/195/199` → `environment.depth.*` (m)
- `135` → `environment.outside.pressure` (Pa)
- `52/155` → `navigation.attitude.roll/pitch` (rad)
- `60` → `navigation.rateOfTurn` (rad/s)
- `130` → `navigation.leewayAngle` (rad)

### Decode configuration

- `readerEnabledKeys` — optional array of B&G key numbers to process. Empty or
  omitted processes all decodable keys.
- `readerContext` — Signal K context (default `vessels.self`).
- `readerSourceLabel` — label attached to updates (default `B&G 130824`).
- `ignoreOwnTransmissions` — see the self-echo guard above (default on).

## Bearing keys

Bearing-semantic keys are encoded on the wire as signed int16 at scale 0.0001,
so their range is ±π, while Signal K canonical bearing paths use [0, 2π). The
encode side applies `wrapPi` before encoding; the decode side applies the
inverse `(v + 2π) mod 2π` after scaling. Without the wrap, any bearing above
~187.7° encodes to raw 32767 — the SINT16 "data not available" sentinel — and
receivers fall back to last-good plus magnetic correction.

Rows currently flagged: 80, 105, 109, 311. See the `TODO(bearing-keys)` comment
in `index.js` for other bearing-like keys with the same latent issue, left
unflagged pending confirmation. Adding `bearing: true` to a row now fixes both
directions at once, and the round-trip test covers every flagged key
automatically.

## Notes and limitations

- 130824 is not fully reverse engineered; this plugin maps a practical subset
  commonly found on B&G systems.
- Some keys use "Excess-K" offset encoding in B&G docs. Where values were
  unambiguous (typical angles, speeds, temps), they are treated as two's
  complement numeric types per table hints.
- The decode side assumes the 2-byte proprietary header has been split off by
  the upstream parser. Payloads still carrying it will misparse.

## Testing

```
cd ~/.signalk/node_modules/@salishseasystems/signalk-bgkv
npm test
```
