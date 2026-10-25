/**
 * ControllerSnapshot v0.1 - the groups served so far. The schema grows one
 * group at a time; the notes below say what each minor added.
 *
 * 0.5: failures keep the controller's own evidence. Every error body
 * (`ErrorBody`) and every error inside a group (`GroupError`: a motion unit's,
 * a watched signal's) gains `controller` - the HTTP status, code and message
 * the controller answered with - and `refusal`, the client's structured
 * account of a refusal where the client gives one. Both are additive and
 * absent when there is nothing to carry.
 *
 * 0.6: watch leases per consumer. A motion or I/O watch request may carry a
 * `leaseId` (`MotionWatchRequest`, `IoWatchRequest`): `"new"` opens a lease of
 * the caller's own, and the grant answers with its id in `leaseId`
 * (`MotionWatch`, `IoWatch`); renewals send that id. Each consumer's I/O set
 * is its own - the daemon watches the union, capped per controller
 * (IO_WATCH_MAX) and per consumer lease (IO_WATCH_LEASE_MAX), and one
 * consumer's lease running out takes out only the signals no other lease
 * holds. A request without a lease id renews the one shared anonymous lease
 * as before: every such request replaces its set, and it has no cap of its
 * own beyond the controller's. A controller holds at most WATCH_LEASES_MAX
 * leases with ids per kind of watch; a request that would open one more is
 * answered 429 `LEASE_LIMIT`. All additive: the request field and the answer
 * field are optional, and the snapshot's groups keep their shape.
 *
 * 0.7: reads on demand have a budget per controller. The routes that read
 * from a controller because a consumer asked - a module's source, a signal
 * search - share it: at most READS_IN_FLIGHT_MAX such reads are out at a time,
 * and together they make a few controller requests a second at most, so no
 * consumer can crowd out the daemon's own sampling. A request the budget has
 * no room for is answered 429 `READ_LIMIT` with a Retry-After. A request
 * identical to one in flight shares its answer, and an answer may be served
 * from memory for up to READ_CACHE_MS. Additive: the answers keep their shape.
 *
 * 0.8: an access token. Every request but `GET /v0/health` - the stream's
 * WebSocket upgrade included - carries the daemon's access token in the
 * TOKEN_HEADER header; a WebSocket consumer that cannot set headers offers it
 * as a subprotocol instead (TOKEN_PROTOCOL_PREFIX, next to STREAM_PROTOCOL).
 * The daemon makes the token once per install and keeps it in a file only
 * the account that runs it can open; a consumer reads it from there. A
 * request without it is answered 401 `TOKEN_MISSING`, one with another token
 * 401 `TOKEN_INVALID`. The shapes are unchanged; what changes is that a
 * consumer without the token is refused.
 *
 * 0.9: a stop over HTTP. `POST /v0/admin/shutdown` (`ShutdownAnswer`) stops
 * the daemon the way a stop signal does: it logs out of every controller,
 * closes, and exits within STOP_WAIT_MS. It is answered 202 before the stop
 * begins. It needs the access token like every route but health, and a
 * daemon that runs without one refuses it 403 `TOKEN_REQUIRED`. Stream
 * consumers still attached when a stop begins are closed with code 1001
 * (going away). Additive: no other shape changes.
 *
 * 0.10: the controller's event log. Every snapshot gains an `events` group
 * (`EventsGroup`): the newest EVENTS_RECENT_MAX messages of the controller's
 * common log as the daemon recorded them, how new ones reach the daemon
 * (`via`), the controller clock offset their times were corrected with
 * (`clock`), and when the list was last known complete. Each message
 * (`ControllerEvent`) keeps the controller's own time as it was reported and
 * that time in UTC, plus when the daemon received it, and has a number of the
 * daemon's own, `seq`, that orders it. `GET /v0/controllers/:id/events`
 * (`EventsPage`) serves the last EVENTS_KEEP_MAX per controller from memory,
 * by `seq` (`since`, `limit`). Additive: no other shape changes.
 *
 * 0.11: discovery through the client's findControllers. `POST
 * /v0/setup/discover` takes `manual` (addresses, each optionally with a port
 * and a scheme), `ranges` (IPv4, CIDR or dash), `ports` (extra ports),
 * `serviceAddress` and `mdns` (both default true) beside `hosts`, and answers
 * `notes` (plain sentences from the run) beside `entries`. Each entry gains
 * `name`: the host name the caller typed, when `host` is the address it
 * resolved to. Not additive: the source `entered` is now `manual`; `range` is
 * new. One run at a time (409 DISCOVERY_RUNNING), a run with ranges at most
 * once per RANGE_SCAN_INTERVAL_MS (429 DISCOVERY_LIMIT with Retry-After), and
 * input the client refuses is 400 INVALID_ARGUMENT naming `field`, `value`
 * and `limit`. Saved discovery inputs, which only pre-fill a scan: `GET` and
 * `PUT /v0/setup/discover/saved` (`DiscoverySettings`); `DELETE
 * /v0/setup/discover/saved` clears the addresses and ranges (the extra ports
 * stay), and `DELETE /v0/setup/discover/saved/manual?host&port&https`,
 * `/ranges?range` or `/ports?port` removes one entry by value (never by
 * position), each answering what is saved afterwards (404 NO_SAVED_ENTRY
 * when nothing equal is saved). A save the config file refuses is 503
 * NOT_SAVED.
 *
 * 0.12: recordings and replay. `GET /v0/health` is a schema type now
 * (`HealthAnswer`) and gains `mode` (`live` or `replay`), `recording` and
 * `replay`. The routes `GET /v0/recording`, `POST /v0/recording/start` and
 * `/stop` (live) and `GET /v0/replay`, `POST /v0/replay/control` (replay)
 * are new, with the codes RECORDING_ACTIVE (409), RECORDING_FAILED (503),
 * REPLAY_MODE (409) and NOT_RECORDED (404); see `DaemonMode`. The parts of a
 * snapshot and of a frame that had no name have one now (`LinkSubscriptions`,
 * `IdentityCheck`, `ReconnectInfo`, `MotionRate`, `EventArg`, `IoRejection`,
 * `DeltaGroups`, `SnapshotFrame`, `DeltaFrame`, `RemovedFrame`); the stream's
 * frames and every other shape are unchanged. Additive. The schema is also
 * published as JSON Schema (`schema/` in the package), with the unit of every
 * number and the format of every time.
 *
 * 0.13: access, capabilities and freshness. Every snapshot gains three groups.
 * `access` (`AccessGroup`): what the controller reports about its mastership
 * (RobotWare 6 and 7) or its control-station write access (RobotWare 8) - per
 * lock whether it is held and by whom - and the manual-mode privilege (RMMP)
 * of the daemon's own session. The daemon only reads this status; it never
 * requests, releases or changes any of it. `capabilities`
 * (`CapabilitiesGroup`): what the daemon can read on this controller and how
 * it arrives, derived from what the client reports. `freshness`
 * (`FreshnessGroup`): one line per group saying whether it is current, and
 * one level for the controller. `link` gains `downSince`, and `mode` (`live`
 * or `replay`) with `recordedAt`, so a snapshot says by itself whether it is
 * served from a recording. Additive: the other
 * groups, the frames and the routes keep their shape.
 *
 * 0.14: a lock's holder says whether it is the FlexPendant. `AccessHolder`
 * gains `flexPendant`: the controllers name the FlexPendant differently,
 * RobotWare 7 as the application `TPU` and RobotWare 8 as the station
 * `FlexPendant`, so a consumer reads this one field instead of matching
 * either name itself. Additive: `kind`, `name` and `application` keep their
 * meaning and still carry the controller's own words.
 *
 * @breaking 0.11 discovery source `entered` renamed `manual`
 */
export const SCHEMA_VERSION = '0.14' as const;

/**
 * The request header that carries the daemon's access token (added in schema
 * 0.8), on every request but `GET /v0/health`, the stream's WebSocket upgrade
 * included. The token is the whole content of the daemon's token file,
 * without surrounding whitespace: letters, digits, '-' and '_'.
 */
export const TOKEN_HEADER = 'x-abb-rws-token' as const;

