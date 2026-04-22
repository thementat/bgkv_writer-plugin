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

## Testing

```
cd ~/.signalk/node_modules/bgkv_writer-plugin
npm test
```
