# Schema

JSON Schema (draft-07) of everything the daemon serves, generated from its TypeScript types
(`src/schema/v0.ts`, `src/schema/recording.ts`) by `npm run schema`. Do not edit these files by
hand: `npm run build` fails when they no longer match the TypeScript. They ship in the npm package,
so a consumer finds them at `node_modules/abb-rws-daemon/schema/`.

| File | What it is | `$id` |
|---|---|---|
| `v0.schema.json` | The wire format of major line 0. Root: one `ControllerSnapshot`. Every type is under `definitions`: the snapshot and its groups, the stream frames (`StreamFrame` = `SnapshotFrame` \| `DeltaFrame` \| `RemovedFrame`), the HTTP answers and request bodies, `ErrorBody`. | `urn:abb-rws-daemon:schema:v0` |
| `history/v0.<n>.schema.json` | The same file as it was at version `0.<n>`. Frozen once the next version exists; `history/index.json` holds each file's sha256 (of its text with LF line ends). | `urn:abb-rws-daemon:schema:0.<n>` |
| `recording.schema.json` | The recording file format (JSON Lines: a header line, then records). Frame records refer to `StreamFrame` of `v0.schema.json`; every other type in it is its own (`Recorded*`), fixed by the format version, so a new snapshot minor does not change what a recording holds. | `urn:abb-rws-daemon:recording:<formatVersion>` |

## Versioning rule

- The daemon's schema version is `<major>.<minor>` (`SCHEMA_VERSION`, e.g. `0.13`). A snapshot frame
  and `GET /v0/controllers` carry it as `schemaVersion`; the schema file carries it as
  `x-schema-version`. File names and the main `$id` carry the major only, so their paths stay put.
- A new minor adds fields, types or routes. Inside `0.x` a change can still be breaking; every one
  is listed in `x-breaking` (`[{version, change}]`). A new major gets a file of its own beside this
  one (`v1.schema.json`).