/**
 * For a WebSocket consumer whose library cannot set a header on the upgrade:
 * the token offered as the subprotocol `${TOKEN_PROTOCOL_PREFIX}<token>`,
 * together with STREAM_PROTOCOL, e.g.
 * `Sec-WebSocket-Protocol: abb-rws.v0, abb-rws-token.<token>`. The daemon
 * selects STREAM_PROTOCOL and never echoes the token back. Offered without
 * STREAM_PROTOCOL it is refused with 400 BAD_REQUEST: the daemon could select
 * no subprotocol, and WebSocket clients fail a handshake that selects none of
 * those offered. Not for web pages: a page holding the token would hand it to
 * anyone who can load the page, so a browser consumer goes through a server
 * of its own that adds the header (as the panel's development server does).
 * Added in schema 0.8.
 */
export const TOKEN_PROTOCOL_PREFIX = 'abb-rws-token.' as const;

/** The stream's own subprotocol, selected when offered (see TOKEN_PROTOCOL_PREFIX). Added in schema 0.8. */
export const STREAM_PROTOCOL = 'abb-rws.v0' as const;

export type Generation = 'rws1' | 'rws2';
export type LinkQuality = 'live' | 'polling' | 'reconnecting' | 'stale' | 'disconnected';

/**
 * What the controller itself answered when it failed or refused a request, so
 * a consumer can show the controller's own code and words next to the
 * daemon's `code`. Present only when the controller's answer carried at least
 * one of the three; each is null when it carried that one not. Never carries
 * credentials or request headers: the message is the controller's error text
 * with anything credential-like masked, on one line, at most
 * CONTROLLER_MESSAGE_MAX characters. Added in schema 0.5.
 */
export interface ControllerAnswer {
  /**
   * The HTTP status the controller answered with (e.g. 403); null when no answer reached the daemon.
   * @integer
   * @unit none
   */
  httpStatus: number | null;
  /**
   * The controller's own status code from its error body (e.g. -1073445862); null when the body had none.
   * @integer
   * @unit none
   */
  code: number | null;
  /** The controller's own message from its error body; null when the body had none. */
  message: string | null;
}

/** The longest `ControllerAnswer.message` served; longer text is cut and ends in "...". */
export const CONTROLLER_MESSAGE_MAX = 500;

/**
 * The client's structured account of a refusal, in client releases that give
 * one: what kind of refusal it is, the condition that is missing, who can
 * grant it and what they do. Passed through as the client gives it, minus
 * every control-station id and anything credential-like (keys that name a
 * password, PIN, token, cookie or header). Only the fields named here are
 * described; the client may carry more. Added in schema 0.5.
 * @ros json
 */
export interface RefusalDetails {
  /** e.g. held-by-other, not-held, grant-missing, wrong-mode, wrong-state, unknown. */
  kind?: string;
  /** The missing condition, in plain words. */
  missing?: string;
  /** Who can lift it, e.g. pendant-operator, uas-administrator, current-holder. */
  grantor?: string;
  /** Who does what, and where, in plain words. */
  fix?: string;
  [field: string]: unknown;
}

/**
 * The JSON body of every failed request. `error` is a sentence for people;
 * `code` is for programs: the client's error code (RwsErrorCode) when the
 * controller failed or refused, otherwise one of the daemon's own -
 * NO_CONTROLLER, IDENTITY_MISMATCH, NOT_READY, ALREADY_ADDED, ID_TAKEN,
 * LEASE_LIMIT (added in schema 0.6), READ_LIMIT (added in schema 0.7),
 * TOKEN_MISSING and TOKEN_INVALID (HTTP 401, added in schema 0.8),
 * TOKEN_REQUIRED (HTTP 403, added in schema 0.9), DISCOVERY_RUNNING (409),
 * DISCOVERY_LIMIT (429), INVALID_ARGUMENT (400), NO_SAVED_ENTRY (404) and
 * NOT_SAVED (503) from the setup discovery routes (added in schema 0.11),
 * RECORDING_ACTIVE (409), RECORDING_FAILED (503), REPLAY_MODE (409) and
 * NOT_RECORDED (404) from recording and replay (added in schema 0.12),
 * HOST_NOT_ALLOWED,
 * ORIGIN_NOT_ALLOWED, CROSS_SITE_NOT_ALLOWED, BAD_REQUEST, NO_ROUTE, or
 * DAEMON_ERROR (a bug in the daemon, always HTTP 500).
 */
export interface ErrorBody {
  error: string;
  code: string;
  /** Added in schema 0.5. Absent when the failure carried no controller answer. */
  controller?: ControllerAnswer;
  /**
   * Added in schema 0.5. Absent unless the client described the refusal.
   * @ros json
   */
  refusal?: RefusalDetails;
}

/**
 * A failure inside a snapshot group (a motion unit's read, a watched
 * signal's): `code` and `message` as `ErrorBody.code` and `ErrorBody.error`,
 * and the same `controller` and `refusal` (added in schema 0.5).
 */
export interface GroupError {
  code: string;
  message: string;
  controller?: ControllerAnswer;
  /** @ros json */
  refusal?: RefusalDetails;
}

export interface RobotWareVersion {
  /** Exactly what the controller reported, e.g. "7.21.0+229" or "6.16.3007". */
  raw: string | null;
  /**
   * @integer
   * @unit none
   */
  major: number | null;
  /**
   * @integer
   * @unit none
   */
  minor: number | null;
  generation: Generation | null;
}

export interface IdentityGroup {
  controllerName: string | null;
  controllerId: string | null;
  /** As reported; the generations spell it differently ("Virtual Controller" / "VIRTUAL_CONTROLLER"). */
  controllerType: string | null;
  /**
   * Derived from controllerType; null when it is unrecognised.
   * @rosName is_virtual
   */
  virtual: boolean | null;
  mac: string | null;
  systemName: string | null;
  sysId: string | null;
  /**
   * As reported - not ISO 8601 on any generation seen so far. It is the
   * controller's local time, with no zone (live-verified 2026-09-29 on RW
   * 6.16.03, 7.21.4+417 and 8.2.1+1023). Not a restart marker: an RW 6.16.03
   * virtual controller (2026-09-29) reported a fixed start time for its first
   * hours, then the request time on every read, with no restart in between.
   */
  startTime: string | null;
  robotWare: RobotWareVersion;
  options: string[];
  /**
   * When the controller last actually re-read this group (it rides a slow poll).
   * @format date-time
   */
  asOf: string;
}

/** The link's subscription stream. */
export interface LinkSubscriptions {
  /** The controller's subscription stream is open and delivering. */
  active: boolean;
}

/**
 * Is the controller on this link the one that was added? `confirmed`: its
 * system id matches the configured one. `unverified`: one of the two ids is
 * not known yet. `mismatch`: it is a DIFFERENT controller - never act on it.
 */
export interface IdentityCheck {
  status: 'confirmed' | 'unverified' | 'mismatch';
  /** The system id the controller was added with; null when not known. */
  expected: string | null;
  /** The system id the controller on the link reports; null when not read yet. */
  actual: string | null;
}

/** While disconnected: how many reconnects have failed, and when the next one runs. */
export interface ReconnectInfo {
  /**
   * @integer
   * @unit count
   */
  failures: number;
  /** @format date-time */
  nextAttemptAt: string;
}

export interface LinkGroup {
  /**
   * The daemon holds a session the controller has answered on: true while
   * `quality` is `live`, `polling` or `stale`; false while a session is being
   * made or remade (`reconnecting`) and while there is none.
   */
  connected: boolean;
  quality: LinkQuality;
  qualityReason: string;
  /**
   * When the current `quality` began.
   * @format date-time
   */
  since: string;
  /**
   * While the link is not healthy: when it last was (`live` or `polling`), or,
   * for a controller never reached, when the daemon began trying. null while
   * the link is healthy. Unlike `since`, it does not move with each reconnect
   * attempt. Added in schema 0.13.
   * @format date-time
   */
  downSince: string | null;
  host: string;
  /**
   * The port in use now - follows a virtual controller that re-bound on restart.
   * @integer
   * @unit none
   */
  port: number;
  useHttps: boolean;
  subscriptions: LinkSubscriptions;
  /** Is the controller on this link the one that was added? */
  identityCheck: IdentityCheck;
  /** While disconnected: how many reconnects have failed, and when the next one runs. */
  reconnect: ReconnectInfo | null;
  /**
   * Where this link's values come from: `live`, a session the daemon holds
   * now; `replay`, a recording a replaying daemon serves, with no controller
   * reached. In replay every other link field (`quality`, `connected`, ...)
   * is as recorded, so a consumer labels the link by this field, never by
   * `quality` alone. A replay of a recording made before schema 0.13 serves
   * its links as recorded, without this field. Added in schema 0.13.
   */
  mode: DaemonMode;
  /**
   * In replay: when the recorded session began (the recording header's
   * `sessionStartedAt`), not moved by the replay's time shift. null live.
   * Added in schema 0.13.
   * @format date-time
   */
  recordedAt: string | null;
}

