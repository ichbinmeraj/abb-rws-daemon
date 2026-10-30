# Changelog

All notable changes to abb-rws-daemon are listed in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a new minor
version may change the routes under `/v0`. The snapshot schema has a version of its
own; see [schema/README.md](schema/README.md).

## [0.1.1] - 2026-10-30

A read of RAPID values. The daemon is still read-only: the new route reads, and
nothing changes on a controller.

### Added

- **RAPID values.**
  `GET /v0/controllers/:id/rapid/tasks/:task/modules/:module/symbols/:symbol` reads
  the value of one data symbol and answers it as the controller writes it, as RAPID
  text, with the controller resource it was read from and when. It is on the
  controller's read budget, as a module's source is. A value longer than 16384
  characters is cut there and says `truncated: true`. When the controller answers
  the read with no value at all, as it does for an array over its read limit and for
  a type with no printable value, the route gives 502 `VALUE_NOT_READ` and never an
  empty value. A symbol or a module the controller does not know gives 404
  `RESOURCE_NOT_FOUND`.
- **Snapshot schema 0.15.** It adds the answer type `RapidSymbolValue`. The snapshot
  and the stream frames are the same as in 0.14.
- **Recording and replay.** A recording keeps the value reads, and leaves out the
  value of a secret-named symbol. A replay answers the value route from the
  recording, and says so when the recording holds no value for that symbol.

### Changed

- abb-rws-client 1.5.3 (was 1.5.1).

## [0.1.0] - 2026-10-25

The first release. It is read-only: the daemon changes nothing on a controller.

### Added

- **The snapshot.** One typed `ControllerSnapshot` per controller, served by
  `GET /v0/controllers` and `GET /v0/controllers/:id`: identity, link, controller
  status, RAPID, motion, I/O and the event log, each group saying when it was last
  known to be current.
- **The stream.** `GET /v0/stream` (WebSocket) sends one snapshot frame, then a
  delta frame for the groups that changed and a frame for a controller that was
  removed.
- **One session per controller**, shared by every consumer, with reconnect and
  backoff and an identity check: a controller is known by its system id, a virtual
  controller that moved port is followed, and an address that answers as a
  different controller carries none of its values.
- **Setup.** Discovery (this PC, the service address, mDNS, named addresses and,
  only when asked, IPv4 ranges), a passport read (identity, licences and a
  compatibility verdict) before a controller is added, adding and removing
  controllers over HTTP, and saved discovery inputs.
- **Watch leases.** The fast motion sampling (joint positions and the TCP pose) and
  the reads of watched I/O signals run only while a consumer holds a lease; the
  client's regular status poll still reads joints and pose at its slower pace. Leases
  are per consumer, with caps per lease and per controller.
- **A read budget** per controller for reads on demand (a module's source, a signal
  search), so no consumer can crowd out the daemon's own sampling.
- **The event log.** Each controller's common event log, followed by subscription or
  by polling, with times corrected to UTC, and a route that pages through it.
- **An access token and loopback checks.** The daemon binds 127.0.0.1 only, every
  request but `GET /v0/health` carries a token kept in an owner-only file, and the
  `Host`, `Origin` and `Sec-Fetch-Site` headers are checked. `POST /v0/admin/shutdown`
  takes no browser request at all, the panel's origin included. At startup the daemon
  warns when other accounts can open the token file or the config file (which holds
  the controller passwords); on Linux also when either belongs to another account or
  sits in a folder other accounts can write to.
- **A clean stop.** Every stop signal and `POST /v0/admin/shutdown` run the same
  stop, which logs out of every controller within 8 s.
- **A recorder and a replay.** On request (`--record`, `POST /v0/recording/start`)
  a session is recorded to masked JSON Lines files; a daemon started with `--replay`
  serves a recording without reaching any controller, every link it serves saying
  `mode: "replay"` and `recordedAt` (live links say `mode: "live"`); and three tools
  in the source repository capture, compare and sanitize recordings. The
  operation-mode PIN of abb-rws-client 1.5.1's lock and unlock is masked in
  recordings and in the daemon's log.
- **A published schema.** `schema/v0.schema.json` (snapshot schema 0.14) and
  `schema/recording.schema.json`, with the unit of every number, the format of
  every time and each field's ROS name (`IdentityGroup.virtual` is `is_virtual`,
  since `virtual` is a C++ keyword).