- Objects are strict (`additionalProperties: false`), so validating strictly means "this version
  exactly". A consumer ignores fields and frame types it does not know, and validates strictly only
  against the version the data names: `history/v<schemaVersion>.schema.json` for a frame, a
  fixture or a recording (its header's `schemaVersion`).
- A minor is released when its entry in `history/index.json` has `released: true` (set when it
  ships). From then on its history file is frozen even while it is the daemon's current version:
  `npm run schema` refuses a wire change until `SCHEMA_VERSION` is raised.
- `schemaVersion` itself validates as a pattern (`^0\.[0-9]+$`), not as one value, so data of an
  older minor does not fail on that field alone.
- The recording format is versioned on its own (`formatVersion`, `x-format-version`); it changes
  only for a breaking change, and a reader refuses a version it does not know. To validate a
  recording line, register `history/v<header schemaVersion>.schema.json` under the id
  `urn:abb-rws-daemon:schema:v0` (the id `recording.schema.json` refers to frames by).

## Field meanings

Every property has a `description` taken from the TypeScript comments, and these keywords:

| Keyword | Meaning |
|---|---|
| `type: "integer"` | A whole number: sequence numbers, counts, ports, codes, lines, whole ms and bytes. Any other number is `type: "number"` (a float). |
| `x-unit` | The unit of a number: `mm`, `percent`, `Hz`, `ms`, `s`, `bytes`, `quaternion-wxyz`, or `count` / `none` for a number without a physical unit. |
| `x-unit-from` | The number's unit is given per object by the sibling property it names (joint values: `unit`). |
| `format: "date-time"` | ISO 8601 in UTC, ending in `Z`. |
| `maxItems` with `x-max-items-from` | A list capped by a constant: `maxItems` is the cap, `x-max-items-from` names the constant in `x-constants` (`IoGroup.signals`, `EventsGroup.recent`, `EventsPage.events`, `AccessGroup.locks`). |
| `x-ros-name` | The property's field name on the ROS side, in snake case (`observedAt` -> `observed_at`). A name that is a C, C++ or Python keyword is given another one with `@rosName` on the TypeScript side (`IdentityGroup.virtual` -> `is_virtual`), so a generator uses `x-ros-name` as it is. |
| `x-ros: "msg"` | A message root: it and every definition it refers to map to ROS messages. |
| `x-ros: "json"` | A free-form object (a refusal's details): carry it as JSON text. |
| `x-ros: "alias"` | A former name of another definition; skip it. |
| `x-constants` | The exported constants of the TypeScript module (list caps, timings, header names). |

Null and absent are different: a property missing from `required` may be absent; one whose type
includes `"null"` (or an `anyOf` with `{"type": "null"}`) is always present and may be null, which
means "not known" or "not read yet" as its description says.

## Units

| Field | Unit |
|---|---|
| `MotionJoint.value`, `.min`, `.max` | The joint's own `unit`: `deg` for a revolute axis, `mm` for a prismatic one, `null` when the controller did not say. Do not convert a joint whose unit is `null`. Radians and metres are not on the wire. |
| `MotionPose.x`, `.y`, `.z` | `mm` |
| `MotionPose.q` | Unitless quaternion `[q1, q2, q3, q4]` = `[w, x, y, z]`. ROS `geometry_msgs/Quaternion` is `x, y, z, w`: reorder. |
| `PanelGroup.speedRatio` | `percent`, 0 to 100 |
| `MotionRate.targetHz`, `.achievedHz`, `MotionWatch.targetHz` | `Hz` |
| `leaseMs`, `offsetMs`, `exitWithinMs`, `positionMs`, `durationMs` | `ms` |
| `uptimeS`, `durationS` | `s` |
| Recording sizes and limits | `bytes` |
| Every time (`asOf`, `observedAt`, `since`, `receivedAt`, `time.utc`, ...) | ISO 8601 UTC |

Controller texts are passed through as reported: `identity.startTime` and an event's `time.raw`
are the controller's local time without a zone, not ISO 8601; `time.utc` is the corrected UTC time.
Joint names are `J1`..`J6` for robot axes and `E1`..`E6` for external axes, per mechanical unit.

## Stream frames

A consumer applies one `snapshot` (the whole fleet), then each `delta` by replacing every group it
names whole (a delta for an unknown `id` adds that controller and carries every group), then
`removed` drops a controller. Link changes arrive at once, every one; other groups at most once per
250 ms per controller with the latest value; motion at most 4 frames a second.

## ROS 2 messages

A message generator reads `v0.schema.json` only:

| Schema | ROS 2 |
|---|---|
| definition with `x-ros: "msg"` and every object definition it reaches | one message of the same name; field order, comments and names from property order, `description`, `x-ros-name` |
| `string`; `enum` | `string`, plus constants `<FIELD>_<VALUE>` |
| reference (`$ref`, `allOf [$ref]`, `anyOf [$ref, null]`) to a named string enum (`Generation`, `LinkQuality`, ...) | `string`, plus constants `<FIELD>_<VALUE>`; empty when null. A named enum is never a message of its own. |
| nullable enum; nullable string | `string`, empty when null; plus `bool <name>_known` for a nullable string |
| `format: "date-time"` | `builtin_interfaces/Time` (nullable: plus `bool <name>_known`) |
| `number` | `float64`, unit in the comment; null as NaN |
| `integer` | `int64` (nullable: plus `bool <name>_known`) |
| `boolean`; nullable boolean | `bool`; `int8` (-1 unknown, 0, 1) |
| reference to an object definition; nullable | nested message; `<Msg>[<=1]` |
| array; with `maxItems` and `x-max-items-from` | `T[]`; `T[<=N]`, N = `maxItems` (e.g. `recent` <= `EVENTS_RECENT_MAX`) |
| tuple (`q`) | `float64[4]` |
| `x-ros: "json"` | `string` holding JSON text |

Version the generated messages by a hash of the definitions they map, not by the daemon's minor:
a minor that changes none of them changes nothing on the ROS side.

## Validating

The files use the keywords above beside the standard ones. Python's `jsonschema` ignores unknown
keywords. Ajv in strict mode needs them declared and union types allowed:

```js
new Ajv({ keywords: ['x-unit', 'x-unit-from', 'x-ros', 'x-ros-name', 'x-constants',
  'x-schema-version', 'x-format-version', 'x-breaking', 'x-max-items-from'], allowUnionTypes: true })
```

(`date-time` needs `ajv-formats`.) Refer to a type by `$id` and pointer, e.g.
`urn:abb-rws-daemon:schema:0.13#/definitions/StreamFrame`.