/**
 * Controller status. Values as the controller reports them; known values:
 * ctrlState  init | motoroff | motoron | guardstop | emergencystop | emergencystopreset | sysfail
 * opMode     AUTO | MANR (manual reduced speed) | MANF (manual full speed)
 * collisionDetection  INIT | TRIGGERED | CONFIRMED | TRIGGERED_ACK
 */
export interface PanelGroup {
  ctrlState: string | null;
  opMode: string | null;
  /**
   * Percent, 0-100.
   * @unit percent
   */
  speedRatio: number | null;
  collisionDetection: string | null;
  /**
   * When these values were last known to be current. They are pushed by the
   * controller on change, so while the link is `live` or `polling` this is
   * "now"; when the link degrades it freezes at the last healthy moment. null
   * if the link has never been healthy.
   * @format date-time
   */
  asOf: string | null;
}

/**
 * Where a RAPID task is: the program pointer (the next instruction to run) or
 * the motion pointer (the instruction the robot is moving on). `line` is the
 * 1-based source row as the controller reports it.
 */
export interface RapidPointer {
  module: string;
  routine: string | null;
  /**
   * @integer
   * @unit none
   */
  line: number | null;
}

export interface RapidTaskInfo {
  name: string;
  /** Task type as reported (NORMAL, STATIC, SEMISTATIC; the case varies by generation). */
  type: string;
  /** The task's own state as reported (e.g. initiated, uninitiated, linked). */
  taskState: string | null;
  execState: 'running' | 'stopped' | null;
  /** Selected in the task panel (only active tasks run). */
  active: boolean;
  /** Drives a mechanical unit. */
  motion: boolean;
  /** Module names as the controller lists them; empty until read. */
  modules: string[];
  /** null: no program pointer (no program loaded), or not read yet. */
  pp: RapidPointer | null;
  /** null while the task is not moving, or not read yet. */
  mp: RapidPointer | null;
}

/**
 * RAPID execution. Execution state and cycle are pushed by the
 * controller; tasks and modules ride the client's slow poll; the pointers are
 * read by the daemon (every second while a task runs, otherwise every few
 * seconds, and at once when execution changes).
 */
export interface RapidGroup {
  execState: 'running' | 'stopped' | null;
  /** once | forever | asis | oncedone, as reported. */
  cycle: string | null;
  tasks: RapidTaskInfo[];
  /**
   * Same meaning as `panel.asOf`.
   * @format date-time
   */
  asOf: string | null;
}

/**
 * One axis of a mechanical unit. Values as RWS reports them: degrees for a
 * revolute axis, millimetres for a prismatic one (RWS converts from the SI
 * values - radians, metres - the controller stores). `unit` null: not known.
 */
export interface MotionJoint {
  /** 'J1'..'J6' for the robot axes (rax_1..6), 'E1'..'E6' for external axes (eax_a..f). */
  name: string;
  /**
   * In `unit`; null when not read yet.
   * @unitFrom unit
   */
  value: number | null;
  /** deg (revolute) or mm (prismatic); null: not known, so a consumer must not convert the values. */
  unit: 'deg' | 'mm' | null;
  /**
   * Lower / upper limit in the same unit; null when the daemon cannot read it.
   * @unitFrom unit
   */
  min: number | null;
  /** @unitFrom unit */
  max: number | null;
}

export interface MotionPose {
  /**
   * TCP position in mm.
   * @unit mm
   */
  x: number;
  /** @unit mm */
  y: number;
  /** @unit mm */
  z: number;
  /**
   * Orientation quaternion [q1, q2, q3, q4] = [w, x, y, z].
   * @unit quaternion-wxyz
   */
  q: [number, number, number, number];
  tool: string | null;
  wobj: string | null;
  /** The frame the pose is given in (Wobj, Base, World, Tool), as reported. */
  coord: string | null;
}

export interface MotionUnitInfo {
  /** Mechanical unit, e.g. ROB_1. */
  name: string;
  /** robot for a TCP robot, positioner / external otherwise; null when the type is unknown. */
  kind: 'robot' | 'positioner' | 'external' | null;
  /** The mechanical unit type as reported (e.g. TCPRobot). */
  typeRaw: string | null;
  /** The RAPID task that drives this unit; null when none or unknown. */
  task: string | null;
  joints: MotionJoint[];
  /** TCP pose for a robot unit; null for others or before the first read. */
  pose: MotionPose | null;
  /**
   * The unit's last joint read failed, so `joints` are the last good values
   * (or empty) - or, while no joint is reported at all, its description read
   * failed. Never set by a failed pose read alone: the pose then keeps its
   * last value (or stays null) while the joints go on being current.
   */
  error: GroupError | null;
}

/**
 * Motion. Joint positions are not subscribable on any generation
 * (no subscription resource carries them), so the daemon polls them - but
 * only while a consumer holds a watch lease
 * (`POST /v0/controllers/:id/motion/watch`); otherwise nothing is sampled and
 * `watching` is false. One sampler per controller serves every consumer:
 * `watching` is true while any consumer's lease runs (since schema 0.6 each
 * consumer may hold its own, `leaseId`). Joints at `rate.targetHz`, the pose
 * at a quarter of that; both ride the controller's own session, whose request
 * spacing keeps the controller under its 20 req/s ceiling. The target drops
 * while the link is `polling` (the manager's own polls then use ~12 req/s, as
 * measured on virtual controllers). The stream coalesces this group like
 * `panel` (at most 4 frames/s).
 */
export interface MotionGroup {
  watching: boolean;
  units: MotionUnitInfo[];
  rate: MotionRate;
  /**
   * When the positions were last read; frozen when sampling stops or the link degrades.
   * @format date-time
   */
  asOf: string | null;
}

/** How often the motion sampler reads (named in schema 0.12). */
export interface MotionRate {
  /**
   * The rate the sampler aims at; null when not sampling.
   * @unit Hz
   */
  targetHz: number | null;
  /**
   * Measured over the last few seconds; null when not sampling.
   * @unit Hz
   */
  achievedHz: number | null;
  via: 'poll' | null;
}

/**
 * One watched I/O signal. `name` is the signal's controller-wide name exactly
 * as `listAllSignals` / the watch request named it. `value` is raw, as the
 * controller reports it ('1', '0', an analog number as text) - the daemon
 * passes values through by design.
 */
export interface IoWatchedSignal {
  name: string;
  /** DI | DO | AI | AO | GI | GO as reported; null before the first read. */
  type: string | null;
  value: string | null;
  /**
   * How this signal's updates arrive: `subscription` (pushed on change,
   * RWS 2.0 with a live stream) or `poll` (read on a cadence - RWS 1.0, or
   * any link whose stream is down). null before the watch first serves it.
   */
  via: 'subscription' | 'poll' | null;
  /**
   * When this value was last confirmed current; null before the first read.
   * @format date-time
   */
  asOf: string | null;
  /** The signal's last read/subscribe failed (e.g. no such signal). Value keeps its last good state. */
  error: GroupError | null;
}

/**
 * I/O. Signals are watched behind the same lease pattern as motion
 * (`POST /v0/controllers/:id/io/watch`): nothing is subscribed or polled until
 * a consumer asks, and a lapsed lease releases the signals again. The watch
 * list is capped (`IO_WATCH_MAX`); the full signal table is served by
 * `GET /v0/controllers/:id/io/signals` (search), not by this group.
 *
 * Since schema 0.6 each consumer may hold a lease of its own (`leaseId`), and
 * `signals` is the union of every lease's set: a consumer picks out the names
 * its own grant accepted. A consumer's lease that runs out while another is
 * still held takes out only the signals no other lease holds; when the last
 * one runs out, the whole set stays listed with its last values, `watching`
 * false.
 */