- **Access, capabilities and freshness.** Three snapshot groups, and
  `link.downSince`: what a controller reports about its mastership (RobotWare 6 and
  7) or its write access (RobotWare 8) and about the RMMP privilege of the daemon's
  own session; what the daemon can read on a controller and how it arrives; and
  whether each group is current. The daemon reads this status and never requests or
  changes any of it. A holder is named, never identified. A status that could not be
  read or was not understood shows as an error, never as "nobody".
- **The FlexPendant as a holder, by either name.** A lock's `holder` has
  `flexPendant`: true when the controller names the holder as the FlexPendant.
  RobotWare 7 names the FlexPendant's own session as a `local` holder with the
  application `TPU` and RobotWare 8 as the station `FlexPendant`, so a consumer does
  not match either name itself to show the FlexPendant. Only these two forms count,
  as for the client's `isPendant`: a station named `TPU` is not the FlexPendant
  (neither it nor a `local` holder named `FlexPendant` has been seen). `name` and
  `application` still carry the controller's own words. The field is new in
  snapshot schema 0.14: a replay of a recording made with schema 0.13 serves its
  holders as recorded, without it.
- **The command line.** `--help` and `--version`, every option as a flag and some
  as an environment variable too, and strict parsing: an unknown option, a missing
  or empty value, a repeated option or a stray argument stops the daemon before it
  reads or makes anything. An empty environment variable counts as unset.

### Known limits

- Read-only. There is no write route, no write gate and no audit log.
- Tested on RobotStudio virtual controllers (RobotWare 6.16, 7.21, 8.1 and 8.2),
  not yet run against a real controller. Those runs used abb-rws-client's 1.4.0
  code. abb-rws-client 1.4.0 and 1.5.0 were prepared but not published. Their
  changes ship in abb-rws-client 1.5.1, the client this release installs, together
  with later fixes. With 1.5.1 the daemon passes its own tests.
- 2026-10-28: the packages as npm serves them, abb-rws-daemon 0.1.0 with
  abb-rws-client 1.5.1 and abb-rws-mcp 0.1.0 on top, ran against RobotStudio virtual
  controllers on RobotWare 6.16.03, 7.21.4 and 8.2.1. Every MCP tool and the prompt
  was called on each controller: 66 checks passed, none failed, and 3 were skipped
  because no program was running. The daemon logged out of every controller at the
  end.
- RobotWare 8: who holds write access is read with abb-rws-client 1.5.1's
  `RobotManager.getWriteAccessStatus()`. With an older client the lock is reported as
  not read, with that reason, the `write-access` capability and the `access` group as
  `unavailable`, and nothing is guessed.
- A controller's TLS certificate is not verified, and RWS 1.0 is plain HTTP: use
  the daemon on a network you trust.
- The routes under `/v0` may still change before 1.0.
- `--record` starts its recording about a second after the port opens: a health read
  in that second says `recording.active: false`.
- While a virtual controller re-binds to a new port, `link.qualityReason` can still
  name the old port for a moment after `link.port` shows the new one.
- A change of mastership or write access shows in the `access` group 3 to 6 s after
  it happens (it is polled).
- `identity.startTime` on RobotStudio virtual controllers reads as about the time it
  was read, not when the controller started.
- Removing a controller logs the removal, but not a logout that failed on the way.
- RWS 1.0: abb-rws-client 1.5.1 waits up to 10 s for a subscription create, and the
  session's other requests, the logout among them, wait behind it. If the controller
  does not answer a create, a stop that begins less than about 3.5 s after it was sent
  cannot log out of that controller in time (the logouts get 6.5 s of the stop's 8 s):
  the log says the logout did not finish, and the controller ends the session when it
  times it out.
- Not yet checked on a virtual controller: the holder shown while a FlexPendant holds
  mastership on RobotWare 6, a controller stopped and started while the daemon
  watches, and a real port move (a moved port was simulated). A FlexPendant holder was
  checked on RobotWare 7 and 8: it shows as `{kind: "local", application: "TPU"}`
  holding `edit` on RobotWare 7, and as the station `FlexPendant` holding write access
  on RobotWare 8, where `remoteAccessEnabled` reads false while it holds.
- The recording sanitizer (run from the source repository) takes login names from
  credentials, passport reads and the event codes 10400, 10401, 10040, 10064 and
  10140. A login name in any other event is replaced only when named with `--user`, and
  one shorter than 3 characters or a common word only where a whole text is that name.
