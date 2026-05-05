# bgkv_writer-plugin

Signal K plugin that encodes local values into B&G proprietary PGN 130824
(key/value) and transmits them on the NMEA 2000 bus, with optional H5000
CPU emulation.

## Path conventions

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

## PGN 130306 emission

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

## Testing

```
cd ~/.signalk/node_modules/bgkv_writer-plugin
npm test
```