export interface IoGroup {
  /** A consumer holds a lease - any consumer, not necessarily the reader. */
  watching: boolean;
  /**
   * The watched signals, every lease's together: at most IO_WATCH_MAX.
   * @maxItems IO_WATCH_MAX
   */
  signals: IoWatchedSignal[];
  /**
   * When a value was last confirmed; frozen when the lease lapses or the link degrades.
   * @format date-time
   */
  asOf: string | null;
}

/**
 * The most signals watched on one controller, every consumer's lease
 * together (`IoGroup.signals`): a watch is a working set, not a mirror of the
 * whole I/O table, which search serves.
 */
export const IO_WATCH_MAX = 24;

/**
 * When a controller event happened. The controllers seen so far report their
 * clock's reading without a zone ("2026-07-09 T 01:29:56"), in whatever zone
 * and with whatever error the controller's clock is set to. The daemon reads
 * the controller's clock on every new connection and every CLOCK_REFRESH_MS,
 * against its own UTC time, and shifts each event's time by that offset (see
 * `EventClock`) - good to about a second, the clocks' resolution.
 */
export interface EventTime {
  /** Exactly what the controller reported; null when it reported nothing. */
  raw: string | null;
  /**
   * `raw` in UTC (ISO 8601). With `corrected` true: shifted by the controller
   * clock's offset. With it false no offset was known when the event was
   * recorded, and this is the controller's reading taken as if its clock ran
   * on UTC - off by its zone and its error. null when `raw` could not be
   * read as a date and time.
   * @format date-time
   */
  utc: string | null;
  /**
   * `utc` was corrected with the controller clock's offset. An event recorded
   * before the clock could be read is corrected once it is (this turns true).
   */
  corrected: boolean;
}

/** One value the controller substitutes into an event message (named in schema 0.12). */
export interface EventArg {
  /** The type the controller declares ('long', 'string', ...). */
  type: string;
  value: string;
}

/**
 * One message of a controller's event log (added in schema 0.10), from its
 * common log (domain 0).
 */
export interface ControllerEvent {
  /**
   * The daemon's number for this event on this controller: 1 for the first it
   * recorded, one more for each after, in the controller's order. It orders
   * events and is the cursor of `GET .../events?since=`. It starts again at 1
   * when the daemon starts or the controller is added again - `feed` changes
   * then too.
   * @integer
   * @unit none
   */
  seq: number;
  /**
   * The controller's own sequence number, as reported; null when it reported
   * none. RWS 1.0 counts it in 16 bits, so after 65,535 it starts again:
   * order by `seq`, not by this.
   * @integer
   * @unit none
   */
  seqnum: number | null;
  /**
   * The event code, e.g. 10205 (null when none was reported).
   * @integer
   * @unit none
   */
  code: number | null;
  /** From the controller's message type: 1 info, 2 warning, 3 error; null for any other. */
  severity: 'info' | 'warning' | 'error' | null;
  /**
   * The controller's title. A controller whose message text is missing (a
   * language not installed, for one) still reports the code: the title is
   * then "Event <code>" and `titleFromCode` says so.
   */
  title: string;
  /** The controller sent no title; `title` was made from `code`. */
  titleFromCode: boolean;
  /** The message's parts, as the controller wrote them; each null when it sent none. At most EVENT_TEXT_MAX characters each. */
  description: string | null;
  causes: string | null;
  consequences: string | null;
  actions: string | null;
  /**
   * The values the controller substitutes into the message, in order, each
   * with the type it declares ('long', 'string', ...). Empty when none; at
   * most 16, each value at most 256 characters.
   */
  args: EventArg[];
  /** The subsystem that raised it (e.g. MC0); null when not reported. */
  source: string | null;
  time: EventTime;
  /**
   * When the daemon received it (UTC, ISO 8601).
   * @format date-time
   */
  receivedAt: string;
  /**
   * The message was already in the log when the daemon first read it (at the
   * daemon's start, or when the controller was added): `receivedAt` is when
   * the daemon read it, not when it happened. A consumer that alerts on new
   * events skips these.
   */
  backlog: boolean;
}

/** How a controller's event times are corrected (added in schema 0.10). */
export interface EventClock {
  /**
   * The daemon's UTC time minus the controller clock's reading, in ms, as last
   * measured: the controller's zone and its clock's error together. Events are
   * corrected with it. null: never measured, and event times are not corrected.
   * @integer
   * @unit ms
   */
  offsetMs: number | null;
  /**
   * When `offsetMs` was measured (UTC); null when never.
   * @format date-time
   */
  measuredAt: string | null;
  /**
   * Why the clock was not measured the last time it was tried - the client
   * cannot read it, the read failed, or the reading was no date and time; null
   * when the last try succeeded. With an older `offsetMs` still given, that
   * one is used meanwhile.
   */
  problem: string | null;
}

/**
 * The controller's event log (added in schema 0.10). The daemon
 * reads it on every connection, then follows it: while the link's event
 * subscription is live the controller announces each new message and the log
 * is read again; while none delivers, the daemon reads the log itself every
 * few seconds. Messages are de-duplicated across those reads and across
 * reconnects, and numbered in the controller's order (`seq`). The daemon
 * keeps the last EVENTS_KEEP_MAX per controller; this group carries the
 * newest EVENTS_RECENT_MAX of them, and `GET /v0/controllers/:id/events` the
 * rest. Before a link to a controller with a known system id is confirmed,
 * nothing is read from it: recorded events outlive the link.
 */
export interface EventsGroup {
  /**
   * Names the numbering `seq` belongs to. It changes when the daemon starts or
   * the controller is added again, and `seq` starts again at 1: a consumer
   * holding a cursor from another feed starts over. null while this group
   * carries nothing (a link on the WRONG controller).
   */
  feed: string | null;
  /**
   * The `seq` of the newest event recorded; 0 before the first. A consumer that has read up to a lower one fetches the rest with `since`.
   * @integer
   * @unit none
   */
  lastSeq: number;
  /**
   * The newest events, oldest first, at most EVENTS_RECENT_MAX.
   * @maxItems EVENTS_RECENT_MAX
   */
  recent: ControllerEvent[];
  /**
   * How new messages reach the daemon now: `subscription` (the controller
   * announces each one), `poll` (the daemon reads the log every few seconds,
   * because no subscription delivers), or null while it cannot read the log
   * (the link is down or degraded, or not yet confirmed to be the controller
   * that was added).
   */
  via: 'subscription' | 'poll' | null;
  clock: EventClock;
  /**
   * When the list was last known complete: while `via` is `subscription` and
   * the log has been read since the stream began, now (every new message is
   * announced); otherwise the last successful read. Frozen once the link
   * degrades. null before the first read.
   * @format date-time
   */
  asOf: string | null;
  /** The daemon's last read of the log failed; null once a read succeeds. */
  error: GroupError | null;
}

/**
 * One controller as the daemon serves it: every group, each with its own
 * freshness. The root of the exported schema, and the ROS message of the
 * same name.
 * @ros msg
 */
export interface ControllerSnapshot {
  id: string;
  name: string;
  /** null until the controller has been read at least once. */
  identity: IdentityGroup | null;
  link: LinkGroup;
  panel: PanelGroup;
  /** Added in schema 0.2. Empty tasks until the controller has been read. */
  rapid: RapidGroup;
  /** Added in schema 0.3. `watching` false and no values until a consumer watches. */
  motion: MotionGroup;
  /** Added in schema 0.4. `watching` false and no signals until a consumer watches. */
  io: IoGroup;
  /** Added in schema 0.10. No events until the log has been read. */
  events: EventsGroup;
  /** Added in schema 0.13. Nothing read until the controller is connected. */
  access: AccessGroup;
  /** Added in schema 0.13. */
  capabilities: CapabilitiesGroup;
  /** Added in schema 0.13. */
  freshness: FreshnessGroup;
}

/** The most events the daemon keeps per controller; the oldest go first. Added in schema 0.10. */
export const EVENTS_KEEP_MAX = 256;

/** The most events the snapshot's `events` group carries (the newest). Added in schema 0.10. */
export const EVENTS_RECENT_MAX = 20;

/** The most events one `GET .../events` answers with (`limit`). Added in schema 0.10. */
export const EVENTS_PAGE_MAX = EVENTS_KEEP_MAX;

/** How many events `GET .../events` answers with when the request names no `limit`. Added in schema 0.10. */
export const EVENTS_PAGE_DEFAULT = 50;

/** The longest text an event field carries (title, description, causes, consequences, actions); longer text is cut and ends in "...". Added in schema 0.10. */
export const EVENT_TEXT_MAX = 1_000;

/** How often (ms) the daemon measures a controller clock's offset again on the same connection. Added in schema 0.10. */
export const CLOCK_REFRESH_MS = 10 * 60_000;

/**
 * `GET /v0/controllers/:id/events` (added in schema 0.10), answered from the
 * daemon's memory: no request reaches the controller. Without `since`: the
 * newest `limit` events. With it: the events after that `seq`, oldest first,
 * at most `limit` - page on with `since` set to the last one's `seq` while
 * `more` is true. A `since` from another `feed` (a cursor kept across a
 * daemon restart) means nothing here: start over without it.
 */
export interface EventsPage {
  feed: string;
  /**
   * The oldest `seq` still held; 0 when none is.
   * @integer
   * @unit none
   */
  firstSeq: number;
  /**
   * The newest `seq` recorded; 0 before the first.
   * @integer
   * @unit none
   */
  lastSeq: number;
  /** Events after `since` were dropped from memory before this read: the page starts later than `since` + 1. */
  gap: boolean;
  /** More events follow this page. */
  more: boolean;
  /**
   * Oldest first; at most `limit`, which is at most EVENTS_PAGE_MAX.
   * @maxItems EVENTS_PAGE_MAX
   */
  events: ControllerEvent[];
}

/**
 * The `leaseId` a watch request sends to open a lease of its own (added in
 * schema 0.6). Any other lease id a consumer sends should be one a grant
 * returned to it; the form is letters, digits, '-' and '_', at most 64
 * characters, and anything else is refused with 400 BAD_REQUEST.
 *
 * Without a `leaseId` a request renews the one lease every such request
 * shares (anonymous: any of them renews it, and for I/O each one replaces its
 * set). With one, the lease is the caller's alone. An id is the consumer's to
 * keep: the same id may serve its motion and its I/O watch, on every
 * controller, and an id whose lease has run out (or that a restarted daemon
 * no longer knows) opens that lease again under the same id, empty but for
 * what the request asks.
 */
export const NEW_LEASE = 'new' as const;

/** The most leases with an id one controller holds at a time, per kind of watch (motion, I/O). Added in schema 0.6. */
export const WATCH_LEASES_MAX = 32;

/**
 * `POST /v0/controllers/:id/motion/watch` body - optional: a request with no
 * body renews the anonymous lease (added in schema 0.6).
 */
export interface MotionWatchRequest {
  /** `NEW_LEASE`, or the id a grant returned. Absent: the shared anonymous lease. */
  leaseId?: string;
}

/** `POST /v0/controllers/:id/motion/watch` - start or renew a watch lease. */
export interface MotionWatch {
  /**
   * The lease lasts this long; renew it at least every leaseMs / 2.
   * @integer
   * @unit ms
   */
  leaseMs: number;
  /**
   * The rate the sampler aims at while the lease runs.
   * @unit Hz
   */
  targetHz: number;
  /** The lease's id, to send with every renewal; absent for the anonymous lease. Added in schema 0.6. */
  leaseId?: string;
}

/** `POST /v0/controllers/:id/io/watch` body (`leaseId` added in schema 0.6). */
export interface IoWatchRequest {
  /** The signals this lease watches; replaces what it watched before. An empty list leaves the lease holding none. */
  signals: string[];
  /** `NEW_LEASE`, or the id a grant returned. Absent: the shared anonymous lease. */
  leaseId?: string;
}

/** A signal an I/O watch request named and the daemon refused, and why (named in schema 0.12). */
export interface IoRejection {
  name: string;
  reason: string;
}

/**
 * `POST /v0/controllers/:id/io/watch` - start or renew an I/O watch lease.
 * The request REPLACES the set of the lease it renews (idempotent renew: send
 * the same list); other consumers' leases are untouched. The daemon watches
 * the union of every lease's set. Refused names come back in `rejected`, with
 * the reason.
 */
export interface IoWatch {
  /**
   * The lease lasts this long; renew it at least every leaseMs / 2.
   * @integer
   * @unit ms
   */
  leaseMs: number;
  /** The signals this lease now watches, in the order it asked for them. */
  accepted: string[];
  /**
   * Requested signals the daemon refused, and why: not an I/O signal name, not
   * in the controller's signal table, over the lease's own cap
   * (IO_WATCH_LEASE_MAX; leases with an id only), or over the controller's cap
   * (IO_WATCH_MAX, every lease's signals together - a signal another lease
   * already watches never counts against it).
   */
  rejected: IoRejection[];
  /** The lease's id, to send with every renewal; absent for the anonymous lease. Added in schema 0.6. */
  leaseId?: string;
}

/**
 * The most reads on demand (a module's source, a signal search) one
 * controller has out at a time, every consumer together. A request identical
 * to one out shares it and never counts; one more is answered 429
 * `READ_LIMIT`. Added in schema 0.7.
 */
export const READS_IN_FLIGHT_MAX = 2;

/**
 * How long (ms) the answer to a read on demand - a module's source, a signal
 * search - may be served from memory to a request identical to the one that
 * read it. Within that time an answer can be that much older than the
 * controller. Added in schema 0.7.
 */
export const READ_CACHE_MS = 2_000;

/**
 * `GET /v0/controllers/:id/rapid/tasks/:task/modules/:module`. On the
 * controller's read budget (schema 0.7): may be up to READ_CACHE_MS old, and
 * answered 429 `READ_LIMIT` when the budget has no room.
 */
export interface RapidModuleSource {
  task: string;
  module: string;
  /**
   * program | system, when the controller says; null otherwise. Read from the
   * task's module listing, which the daemon keeps while the connection and
   * the task's module list stay the same.
   */
  kind: 'program' | 'system' | null;
  /** The module's RAPID source, lines separated by "\n". */
  text: string;
  /**
   * Increases whenever the module changes on the controller; null when not reported.
   * @integer
   * @unit count
   */
  changeCount: number | null;
}

/**
 * The longest a stop takes (ms), from the stop signal or the shutdown
 * request to the process's exit, however many controllers are configured
 * and however slow any of them answers. The logouts run side by side and get
 * most of it; a logout still out when they have had their share is given up
 * (the controller ends that session when it times out). A service wrapper
 * should allow the daemon at least this long before it ends the process
 * itself. Added in schema 0.9.
 */
export const STOP_WAIT_MS = 8_000;

/**
 * `POST /v0/admin/shutdown` (added in schema 0.9), answered 202 before the
 * daemon stops as it does on a stop signal: stream consumers are closed with
 * code 1001, every controller is logged out, the server closes and the
 * process exits, within STOP_WAIT_MS of the stop's start. The daemon's log
 * names each controller and what became of its session. Needs the access
 * token; a daemon that runs without one refuses it 403 `TOKEN_REQUIRED`.
 * The request has no body.
 */
export interface ShutdownAnswer {
  /** Always true: the daemon is stopping. */
  stopping: true;
  /** A stop was already under way (a signal, or an earlier request); this request started nothing new. */
  alreadyStopping: boolean;
  /**
   * The process exits at the latest this many ms after this answer.
   * @integer
   * @unit ms
   */
  exitWithinMs: number;
}

/** Former name, kept while call sites migrate. */
export type ControllerSummary = ControllerSnapshot;

export interface ControllerList {
  schemaVersion: typeof SCHEMA_VERSION;
  /** @format date-time */
  observedAt: string;
  controllers: ControllerSnapshot[];
}

/** The groups a delta frame may carry (`events` added in schema 0.10; `access`, `capabilities` and `freshness` in schema 0.13). */
export type GroupName = 'identity' | 'link' | 'panel' | 'rapid' | 'motion' | 'io' | 'events' | 'access' | 'capabilities' | 'freshness';

/**
 * `WS /v0/stream` frames. A consumer applies a `snapshot`, then each `delta`
 * by replacing the named groups whole. Link changes are sent immediately and
 * every one of them; other groups are coalesced over 250 ms, so a consumer
 * sees the latest value, not every intermediate one.
 */
export type StreamFrame = SnapshotFrame | DeltaFrame | RemovedFrame;

/** The first frame on every stream: every controller, whole (named in schema 0.12). */
export interface SnapshotFrame {
  type: 'snapshot';
  schemaVersion: typeof SCHEMA_VERSION;
  /** @format date-time */
  observedAt: string;
  controllers: ControllerSnapshot[];
}

/**
 * The groups a delta frame carries (named in schema 0.12): each one present
 * replaces that group of the controller whole. A controller's first delta
 * (one the consumer does not know yet) carries every group.
 */
export interface DeltaGroups {
  identity?: IdentityGroup | null;
  link?: LinkGroup;
  panel?: PanelGroup;
  rapid?: RapidGroup;
  motion?: MotionGroup;
  io?: IoGroup;
  events?: EventsGroup;
  access?: AccessGroup;
  capabilities?: CapabilitiesGroup;
  freshness?: FreshnessGroup;
}

/** Groups of one controller changed (named in schema 0.12). */
export interface DeltaFrame {
  type: 'delta';
  /** @format date-time */
  observedAt: string;
  id: string;
  name: string;
  groups: DeltaGroups;
}

/** A controller was removed (named in schema 0.12). */
export interface RemovedFrame {
  type: 'removed';
  /** @format date-time */
  observedAt: string;
  id: string;
}

// --- 0.12: health, recording and replay (recorder unit) ---

/**
 * Whether the daemon reads controllers (`live`) or replays a recording
 * (`replay`). A replaying daemon reads no config, holds no controller session
 * and reaches no controller: it serves the recording's frames, on the
 * recording's schedule, as if they were live. Added in schema 0.12.
 *
 * Routes added in schema 0.12, all needing the access token (and refused 403
 * `TOKEN_REQUIRED` by a daemon that runs without one):
 * `GET /v0/recording` (`RecordingStatus`), `POST /v0/recording/start`
 * (`RecordingStartRequest` -> 201 `RecordingStatus`), `POST /v0/recording/stop`
 * (-> `RecordingStatus`; stopping when none runs is not an error);
 * `GET /v0/replay` (`ReplayStatus`) and `POST /v0/replay/control`
 * (`ReplayControlRequest` -> `ReplayStatus`), served only in replay mode (404
 * `NO_ROUTE` in live mode). Error codes added: `RECORDING_ACTIVE` (409, a
 * recording already runs), `RECORDING_FAILED` (503, the recording folder or
 * file cannot be made, or a limit is already exceeded), `REPLAY_MODE` (409,
 * the route would reach a controller and the daemon is replaying) and
 * `NOT_RECORDED` (404, the recording holds no answer to this request). A start
 * request with a value out of bounds is 400 `BAD_REQUEST`.
 */
export type DaemonMode = 'live' | 'replay';

/**
 * What a recording holds: `frames` (the `/v0/stream` frames as consumers
 * received them), `calls` (every client method the daemon called, with its
 * arguments, result or error and duration, and every raw I/O subscription
 * event it consumed), `state` (changes of the client's state the daemon was
 * told of). Added in schema 0.12.
 */
export type RecordingContent = 'frames' | 'calls' | 'state';

/**
 * Why a recording, or one part of it, ended: `stopped` (asked to stop),
 * `duration` (its duration ran out), `size-limit` (it reached
 * `maxTotalBytes`), `dir-limit` (the recordings folder reached
 * `maxDirBytes`), `disk-space` (free space fell below `minFreeBytes`),
 * `writer-behind` (the disk did not keep up), `mask-check` (a frame still held
 * a known secret after masking), `error` (a write failed), `daemon-stop` (the
 * daemon stopped), `rotated` (a part reached `maxFileBytes` and the recording
 * goes on in the next part), `closed` and `interrupted` (a stream capture: the
 * daemon closed the stream, or the capture was interrupted). Added in schema
 * 0.12.
 */
export type RecordingEndReason =
  | 'stopped' | 'duration' | 'size-limit' | 'dir-limit' | 'disk-space' | 'writer-behind' | 'mask-check' | 'error'
  | 'daemon-stop' | 'rotated' | 'closed' | 'interrupted';

/** Where recordings are written: the per-user default folder, or one given with `--record-dir`. Added in schema 0.12. */
export type RecordingFolder = 'default' | 'custom';

/** The limits a recording runs under (see `RecordingStartRequest`). Added in schema 0.12. */
export interface RecordingLimits {
  /**
   * A part reaching this size is closed and the recording goes on in a new part.
   * @integer
   * @unit bytes
   */
  maxFileBytes: number;
  /**
   * The recording stops (`size-limit`) when all its parts together reach this.
   * @integer
   * @unit bytes
   */
  maxTotalBytes: number;
  /**
   * The recording does not start, or stops (`dir-limit`), when every recording in the folder together reaches this.
   * @integer
   * @unit bytes
   */
  maxDirBytes: number;
  /**
   * The largest line other than a frame; a larger result or value is replaced by its size.
   * @integer
   * @unit bytes
   */
  maxRecordBytes: number;
  /**
   * The recording does not start, or stops (`disk-space`), below this much free space.
   * @integer
   * @unit bytes
   */
  minFreeBytes: number;
  /**
   * The recording stops (`duration`) after this long.
   * @integer
   * @unit s
   */
  durationS: number;
}

/**
 * Limits a start request may set. Each may only tighten the daemon's own
 * (`maxFileBytes`, `maxTotalBytes`, `maxDirBytes`, `maxRecordBytes` take the
 * smaller value, `minFreeBytes` the larger); a value outside the daemon's
 * bounds is refused 400. Added in schema 0.12.
 */
export interface RecordingLimitsRequest {
  /**
   * @integer
   * @unit bytes
   */
  maxFileBytes?: number;
  /**
   * @integer
   * @unit bytes
   */
  maxTotalBytes?: number;
  /**
   * @integer
   * @unit bytes
   */
  maxDirBytes?: number;
  /**
   * @integer
   * @unit bytes
   */
  maxRecordBytes?: number;
  /**
   * @integer
   * @unit bytes
   */
  minFreeBytes?: number;
}

/** `POST /v0/recording/start` body; every field optional. Added in schema 0.12. */
export interface RecordingStartRequest {
  /** Part of the file names: lowercase letters, digits and '-', at most 32 (RECORDING_LABEL_PATTERN). */
  label?: string;
  /** What to record; default all three. Not empty. */
  content?: RecordingContent[];
  /**
   * How long to record; at most the daemon's own duration (default 3600 s).
   * @integer
   * @unit s
   */
  durationS?: number;
  limits?: RecordingLimitsRequest;
}

/** Records left out because the disk did not keep up, by kind. Frames are never left out. Added in schema 0.12. */
export interface RecordingDropped {
  /**
   * @integer
   * @unit count
   */
  call: number;
  /**
   * @integer
   * @unit count
   */
  state: number;
  /**
   * @integer
   * @unit count
   */
  sub: number;
}

/**
 * What masking did: the known secret values masked wherever they occur
 * (`values`, plus their encoded forms `derived`), those too short or too
 * common to mask by value (`weakValues`: still masked by key and by shape),
 * the records masking changed, the keys it dropped, and the lines it refused
 * to write because a secret survived masking. Added in schema 0.12.
 */
export interface RecordingMasking {
  /**
   * @integer
   * @unit count
   */
  values: number;
  /**
   * @integer
   * @unit count
   */
  derived: number;
  /**
   * @integer
   * @unit count
   */
  weakValues: number;
  /**
   * @integer
   * @unit count
   */
  maskedRecords: number;
  /**
   * @integer
   * @unit count
   */
  droppedKeys: number;
  /**
   * @integer
   * @unit count
   */
  refusedLines: number;
}

/**
 * `GET /v0/recording`, and the answer to start and stop: the recording
 * running now, or the last one. File names are base names; the folder is
 * named only as `default` or `custom` (the daemon's log has the path). Added
 * in schema 0.12.
 */
export interface RecordingStatus {
  active: boolean;
  /** The recording's name: its file names without `-p<part>.jsonl`. null before the first recording. */
  session: string | null;
  label: string | null;
  content: RecordingContent[];
  /** @format date-time */
  startedAt: string | null;
  /**
   * When the recording stops by its duration; null when none runs.
   * @format date-time
   */
  endsAt: string | null;
  /** @format date-time */
  endedAt: string | null;
  folder: RecordingFolder | null;
  /** The parts written so far, oldest first. */
  files: string[];
  /**
   * @integer
   * @unit count
   */
  records: number;
  /**
   * @integer
   * @unit bytes
   */
  bytes: number;
  dropped: RecordingDropped;
  masking: RecordingMasking;
  /** The limits in force; null before the first recording. */
  limits: RecordingLimits | null;
  /** Why the last recording ended; null while it runs or before the first. */
  endReason: RecordingEndReason | null;
  /** What went wrong, in plain words, when a recording could not start or stopped on an error. */
  error: string | null;
}

/** The recording part of `GET /v0/health`. Added in schema 0.12. */
export interface RecordingHealth {
  active: boolean;
  /**
   * When the running recording started; null when none runs.
   * @format date-time
   */
  since: string | null;
}

/** Where a replay is: playing, paused, or at the end of the recording (without loop). Added in schema 0.12. */
export type ReplayState = 'playing' | 'paused' | 'ended';

/**
 * How a replay serves times: `shifted` moves every time by the same amount so
 * values are as old as they were at that point of the recording; `recorded`
 * serves them as recorded. Added in schema 0.12.
 */
export type ReplayTimeMode = 'shifted' | 'recorded';

/** The replay part of `GET /v0/health` (null in live mode). Added in schema 0.12. */
export interface ReplayHealth {
  state: ReplayState;
  /**
   * The position in the recording.
   * @integer
   * @unit ms
   */
  positionMs: number;
  /**
   * The recording's length (the time of its last frame).
   * @integer
   * @unit ms
   */
  durationMs: number;
  /**
   * Playback speed, 1 = as recorded (REPLAY_SPEED_MIN to REPLAY_SPEED_MAX).
   * @unit none
   */
  speed: number;
  loop: boolean;
  /**
   * How often the replay has started over.
   * @integer
   * @unit count
   */
  loops: number;
  /**
   * When the recording was made.
   * @format date-time
   */
  recordedAt: string;
  time: ReplayTimeMode;
}

/** `GET /v0/replay` and `POST /v0/replay/control` (replay mode only). Added in schema 0.12. */
export interface ReplayStatus {
  state: ReplayState;
  /**
   * @integer
   * @unit ms
   */
  positionMs: number;
  /**
   * @integer
   * @unit ms
   */
  durationMs: number;
  /** @unit none */
  speed: number;
  loop: boolean;
  /**
   * @integer
   * @unit count
   */
  loops: number;
  /** @format date-time */
  recordedAt: string;
  time: ReplayTimeMode;
  /** The recording's files being replayed (base names), in part order. */
  files: string[];
  session: string;
  label: string | null;
  /** Who made the recording: `daemon` or `stream-capture`. */
  source: string;
  /** The snapshot schema version the recording was made with; it is served as recorded. */
  recordedSchemaVersion: string;
  /** The daemon version that made the recording, as its header gives it. */
  daemonVersion: string | null;
  /** The client version the recording's daemon used, as its header gives it. */
  clientVersion: string | null;
  /**
   * Gaps in the recording (records left out while it was made).
   * @integer
   * @unit count
   */
  gaps: number;
}

/** What `POST /v0/replay/control` does: play, pause, send the next frame at once, or start over. Added in schema 0.12. */
export type ReplayAction = 'play' | 'pause' | 'step' | 'restart';

/** `POST /v0/replay/control` body. Added in schema 0.12. */
export interface ReplayControlRequest {
  action: ReplayAction;
  /**
   * A new playback speed, REPLAY_SPEED_MIN to REPLAY_SPEED_MAX.
   * @unit none
   */
  speed?: number;
}

/** `GET /v0/health`, the one route that needs no token (`mode`, `recording` and `replay` added in schema 0.12). */
export interface HealthAnswer {
  status: 'ok';
  /** The daemon's version. */
  version: string;
  /** @format date-time */
  startedAt: string;
  /**
   * @integer
   * @unit s
   */
  uptimeS: number;
  mode: DaemonMode;
  recording: RecordingHealth;
  /** null in live mode. */
  replay: ReplayHealth | null;
}

/** A recording label: lowercase letters, digits and '-', 1 to 32 characters. Added in schema 0.12. */
export const RECORDING_LABEL_PATTERN = '^[a-z0-9-]{1,32}$';

/** The slowest replay speed. Added in schema 0.12. */
export const REPLAY_SPEED_MIN = 0.1;

/** The fastest replay speed. Added in schema 0.12. */
export const REPLAY_SPEED_MAX = 50;

// --- end recorder unit ---

// --- 0.13: access, capabilities, freshness ---

/**
 * The RobotWare generation whose access rules a controller follows, as the
 * client determined it when it connected: `rw6` (RobotWare 6), `rw7`
 * (RobotWare 7) or `rw8` (RobotWare 8). Not the protocol generation of
 * `identity.robotWare.generation` (`rws1` / `rws2`): RobotWare 7 and 8 both
 * speak RWS 2.0. Added in schema 0.13.
 */
export type AccessGeneration = 'rw6' | 'rw7' | 'rw8';

/**
 * What a controller arbitrates writes with: `mastership` (RobotWare 6: the
 * domains cfg, motion and rapid; RobotWare 7: edit and motion) or
 * `writeaccess` (RobotWare 8: one control-station write access for
 * everything). Added in schema 0.13.
 */
export type AccessModel = 'mastership' | 'writeaccess';

/** One lock a controller arbitrates (see `AccessModel`). Added in schema 0.13. */
export type AccessLockName = 'cfg' | 'motion' | 'rapid' | 'edit' | 'writeaccess';

/**
 * Who holds a lock, as far as the controller says. `local`: a local client,
 * normally the FlexPendant (the controller only says `local`). `remote`: a
 * remote client. `internal`: the controller itself. `station`: a control
 * station (RobotWare 8). A holder is named, never identified: no user id and
 * no control-station id is served, logged or recorded. Added in schema 0.13.
 */
export interface AccessHolder {
  kind: 'local' | 'remote' | 'internal' | 'station';
  /** RobotWare 8: the holding control station's name, as the controller reports it; null when it reports none, and on RobotWare 6 and 7. */
  name: string | null;
  /** RobotWare 6 and 7: the application name the controller reports for the holder; null when it reports none, and on RobotWare 8. */
  application: string | null;
  /** Whether the holder is the FlexPendant, by the name the controller gives it, in the two forms seen: true for a `local` holder whose application is `TPU` (RobotWare 7's name for the FlexPendant's own session) and for a `station` named `FlexPendant` (RobotWare 8), in any case; false for a holder of another name (a station named `TPU` too) and for a `remote` or `internal` holder; null when the controller names no application or station. A consumer shows a holder with true as the FlexPendant, whichever name the controller used. Added in schema 0.14. */
  flexPendant: boolean | null;
}

/**
 * One lock of a controller, as its own status reports it. `held`, `holder`
 * and `asOf` always belong to the same reading: the last one the daemon read
 * and understood on this connection. An answer that was empty, of an unknown
 * form or not understood is a failed read (`error`), never "nobody holds it".
 * Added in schema 0.13.
 */
export interface AccessLockInfo {
  lock: AccessLockName;
  /** Someone holds the lock (true) or nobody does (false), as the controller said at `asOf`; null while no status was read and understood on this connection. A reading, never a promise: it can change the moment after it was read. */
  held: boolean | null;
  /** Who holds it; null when nobody does, when the controller does not say, or when `held` is null. */
  holder: AccessHolder | null;
  /** Whether the daemon's own session holds the lock, from the client's own record of what this session requested, not from the controller's status. A daemon without write routes never requests a lock, so this is false; null when the client is not sure. */
  heldByDaemon: boolean | null;
  /** RobotWare 6 and 7: the status word of the most recent answer that carried one, as the client handed it over, for example `nomaster`, `local`, `remote` or `internal`. While `error` says the status was not understood, this is the word that was not understood, or, when that answer carried no word at all, the word of the answer before it; `held` and `holder` are still those of the last good read. null on RobotWare 8 and until an answer carried a word. */
  reported: string | null;
  /**
   * When this lock's status was last read and understood on this connection; null until then. Kept, not advanced, while reads fail or the link is down.
   * @format date-time
   */
  asOf: string | null;
  /** The last read of this lock's status failed or was not understood; `held`, `holder` and `asOf` keep what the last good read gave. null once a read succeeds. */
  error: GroupError | null;
}

/**
 * The RMMP privilege words this daemon knows: `none`, a request waiting for
 * the operator (`pending modify`, `pending exec`), or a granted privilege
 * (`modify`, `exec`). Added in schema 0.13.
 */
export type RmmpPrivilege = 'none' | 'pending modify' | 'pending exec' | 'modify' | 'exec';

/**
 * RMMP, the privilege a remote client needs before it may write in a manual
 * mode on RobotWare 6 and 7. Added in schema 0.13.
 */
export interface RmmpInfo {
  /** Whether this controller offers RMMP, as the client and the controller report it: true once a privilege was read on this connection; false on RobotWare 8 (nothing is sent) and when the controller answered that it does not offer the service; null until one of them is known. */
  supported: boolean | null;
  /** The privilege of the daemon's own session as the controller reported it at `asOf`. The daemon never requests it. null where RMMP is not offered and until a privilege was read and understood on this connection. */
  privilege: RmmpPrivilege | null;
  /**
   * When the privilege was last read and understood on this connection; null until then and where RMMP is not offered.
   * @format date-time
   */
  asOf: string | null;
  /** The last read failed or was not understood; null once one succeeds. */
  error: GroupError | null;
}

/**
 * Access (added in schema 0.13): what the controller itself reports about
 * who may write to it. The daemon reads this status every ACCESS_READ_MS
 * (ACCESS_READ_SLOW_MS while the link is `polling`), at once on a new
 * connection, and sooner than booked when a link recovers or the operating
 * mode changes, though on one connection never twice within ACCESS_READ_MS.
 * What was read on an earlier connection is cleared when the link is usable
 * again, so every value here was read on the present connection or, while
 * the link is down, on the last one. The daemon only reads: it never
 * requests, releases or changes mastership, write access, RMMP or a
 * control-station registration. Nothing here says that a write would
 * succeed: the controller decides every write when it arrives.
 */
export interface AccessGroup {
  /** The generation as the client determined it from what the controller reported when it connected; null until then, and for the whole connection when the controller reported no RobotWare version the client could use. */
  generation: AccessGeneration | null;
  model: AccessModel | null;
  /**
   * One entry per lock of the generation (RobotWare 6: cfg, motion, rapid; RobotWare 7: edit, motion; RobotWare 8: writeaccess); empty until the generation is known.
   * @maxItems ACCESS_LOCKS_MAX
   */
  locks: AccessLockInfo[];
  /** RobotWare 8: the controller's own "external control enabled" flag (remote access, switched at the FlexPendant), as its write-access status reported it with the last good read of the lock. null on RobotWare 6 and 7, until that read, and when the status did not carry the flag. */
  remoteAccessEnabled: boolean | null;
  rmmp: RmmpInfo;
  /** `poll` while the daemon is reading at least one part of the status on this link; null while it reads none (the link is down, degraded or on the wrong controller, the generation is not known, or `problem` is set). */
  via: 'poll' | null;
  /** Why no part of the status is read on this controller (a status the client cannot read, such as RobotWare 8 write access with a client older than 1.4.0; a controller that reported no usable RobotWare version); null otherwise. */
  problem: string | null;
  /**
   * The oldest `asOf` of its parts (each lock; RMMP unless the controller does not offer it): every part is at least this current. null while a part has not been read and understood on this connection.
   * @format date-time
   */
  asOf: string | null;
}

/** The most locks one controller has (RobotWare 6: cfg, motion, rapid). Added in schema 0.13. */
export const ACCESS_LOCKS_MAX = 3;

/** How often (ms) the daemon reads a controller's access status while the link is `live`. Added in schema 0.13. */
export const ACCESS_READ_MS = 5_000;

/** How often (ms) it reads it while the link is `polling`. Added in schema 0.13. */
export const ACCESS_READ_SLOW_MS = 15_000;

/**
 * What a capability entry is about. `status-push`: controller status and
 * RAPID execution state are pushed by the controller. `events-push`: new
 * event-log messages are announced by the controller. `event-times`: event
 * times are corrected to UTC. `io-push`: watched I/O signals arrive by
 * subscription. `io-table`: the signal table lists every signal.
 * `joint-limits`: joints carry their unit and limits. `mastership`,
 * `write-access`, `rmmp`: that part of `access` can be read. Added in schema 0.13.
 */
export type CapabilityId =
  | 'status-push' | 'events-push' | 'event-times' | 'io-push' | 'io-table' | 'joint-limits'
  | 'mastership' | 'write-access' | 'rmmp';

/**
 * `available`: it works on this controller now. `unavailable`: it cannot work
 * on this connection: not on this controller, not in this daemon release, or
 * not with this client release (`reason` says which). `degraded`: it should work, and it does not at the
 * moment or only in part (the last attempt failed, or the controller's event
 * stream is lost and may come back). `unknown`: not determined yet on this
 * connection. Added in schema 0.13.
 */
export type CapabilityState = 'available' | 'unavailable' | 'degraded' | 'unknown';

/** One row of a controller's capability table. Added in schema 0.13. */
export interface Capability {
  id: CapabilityId;
  state: CapabilityState;
  /** Why, in plain words, when the state is not `available`; null when it is. */
  reason: string | null;
}

/**
 * Capabilities (added in schema 0.13): what the daemon can read on this
 * controller and how it arrives. Every row is derived from what the client
 * reports (the protocol, and the generation as the client determined it from
 * the reported RobotWare version) and from the outcome of the daemon's own
 * reads.
 */
export interface CapabilitiesGroup {
  /** The protocol the link speaks; null while not connected. */
  protocol: Generation | null;
  /** Same value as `access.generation`. */
  generation: AccessGeneration | null;
  /** The RobotWare version exactly as the controller reported it; null until read. */
  robotWare: string | null;
  /** The RobotWare major.minor is one this daemon was tested against; null while the version is not known. */
  tested: boolean | null;
  /** One row per `CapabilityId`, in that order; empty for a link on the wrong controller. */
  entries: Capability[];
  /**
   * Same meaning as `panel.asOf`.
   * @format date-time
   */
  asOf: string | null;
}

/**
 * How a controller stands as a whole. `current`: the link is healthy and no
 * group is stale or failing in part. `degraded`: the link is `stale`, or a
 * group is stale or failing in part (a group that is only waiting for the
 * first read of some of its parts does not count). `down`: there is no link
 * (`disconnected` or `reconnecting`). `wrong-controller`: the link answers as
 * a different controller and carries none of its values. Added in schema 0.13.
 */
export type FreshnessLevel = 'current' | 'degraded' | 'down' | 'wrong-controller';

/**
 * How one group stands. `current`: being refreshed, last read good.
 * `partial`: some of its parts are current and some are failing or unread.
 * `stale`: it holds values that are no longer refreshed (the link is not
 * healthy, or its last read failed); `asOf` says since when. `idle`: nothing
 * is watched, by design (no watch lease). `unread`: not read yet on this
 * connection; a read is expected. `unavailable`: it cannot be read on this
 * controller with this client, and no read is being tried (`reason` says
 * why). `withheld`: the link is on a different controller, so the group
 * carries nothing. Added in schema 0.13.
 */
export type GroupFreshnessState = 'current' | 'partial' | 'stale' | 'idle' | 'unread' | 'unavailable' | 'withheld';

/** The groups `freshness` reports on. Added in schema 0.13. */
export type FreshGroupName = 'identity' | 'panel' | 'rapid' | 'motion' | 'io' | 'events' | 'access';

/** One group's freshness. Added in schema 0.13. */
export interface GroupFreshness {
  group: FreshGroupName;
  state: GroupFreshnessState;
  /**
   * That group's own `asOf` (null when it has none yet).
   * @format date-time
   */
  asOf: string | null;
  /** Why, in plain words, when the state is not `current`; null when it is. Never holds a time or a counter. */
  reason: string | null;
}

/**
 * Freshness (added in schema 0.13): whether what the snapshot shows is
 * current, said once for the controller and once per group, so a consumer
 * needs no thresholds of its own. It is worked out from the other groups of
 * the same snapshot and changes only when one of them does.
 */
export interface FreshnessGroup {
  level: FreshnessLevel;
  /** One plain sentence per cause while the level is not `current`; empty when it is. */
  reasons: string[];
  /** One entry per `FreshGroupName`, in that order. */
  groups: GroupFreshness[];
}

