# abb-rws-daemon

A local daemon that reads ABB robot controllers over Robot Web Services and serves
each one as a typed, versioned `ControllerSnapshot` over HTTP and WebSocket on
127.0.0.1. It covers RWS 1.0 (IRC5, RobotWare 6) and RWS 2.0 (OmniCore, RobotWare 7
and 8) and holds the one session per controller, so every consumer on the PC reads
the same state instead of opening a session of its own. It is built on
[abb-rws-client](https://github.com/ichbinmeraj/abb-rws-client), and it is
read-only: it changes nothing on a controller.

> **Status:** 0.1.0. Read-only. Tested on RobotStudio virtual controllers; not yet
> run against a real controller. Snapshot schema 0.14. The routes under `/v0` may
> still change before 1.0. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

**Read-only today.** The daemon logs in to a controller, reads, subscribes to its
own subscription group, and logs out. It has no route that changes a controller, and
it never requests mastership, write access or RMMP. It is not a motion driver and
sends no jog or motion command. What it does change, on request, is its own state:
its config file (a controller added or removed, saved discovery inputs), watch
leases and recordings.

**Planned, not built:** a write gate (read-only by default; writes opt-in per
surface and per action, passing a mastership-aware gate) and an audit log of every
write.

## Install and run

You need Node.js 22 or later, on Windows or Linux. macOS follows the Linux paths
and is untested.

Run it without installing it:

```sh
npx abb-rws-daemon@0.1.0 --config ./abb-rws-daemon.config.json
```

Or install the command once and run that:

```sh
npm install -g abb-rws-daemon@0.1.0
abb-rws-daemon --config ./abb-rws-daemon.config.json
```

The daemon listens on http://127.0.0.1:7810 and logs to its terminal. Ctrl+C stops
it and logs out of every controller (see
[Stopping and running as a service](#stopping-and-running-as-a-service)).
`abb-rws-daemon --help` lists every option and `abb-rws-daemon --version` prints the
versions.

**Where the config file is.** Without `--config` the daemon uses
`abb-rws-daemon.config.json` in the folder it was started in. A file that does not
exist is not an error: the daemon starts with no controllers, and the file is
created there, with the controller passwords in it, the first time a controller is
added (or discovery inputs are saved). Start the daemon from a folder only your
account can write to, or name the file with `--config`.

**Where the access token is.** On its first start the daemon makes its access token
and logs the name of the file it keeps it in: `%APPDATA%\abb-rws-daemon\token` on
Windows, `~/.config/abb-rws-daemon/token` on Linux (under `$XDG_CONFIG_HOME` when
that is set). Every request but `GET /v0/health` needs it (see
[Access token](#access-token)).

### From source

Node.js 22 or later, and git.

```sh
git clone https://github.com/ichbinmeraj/abb-rws-daemon.git
cd abb-rws-daemon
npm install
npm run build
node dist/cli.js --config ./abb-rws-daemon.config.json
```

`npm start` runs `node dist/cli.js`, `npm run dev` builds first, and `npm test` runs
the tests (none of them contacts a controller).

## First requests

```sh
curl http://127.0.0.1:7810/v0/health
TOKEN=$(cat ~/.config/abb-rws-daemon/token)
curl -H "x-abb-rws-token: $TOKEN" http://127.0.0.1:7810/v0/controllers
```

In PowerShell:

```powershell
curl.exe http://127.0.0.1:7810/v0/health
$token = Get-Content "$env:APPDATA\abb-rws-daemon\token"
curl.exe -H "x-abb-rws-token: $token" http://127.0.0.1:7810/v0/controllers
```

A daemon without controllers answers an empty list. Add one over HTTP, or list it in
the [config file](#config-file) before starting:

```sh
curl -X POST -H "x-abb-rws-token: $TOKEN" -H "content-type: application/json" \
  -d '{"host":"192.168.125.1","port":443,"useHttps":true,"username":"<user>","password":"<password>"}' \
  http://127.0.0.1:7810/v0/controllers
```

The answer (201) is the new controller's snapshot, with the `id` the daemon gave it;
`GET /v0/controllers/<id>` serves it from then on, and `GET /v0/stream` (WebSocket)
sends every change. An IRC5 speaks RWS 1.0 over plain HTTP: `"port": 80,
"useHttps": false`. A password typed on a command line stays in the shell's history;
a consumer's setup screen (`POST /v0/setup/discover`, `POST /v0/setup/passport`,
then `POST /v0/controllers`) or the config file avoids that.

## Config file

```json
{
  "controllers": [
    {
      "id": "cell-1", "name": "Cell 1",
      "host": "192.168.125.1", "port": 443, "useHttps": true,
      "username": "<user>", "password": "<password>"
    }
  ]
}
```

`id` is lowercase letters, digits and hyphens; `name` may be left out. The daemon
adds `systemId` once it has read the controller, and saves the new port when a
confirmed controller moves.

The file holds controller passwords. The daemon saves it in one step, through a
temporary file beside it (so the file's folder must be writable by the daemon's
account), and owner-only: mode 0600; on Windows restricted to the current user and
SYSTEM. It warns at startup when other accounts can open the file (see
[Security notes](#security-notes)). A file that is not valid JSON, or has an invalid
entry, stops the daemon at launch with a message that says what is wrong (for an
entry, which field) and never quotes the file.

The file may also hold discovery inputs to pre-fill a setup scan, under `discovery`:
addresses (`manual`, each `{ host, port?, https? }`, at most 16), IPv4 ranges
(`ranges`, at most 16) and extra ports (`ports`, at most 8). The daemon never scans
them on its own; a consumer reads them with `GET /v0/setup/discover/saved` and sends
them in a scan when its user asks, and removes one of them (by value) or every
address and range with `DELETE`. Saving the controllers keeps them, and every other
key the daemon does not own.

```json
{
  "controllers": [],
  "discovery": { "manual": [{ "host": "cell-7", "port": 443 }], "ranges": ["10.0.5.20-10.0.5.60"] }
}
```

## Options and exit codes

`abb-rws-daemon --help` (or `-h`) prints the options, and `abb-rws-daemon --version`
(or `-v`) prints the daemon's version, its snapshot schema version, the
abb-rws-client version and the Node.js version. Both exit at once with code 0:
nothing is started, read or made.

| Option | Environment variable | Default, and what it is |
|---|---|---|
| `--config <file>` | `ABB_RWS_DAEMON_CONFIG` | `abb-rws-daemon.config.json` in the folder the daemon is started in: the controllers and their credentials |
| `--port <n>` | `ABB_RWS_DAEMON_PORT` | `7810` |
| `--panel-origins <list>` | `ABB_RWS_DAEMON_PANEL_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173`: the comma-separated origins (scheme, host and port) browser pages may call the daemon from, besides its own. Replaces the defaults |
| `--allowed-hosts <list>` | `ABB_RWS_DAEMON_ALLOWED_HOSTS` | none: host names accepted in the `Host` header besides the loopback ones (see [Reaching the daemon from a container](#reaching-the-daemon-from-a-container)) |
| `--token-file <file>` | `ABB_RWS_DAEMON_TOKEN_FILE` | `%APPDATA%\abb-rws-daemon\token` on Windows; `$XDG_CONFIG_HOME/abb-rws-daemon/token` elsewhere, `~/.config/abb-rws-daemon/token` without it |
| | `ABB_RWS_DAEMON_LOG` | `info`: the log level, one of `fatal`, `error`, `warn`, `info`, `debug`, `trace` and `silent` (environment only) |
| `--record` | none (see [Recording](#recording)) | off: start a recording at launch |
| `--record-label <label>` | | none: part of the file names, 1 to 32 lowercase letters, digits and `-` (with `--record`) |
| `--record-content <list>` | | `frames,calls,state` (with `--record`) |
| `--record-for <s>` | | `3600`: how long a recording runs, at most 86400; a start request may ask for less |
| `--record-max-file-mb <n>` | | `64` (1 to 256): a part this large is closed and the recording goes on in the next |
| `--record-max-total-mb <n>` | | `256` (1 to 8192): a recording this large stops |
| `--record-max-dir-mb <n>` | | `4096` (1 to 65536): every recording in the folder together; at or over it a recording does not start, or stops |
| `--record-dir <folder>` | `ABB_RWS_DAEMON_RECORD_DIR` | `recordings` in the daemon's per-user folder, where the token file is by default |
| `--replay <file-or-folder>` | `ABB_RWS_DAEMON_REPLAY` | off: replay a recording instead of reading controllers (see [Replay](#replay)) |
| `--replay-speed <x>` | `ABB_RWS_DAEMON_REPLAY_SPEED` | `1` (0.1 to 50) |
| `--replay-loop` | `ABB_RWS_DAEMON_REPLAY_LOOP` (`1`, `true`, `yes`, `on`, or `0`, `false`, `no`, `off`) | off: start over at the end |
| `--replay-parts <n>[-<m>]` | `ABB_RWS_DAEMON_REPLAY_PARTS` | every part: `3`, `2-4` or `3-` |
| `--replay-time <shifted\|recorded>` | | `shifted` |
| `--replay-paused` | | off: start paused |
| `--replay-skip-bad` | | off: skip a bad line and the frames after it up to the next snapshot, instead of refusing the recording |

An option on the command line wins over its environment variable. An empty variable
counts as unset (as is common in unit and compose files).

A value follows its option (`--port 7811`) or is joined to it (`--port=7811`). The
daemon refuses a command line it does not understand before it reads or makes
anything: an option it does not know, an option without its value or with an empty
one (`--panel-origins ""`), a switch given a value (`--record=1`), an option given
twice, and an argument that belongs to no option. It also stops at launch, with a
message, for a value outside its bounds (a port is plain digits, 1 to 65535), a log
level it does not know, a replay option without `--replay`, and a recorder option
or `--config` together with `--replay`.

Exit codes: 0 after `--help`, `--version` and a clean stop; 1 when the daemon did
not start (the message says why) or a stop was cut short.

## Access token

Every account signed in to a PC shares its loopback, so every request but
`GET /v0/health` carries a token, the stream's WebSocket upgrade included. The
daemon makes the token on its first start and keeps it in a file only the account
that runs it can open:

- Windows: `%APPDATA%\abb-rws-daemon\token`
- Linux: `$XDG_CONFIG_HOME/abb-rws-daemon/token`, or `~/.config/abb-rws-daemon/token`
  when `XDG_CONFIG_HOME` is not set
- or the file that `--token-file` (or `ABB_RWS_DAEMON_TOKEN_FILE`) names

A consumer on the same account reads the file and sends its content in the
`x-abb-rws-token` header. A consumer whose WebSocket library cannot set a header
offers the token as a subprotocol instead, next to the stream's own:
`Sec-WebSocket-Protocol: abb-rws.v0, abb-rws-token.<token>`; the daemon selects
`abb-rws.v0` and never sends the token back. Without the token a request is answered
401 `TOKEN_MISSING`, with another one 401 `TOKEN_INVALID`. (403 `TOKEN_REQUIRED` is
what the shutdown, recording and replay routes answer on a server that runs without
a token; the command never does, only code that embeds the server can.)

Keep the token out of web pages: a page that holds it hands it to anyone who can
load the page. A browser consumer goes through a server of its own that adds the
header. When the daemon is given another token file, tell its consumers too.

The file holds the token alone: the daemon makes 43 letters, digits, `-` and `_`,
and a file written by hand may hold 32 to 256 of them. It is written owner-only
(its folder made as needed) and read on every later start; the daemon warns at
startup when other accounts can open it, and does not start when the file holds no
token. To change the token, delete the file and restart the daemon.

### Reaching the daemon from a container

By default the daemon answers a request only when its `Host` header names loopback
(`127.0.0.1`, `localhost` or `::1`); any other name gets 421 `HOST_NOT_ALLOWED`. A
container under Docker Desktop reaches a service on the PC's loopback as
`host.docker.internal` (seen with Docker Desktop on Windows), so its requests carry
that name. `--allowed-hosts` lists the host names to accept besides the loopback
ones, comma-separated, at most 8:

```sh
abb-rws-daemon --allowed-hosts host.docker.internal
```

Nothing else changes with it. The daemon still listens on 127.0.0.1 only, every
request but `GET /v0/health` still needs the access token (the container reads the
token file, for example mounted read-only), and the `Origin` and `Sec-Fetch-Site`
rules are the same, so a browser page gains nothing. An entry is one DNS host name
in full, accepted whatever the port: no IP address, no name that ends in a number,
no wildcard, and no port, scheme or path. A bad entry, or the option without a
value, stops the daemon at launch with a message. At start the daemon logs a
warning that names the extra hosts.

## The snapshot

`GET /v0/controllers` and the stream carry one `ControllerSnapshot` per controller,
made of groups. Each group says when it was last known to be current (`asOf`); when
the link degrades, values keep their last time instead of pretending to be current.

| Group | What it holds |
|---|---|
| `identity` | Controller name, id and type (virtual or real), system name and system id, RobotWare version and options. null until the controller has been read once |
| `link` | Whether the daemon is connected and how well (`live`, `polling`, `reconnecting`, `stale` or `disconnected`, with the reason), since when, since when it has been down (`downSince`), the address and port in use, the identity check and the next reconnect attempt |
| `panel` | Controller state, operating mode, speed ratio and collision detection |
| `rapid` | Execution state and, per task, its state, modules, program pointer and motion pointer |
| `motion` | Per mechanical unit, joint positions with their unit and axis limits, and the TCP pose, sampled at the watch rate only while a consumer holds a motion watch lease; without one the group keeps its last values and their time |
| `io` | The watched signals and their values. Read only while a consumer holds an I/O watch lease |
| `events` | The newest 20 messages of the controller's event log, with times in UTC, and the clock offset they were corrected with |
| `access` | What the controller reports about who holds its write locks: mastership on RobotWare 6 and 7, control-station write access on RobotWare 8 |
| `capabilities` | What the daemon can read on this controller and how it arrives, one row per capability |
| `freshness` | Whether the snapshot is current: one level for the controller and one line per group |

The last three are described under
[Write access, capabilities and freshness](#write-access-capabilities-and-freshness).
Module source, the full signal table and the event history have routes of their own.

- **One session per controller.** Robot Web Services caps sessions and degrades
  badly under churn. The daemon owns the session, reconnects with backoff, and logs
  out when it stops; consumers read the same snapshot instead of each opening their
  own.
- **The right controller.** A controller is identified by its system id, not its
  address. A virtual controller that moved port is followed; an address that answers
  as a different controller carries none of its values, is disconnected, and its
  per-controller routes answer 409 `IDENTITY_MISMATCH`.
- **Reads on demand.** The fast motion sampling and the reads of watched I/O signals
  run only while a consumer holds a watch lease. The client's regular status poll,
  which runs for every connected controller, also reads the joint positions and the
  TCP pose at its own slower pace, lease or not; the `motion` group shows only what
  the sampler read.

## Routes and stream

| Route | What it does |
|---|---|
| `GET /v0/health` | Status, version, start time and uptime; `mode` (`live` or `replay`), `recording: { active, since }` and `replay` (null in live mode). No token needed, and no file name or path in it |
| `GET /v0/controllers` | Every controller's snapshot (every group above, `access`, `capabilities` and `freshness` among them), with `schemaVersion` |
| `GET /v0/controllers/:id` | One controller's snapshot, the same groups |
| `POST /v0/controllers` | Add a controller: `{ host, port, useHttps, username, password }`, optionally `name`, `id` and `systemId`. 409 `ALREADY_ADDED` or `ID_TAKEN` |
| `DELETE /v0/controllers/:id` | Remove a controller and log out of it |
| `GET /v0/controllers/:id/rapid/tasks/:task/modules/:module` | A module's RAPID source. On the controller's read budget (below) |
| `POST /v0/controllers/:id/motion/watch` | Start or renew a motion watch lease: joint positions and the pose are sampled at the watch rate while any lease is held. Renew it every `leaseMs / 2`. Optional body `{ leaseId }` (see below) |
| `POST /v0/controllers/:id/io/watch` | `{ signals: [...], leaseId? }`: start or renew an I/O watch lease. The list replaces that lease's set (an empty list leaves it holding none); the daemon watches the union of every lease's set. Refused names come back in `rejected` with the reason |
| `GET /v0/controllers/:id/io/signals` | The controller's signal table, or a search by `name`, `device`, `network`, `category` or `type`. 503 `NOT_READY` with `Retry-After` while the table has not been read on the current connection. A search is on the controller's read budget (below); the table is served from memory |
| `GET /v0/controllers/:id/events` | The controller's event log, from memory (see [Event log](#event-log)): without `since` the newest `limit` messages (default 50, at most 256); with `since=<seq>` the ones after it, oldest first, with `more` and `gap` |
| `POST /v0/setup/discover` | Find controllers (see [Discovery](#discovery)): `{ hosts?, manual?, ranges?, ports?, serviceAddress?, mdns? }`. Answers `{ entries, notes }`. 400 `INVALID_ARGUMENT` names the field, 409 `DISCOVERY_RUNNING`, 429 `DISCOVERY_LIMIT` |
| `GET /v0/setup/discover/saved` | The discovery inputs saved in the config file: `{ manual, ranges, ports }`, to pre-fill a scan |
| `PUT /v0/setup/discover/saved` | Save discovery inputs, replacing what was saved (a list left out is emptied). Never starts a scan. 503 `NOT_SAVED` when the config could not be written, or when the file on disk is no config with a `controllers` array (it is then left as it is) |
| `DELETE /v0/setup/discover/saved` | Clear the saved addresses and ranges; the extra ports stay. Answers what is saved afterwards; 503 `NOT_SAVED` as above |
| `DELETE /v0/setup/discover/saved/manual?host=&port=&https=` | Remove a saved address by value: `host` (letter case aside), and `port` and `https` exactly (left out matches only an entry without one). Never by position, so a change made meanwhile cannot shift it onto another entry. Answers what is saved afterwards. 404 `NO_SAVED_ENTRY` when nothing equal is saved (nothing is written); 503 `NOT_SAVED` as above |
| `DELETE /v0/setup/discover/saved/ranges?range=` | Remove a saved range by its text; otherwise as above |
| `DELETE /v0/setup/discover/saved/ports?port=` | Remove a saved extra port; otherwise as above |
| `POST /v0/setup/passport` | Identity, licences and a compatibility verdict for a controller, read with the given credentials; returns nothing secret |
| `POST /v0/admin/shutdown` | Stop the daemon as Ctrl+C does (see [Stopping and running as a service](#stopping-and-running-as-a-service)). Answers 202 `{ stopping, alreadyStopping, exitWithinMs }` first. Native clients only: a request from a browser page (an `Origin` or `Sec-Fetch-Site` header), the panel's included, is refused 403 `ORIGIN_NOT_ALLOWED` |
| `GET /v0/recording` | The recording running now, or the last one (see [Recording](#recording)): file base names, counts, bytes, what was left out, masking counts, the limits in force, why it ended. Never a path |
| `POST /v0/recording/start` | `{ label?, content?, durationS?, limits? }`: start a recording; 201 with its status. 400 for a value out of bounds, 409 `RECORDING_ACTIVE`, 503 `RECORDING_FAILED` (folder, file, free space or folder limit), 409 `REPLAY_MODE` in replay |
| `POST /v0/recording/stop` | Stop it; answers its status. Stopping when none runs is not an error |
| `GET /v0/replay` | Replay mode only (see [Replay](#replay)): where the replay is, and what it replays |
| `POST /v0/replay/control` | Replay mode only: `{ action: "play" \| "pause" \| "step" \| "restart", speed? }` |
| `GET /v0/stream` (WebSocket) | A `snapshot` frame, then `delta` frames (the changed groups, each replaced whole) and `removed` frames. Send-only |

Every route but `GET /v0/health` needs the [access token](#access-token).

**The stream.** A consumer applies the one `snapshot` frame (every controller, every
group), then each `delta` by replacing the groups it names whole, and drops a
controller on `removed`. Link changes are sent at once, every one, together with
the groups that changed with them, `freshness` included; the other groups, `access`,
`capabilities` and `freshness` among them, at most 4 times a second per controller.
A time moving on is not a change: a group is sent when its content changes.

**Watch leases** are per consumer. A watch request without a `leaseId` renews the
one lease every such request shares: for I/O, each one replaces the shared set, so
two consumers that both leave the id out overwrite each other. Send
`"leaseId": "new"` to open a lease of your own; the answer carries its `leaseId`,
which every renewal sends. Each consumer's I/O set is then its own: when its lease
runs out, only the signals no other lease holds stop being watched. One consumer's
lease holds at most 16 signals and a controller watches at most 24, all leases
together (a signal another lease already watches does not count again); refused
names say which cap. A controller holds at most 32 leases with an id per kind of
watch; one more is answered 429 `LEASE_LIMIT`. The id is the consumer's to keep: it
may serve its motion and I/O watches on every controller, and after its lease ran
out, or the daemon restarted, sending it again opens that lease again under the
same id.

**Reads on demand have a budget** per controller. A module's source and a signal
search are read from the controller when a consumer asks, through the same session
and request queue as the daemon's own sampling, so the daemon limits them: at most 2
are out per controller at a time, and together they make about 2 controller requests
a second (in bursts of up to 4). A request identical to one still out shares its
answer, and an answer is served from memory for up to 2 s. A request the budget has
no room for is answered 429 `READ_LIMIT` with a `Retry-After`, and nothing is sent
to the controller.

**Errors** are JSON `{ error, code }`. A controller failure carries the client's
error code and an HTTP status that describes the controller or the request; 500
means a bug in the daemon. It also keeps what the controller answered, in
`controller`: `{ httpStatus, code, message }`, the controller's own HTTP status,
error code and message (each null when the controller gave none). Where the client
describes the refusal (what is missing, who can grant it), that comes along in
`refusal`. The error of a motion unit, a watched signal or a lock in a snapshot
carries the same two fields. No error ever carries a credential, a request header or
a control-station id.

## Write access, capabilities and freshness

Three groups of the snapshot answer what a consumer would otherwise have to work
out for itself: who holds the controller's write locks, what the daemon can read on
this controller, and whether what the snapshot shows is current. All three are
reports. The daemon only reads the controller's own status; it never requests,
releases or changes mastership, write access, RMMP or a control-station
registration.

### `access`

RobotWare 6 and 7 arbitrate writes with mastership, RobotWare 8 with one
control-station write access. `access` shows what the controller says about each
lock:

| | RobotWare 6 | RobotWare 7 | RobotWare 8 |
|---|---|---|---|
| `generation` and `model` | `rw6`, `mastership` | `rw7`, `mastership` | `rw8`, `writeaccess` |
| `locks` | `cfg`, `motion`, `rapid` | `edit`, `motion` | `writeaccess` |
| A lock's `holder` | `kind` is `local` (a local client, normally the FlexPendant), `remote` (a remote client) or `internal` (the controller itself); `application` is the application name the controller reports | the same; the FlexPendant's own session is named by the application `TPU` | `kind` is `station`; `name` is the control station's name as the controller reports it, `FlexPendant` for the FlexPendant |
| `rmmp` | The manual-mode privilege of the daemon's own session: `none`, `pending modify`, `pending exec`, `modify` or `exec`. `supported: false` when the controller does not offer it | the same | `supported: false`; nothing is asked |
| `remoteAccessEnabled` | null | null | The controller's own "external control enabled" flag (remote access, switched at the FlexPendant) |

Each lock has `held` (true, false, or null while it has not been read), `holder`
(null when nobody holds it), `heldByDaemon`, `reported` (RobotWare 6 and 7: the
status word as it arrived), `asOf` and `error`. The daemon reads the status about
every 5 s while the link is `live` and every 15 s while it is `polling`: one request
per lock, and one for RMMP on RobotWare 6 and 7, one at a time. A new connection is
read at once, and a link that recovered or an operating mode that changed is read
sooner than booked, but on one connection never twice within 5 s, so a link that
keeps going stale and recovering is read no more often than a steady one. `via` is
`poll` while the daemon is reading and null while it is not.

- **A reading, not a promise.** `held` is what the controller said at `asOf`. It can
  change the moment after, and nothing in `access` says that a write would succeed:
  the controller decides every write when it arrives.
- **A holder is named, never identified:** no user id and no station id is served,
  logged or recorded.
- **The FlexPendant by either name.** `holder.flexPendant` is true when the
  controller names the holder as the FlexPendant, in the two forms seen: a `local`
  holder with the application `TPU` (RobotWare 7) or the station `FlexPendant`
  (RobotWare 8), in any case. It is false for any other name (a station named `TPU`
  too) and for a `remote` or `internal` holder, and null when the controller gives
  the holder no name. `name` and `application` stay as the controller gave them, so a consumer
  shows a holder with `flexPendant: true` as the FlexPendant on every generation.
- **A status the daemon could not read, or did not understand, shows as an error,
  never as "nobody".** That lock gets an `error` and keeps its last good `held` and
  `holder` with their `asOf`. `held` is false only when the controller said that
  nobody holds the lock.
- **Values are read anew after every reconnect.** When a link becomes usable again
  (a new connection, or the same one after a `stale` spell) the daemon first clears
  what it read before, then reads. Until that read lands the locks show `held: null`
  and `freshness` reports `access` as `unread` (`partial` while only some of its
  parts have landed), so a holder from before an outage is never shown as current.
  While the link is down the last values stay, with their times.
- **`heldByDaemon`** comes from the client's own record of what this session
  requested, not from the controller's status. This daemon never requests a lock, so
  it is false, or null while the client's own record has no state for that lock.
- **RobotWare 8: the write-access status** is read with abb-rws-client's
  `RobotManager.getWriteAccessStatus()` (1.5.1 and later): one GET per round, which
  registers nothing and requests nothing. The lock shows whether write access is held,
  the holding control station's name as the controller reports it, and the
  remote-access flag; a field the controller does not report is null, never guessed.
  With an older client that lacks this read, nothing is sent: the lock stays
  `held: null` and `remoteAccessEnabled` null, `access.problem` says that the client
  cannot read the write-access status, the `write-access` capability is
  `unavailable`, and `freshness` reports `access` as `unavailable`.
- `problem` is also set when a controller reported no RobotWare version the client
  could use: its generation is then not known, and no status is read.

### `capabilities`

What the daemon can read on this controller and how it arrives: `protocol` (`rws1`
or `rws2`), `generation`, `robotWare` (as the controller reported it), `tested`
(whether that RobotWare version is one this daemon was tested against) and
`entries`, one row per capability:

| `id` | It is `available` when |
|---|---|
| `status-push` | controller status and RAPID execution state are pushed by the controller |
| `events-push` | new event-log messages are announced by the controller |
| `event-times` | event times are corrected to UTC |
| `io-push` | watched I/O signals arrive by subscription (RWS 2.0; on RWS 1.0 they are read by polling) |
| `io-table` | the signal table lists every signal |
| `joint-limits` | joints carry their unit and limits |
| `mastership`, `write-access`, `rmmp` | that part of `access` can be read |

Besides `available`, a row has one of three states, each with a `reason`, and they
mean different things:

- `unavailable`: it cannot work on this connection: not on this controller, not in
  this daemon release, or not with this client release. `mastership` on RobotWare 8,
  `write-access` with a client older than 1.5.1 and `io-push` on RWS 1.0 are examples.
- `degraded`: it should work, and at the moment it does not or only in part: the
  last attempt failed, or the controller's event stream is lost and may come back
  without a reconnect.
- `unknown`: not determined yet on this connection. While a link is not healthy
  every row is `unknown` with the link's reason, so values kept from before an
  outage never make a row read `available`.

### `freshness`

Whether what the snapshot shows is current, said once for the controller (`level`,
with `reasons`) and once per group (`identity`, `panel`, `rapid`, `motion`, `io`,
`events`, `access`), so a consumer needs no thresholds of its own.

| `level` | Meaning |
|---|---|
| `current` | The link is healthy (`live` or `polling`) and no group is stale or failing in part |
| `degraded` | The link is `stale`, or a group is stale or failing in part |
| `down` | There is no link (`disconnected` or `reconnecting`) |
| `wrong-controller` | The link answers as a different controller and carries none of its values |

| Group state | Meaning |
|---|---|
| `current` | Being refreshed, last read good |
| `partial` | Some of its parts are current and some are failing or not read yet |
| `stale` | It holds values that are no longer refreshed (the link is not healthy, or its last read failed); `asOf` says since when |
| `idle` | Nothing is watched, by design (no watch lease) |
| `unread` | Not read yet on this connection; a read is expected |
| `unavailable` | It cannot be read on this controller with this client, and no read is being tried; `reason` says why |
| `withheld` | The link is on a different controller, so the group carries nothing |

`unread` promises a read that is on its way; `unavailable` says none will come with
this client on this controller. `idle`, `unread` and `unavailable` never lower the
level: a RobotWare 8 controller whose write-access status cannot be read stays
`current`, with `access` `unavailable`. A group that is `partial` only because some
of its parts have not been read yet (a signal just added to a watch, the first
status read of a connection half-way) does not lower it either; one with a failing
part does.

**A controller goes down.** While it answers, the level is `current`. When it stops,
the link turns `stale` and the level `degraded`; once the link is `disconnected` or
`reconnecting` the level is `down`, and `reasons` holds one line, the link's own.
Every group that holds values is `stale`, its `asOf` frozen at its last good read (a
group nobody watches stays `idle`), and every capability row is `unknown`.
`link.downSince` says when the link was last healthy and stays put, while
`link.since` moves with each reconnect attempt. When the controller is back,
`access` is first `unread` and names no holder; the status is read at once, and the
level returns to `current`. For a controller that was never reached, the groups are
`unread` (or `idle`) and `downSince` is when the daemon began trying.

## Discovery

`POST /v0/setup/discover` runs one discovery through the client's
`findControllers`. It never logs in to a controller.

- **This PC**, always: the RWS listening ports of this PC, probed on 127.0.0.1.
  Nothing leaves the PC.
- **The service address** (192.168.125.1) and **mDNS**: on unless the request sends
  `serviceAddress: false` or `mdns: false`.
- **Addresses**: `manual` (`{ host, port?, https? }`) and `hosts` (host names or
  IPv4 addresses, each like a `manual` entry without a port), at most 16 together
  (more is a 400 naming the field `manual, hosts`).
  Without a port, another host is probed on 443 and 80 plus `ports`; 127.0.0.1 on
  every known RWS port.
- **Ranges**, only when the request names them: IPv4 CIDR (`10.0.5.0/24`) or
  first-last (`10.0.5.20-10.0.5.60`), at most 16 entries and 256 addresses in all,
  private, loopback and link-local addresses only. Each address is probed like an
  address without a port, at most 10 new connections a second; a /24 takes a
  minute or more.
- **`ports`**: up to 8 extra ports for every other host.

> **Ranges and company networks.** Scanning a range opens TCP connections to every
> address in it. On a company network IT can see these attempts, and intrusion
> detection may flag them. The daemon scans a range only when a request names it,
> never a saved one on its own; ask before you scan a network you do not run.

Each entry has `host`, `port`, `useHttps` (null when only mDNS announced it),
`generation`, `generationGuessed` (true when the controller was not confirmed as
an ABB controller: mDNS alone, or a login challenge that is not ABB's),
`systemName`, `rwVersion`, `sources` (`this-pc`, `service-address`, `manual`,
`range`, `mdns`), `alreadyAdded` (the configured controller at that address, at the
host name it was configured with, or with that system id) and `name` (the host
name the request named, when `host` is the address it resolved to). A virtual
controller on this PC is listed once, whichever of the PC's addresses it was seen
on. `notes` are plain notes from the run, for example a host name that resolved
only to an IPv6 address, which RobotWare does not support.

One discovery runs at a time: a request while one runs is answered 409
`DISCOVERY_RUNNING`. A request with ranges less than 30 s after the previous one
with ranges ended is answered 429 `DISCOVERY_LIMIT` with a `Retry-After`. A body
outside the shape above (a host with anything but letters, digits, dots and
hyphens, too many entries) is answered 400 `BAD_REQUEST`. Input the client refuses
(a range that is malformed, IPv6, too large or outside those classes; a host name
that is not one) is answered 400 `INVALID_ARGUMENT` with `field` (such as
`ranges[0]` or `hosts[1]`), `value` and, where a cap was broken, `limit`. Either
way nothing was sent. A caller that closes its connection cancels the run.

## Event log

The daemon follows every controller's common event log (domain 0). On each
connection it reads the controller's clock, then the log; after that, while the
link's event subscription is live the controller announces each new message and
the log is read again, and while no subscription delivers the daemon reads the log
itself every 5 s (further apart for a long RWS 2.0 log, about a request a second at
most). A stream that dropped and came back is caught up with one read. Messages
are recorded once however often they are read, across reconnects too, and each
gets a number of the daemon's own, `seq`, in the controller's order: RWS 1.0 counts
its own sequence numbers in 16 bits, so after 65,535 they start again, and `seq`
follows them across that. The daemon keeps the last 256 per controller; the
snapshot's `events` group carries the newest 20, and `GET .../events` the rest.

Each message keeps its time exactly as the controller wrote it (`time.raw`, with no
zone) and that time in UTC (`time.utc`), shifted by the offset between the
controller's clock and the daemon's, measured on every connection and every
10 minutes and shown in `events.clock`. It is good to about a second. When the
clock cannot be read, `time.corrected` is false and `events.clock.problem` says
why. `receivedAt` is when the daemon got the message; the messages already in the
log when the daemon first read it are marked `backlog`. A message whose text the
controller did not send keeps its code, and its title is made from it ("Event
10140", `titleFromCode`).

`seq` starts at 1 again when the daemon starts or the controller is added again, and
`feed` changes with it: a consumer that pages with `since` keeps the `feed` its
cursor belongs to and starts over when it changes. `gap` in an answer says that
messages after `since` were dropped from memory before they were asked for. Nothing
is read from a link that is not yet confirmed to be the controller that was added:
recorded messages outlive the link.

## Recording

A recording is off unless it is started: with `--record` at launch, or with
`POST /v0/recording/start` and the access token. No environment variable and no
config entry starts one, and a daemon that finds `ABB_RWS_DAEMON_RECORD` set does not
start at all, so a variable meant to record never silently does nothing. Every
recording has a duration (`--record-for`, an hour by default), and one runs at a
time. While it runs, `GET /v0/health` says so, and the log has its start, each new
part and its end.

```powershell
$token = Get-Content "$env:APPDATA\abb-rws-daemon\token"
curl.exe -X POST -H "x-abb-rws-token: $token" -H "content-type: application/json" `
  -d '{\"label\":\"cell-check\",\"durationS\":300}' http://127.0.0.1:7810/v0/recording/start
```

A recording is JSON Lines: a header, then records on one clock (`t`, milliseconds
since the recording began):

- `frame`: every `/v0/stream` frame as consumers received it, byte for byte unless
  masking changed it (the record then says `masked`). Frames alone are enough to
  replay. By design a frame is written only when the stream sends one, that is when
  something changed: a quiet controller with no watch held gives a recording of its
  opening snapshot and little more, however long it ran, and its replay ends soon
  after that snapshot.
- `controller`: each controller's system id, generation, RobotWare version and
  identity check, whenever they become known or change, and again at the top of
  every part.
- `call`: every client method the daemon called, with its arguments, its result or
  typed error and how long it took; `sub`: every raw I/O event the daemon consumed;
  `state`: changes of the client's state the daemon was told of.
- `gap`, `note` and `end`.

`content` picks `frames`, `calls` and `state` (all three by default). The format is
`schema/recording.schema.json`. Recording adds no request to any controller: the
recorder observes the stream from inside the daemon, taking no consumer slot, and the
daemon's calls to the client as they pass.

**Masking.** A recording never holds a password, a session cookie, an
`Authorization` header or the access token, nor the user id or the station id of
whoever holds a lock. Everything is masked on a copy as it is captured: values
under secret-named keys, secret arguments, credential-shaped text (header lines,
Basic, Bearer and Digest credentials, credentials in URLs, `key=value` pairs),
string literals assigned to secret-named RAPID identifiers (`pwd := "...";`), and
every known password and the token, with their encoded forms, wherever they occur. A
known value too short or too common to mask by value (an all-digit PIN, a word the
controller's own texts contain) is counted in `masking.weakValues` and logged as a
warning; it is still masked by key and by shape. Not masked: user names, hosts and
ports, system ids, controller and system names, the application or control-station
name of a lock's holder, signal names, event texts, and RAPID module source apart
from the rule above (the daemon serves module source as the controller holds it,
too). A recording is private controller data.

**Files.** `rec-<UTC time>[-<label>]-p0001.jsonl`, in `recordings` in the daemon's
per-user folder (where the token file is by default) unless `--record-dir` or
`ABB_RWS_DAEMON_RECORD_DIR` names another folder. The folder must be the current
account's alone: the daemon makes it so when it creates it, and refuses to record
into an existing one that is not (it never changes the permissions of a folder it
did not make). Each part is created owner-only and written only through the handle
it was created with. The daemon leaves a `.gitignore` (`*`) and a README line in the
folder, so recordings in a folder inside a repository are not committed. No answer
names the folder; the log does. In a container, keep the folder on a named volume: a
bind mount from a Windows or macOS host does not keep owners and modes, so the
folder check fails and nothing is recorded.

**Limits.** A part that reaches `--record-max-file-mb` is closed and the recording
goes on in a new part, which begins with a full snapshot, so every part replays on
its own. A recording stops at `--record-max-total-mb`, when the folder's recordings
together reach `--record-max-dir-mb`, below 2 GiB of free space, and at the end of
its duration. A start request may tighten these limits, never loosen them. Nothing
is ever deleted. When the disk falls behind, calls, state and I/O events are left
out first and counted (a `gap` record, then a full snapshot); frames are never left
out, and a disk that stalls stops the recording instead. A recording that fails
never stops the daemon: `GET /v0/recording` says why it ended.

Three tools work on recordings. They are not in the npm package: run them from a
source checkout (see [From source](#from-source)); each builds the daemon first.

- `npm run capture -- --out <file.jsonl> [--port 7810] [--seconds 180] [--label x]`
  writes what any stream consumer sees, from a daemon that is already running on this
  machine, in the same format and with the same masking (it knows the token, not the
  controller passwords). The file is created owner-only, never over an existing one,
  in an owner-only folder that gets the same `.gitignore` and README markers. A
  capture replays like a recording; module source and signal searches then answer
  `NOT_RECORDED`.
- `npm run compare -- <a.jsonl> <b.jsonl> [--ignore-time] [--timing-ms 50]` compares
  the frames of two recordings or captures, and reports frames masking changed apart
  from real differences.
- `npm run sanitize -- <in.jsonl> --out <out.jsonl> [--keep-calls] [--user <name>]...`
  makes a copy fit to share: frames only unless `--keep-calls` (setup calls are always
  dropped), placeholders for controller and system names, system ids, MAC addresses,
  hosts, RobotWare 8 station names (`station-1`) and login names (`user-1`,
  `user-2`...), in every text as well, and a scan that fails on anything left over.
  Give all parts of one recording at once (`<part1.jsonl> <part2.jsonl>... --out
  <new folder>`) so their placeholders agree. Login names are taken from credentials,
  passport reads and the event-log messages that name a user (codes 10400, 10401,
  10040, 10064, 10140). A name in any other event code is replaced only when you name
  it with `--user`. A login name shorter than 3 characters or a common word is
  replaced only where a whole text is that name, with a warning, unless you name it
  with `--user`. Keys are never rewritten. It refuses a recording with weak secret
  values, and a recording part without an end record (the daemon was stopped hard, so
  its final masking counts are unknown). Read the result before you commit it
  anywhere.

## Replay

`--replay <file-or-folder>` (or `ABB_RWS_DAEMON_REPLAY`) starts a daemon that serves
a recording instead of reading controllers: a part file (the recording's other parts
are found beside it), a folder holding one recording, or `<folder>/<recording name>`.
It reads no config file and makes no client: there is no controller password and no
session in the process, and nothing it does can reach a controller.

```sh
abb-rws-daemon --replay ~/.config/abb-rws-daemon/recordings/rec-20261004T153012Z-cell-check-p0001.jsonl --port 7811
```

- `GET /v0/stream` sends the recorded frames on the recorded schedule, scaled by
  `--replay-speed`; each consumer gets one snapshot, then deltas, as from a live
  daemon.
- The controller routes answer from the recording at the replay's position: module
  source and signal searches from the reads the recording holds (404 `NOT_RECORDED`
  when it holds none at that point, never an older answer), the signal table as the
  client held it, and the event log from every event the recording carried. Watches
  are granted and change nothing.
- Frames are served as they were recorded, and `GET /v0/controllers` names the
  snapshot schema version the recording was made with. One field is the replay's
  own: every link it serves says `mode: "replay"` and `recordedAt` (when the
  recorded session began), while `quality` and the rest stay as recorded, so a
  consumer that reads only the snapshot can tell a replay from a live controller.
  A recording made before schema 0.13 is served without `mode`, and one made before
  schema 0.14 without a holder's `flexPendant`; `GET /v0/health` says `mode: replay`
  for every replay.
- Discovery, passport reads, adding or removing a controller, saving discovery
  inputs and starting a recording answer 409 `REPLAY_MODE`.
- `GET /v0/replay` says where the replay is and what it replays;
  `POST /v0/replay/control` plays, pauses, sends the next frame at once (`step`) or
  starts over (`restart`: stream consumers are closed with 1012 and reconnect). With
  `--replay-loop` the replay starts over a second after its end, and each turn
  renames the event feed (`<feed>~loop<n>`), so a consumer paging events starts over.
- Times: `--replay-time shifted` (the default) moves every time in every frame and
  answer by the same amount, so values are as old as they were at that point of the
  recording; `recorded` serves them as recorded.
- A replay reads at most 256 MiB; pick parts of a longer recording with
  `--replay-parts`. A line that cannot be read refuses the recording unless
  `--replay-skip-bad`; a cut last line (from a daemon that was killed) is ignored.
- `--replay-paused` starts the replay paused, waiting for `play` or `step`.

## Schema

`schema/v0.schema.json` (JSON Schema draft-07, `$id` `urn:abb-rws-daemon:schema:v0`)
describes the snapshot, the stream frames and every answer; `x-schema-version` names
the exact minor (0.14 in this release), and each released minor is kept under
`schema/history/`. Every number names its unit (`x-unit`, or `x-unit-from` for joint
values, whose unit each joint names), and every time is `format: date-time`, in UTC.
`schema/recording.schema.json` describes the recording format. Both ship in the
package, under `abb-rws-daemon/schema/`. In a source checkout `npm run schema`
regenerates them from `src/schema/`, and `npm run build` fails when they are out of
date. See [schema/README.md](schema/README.md).

## Supported RobotWare

As tested, each on a RobotStudio virtual controller:

| RobotWare | Controller | Protocol |
|---|---|---|
| 6.16 | IRC5 | RWS 1.0 |
| 7.21 | OmniCore | RWS 2.0 |
| 8.1 and 8.2 | OmniCore | RWS 2.0 |

For any other RobotWare 6, 7 or 8 version the passport (`POST /v0/setup/passport`)
says `untested`, and the snapshot's `capabilities.tested` is false; outside 6 to 8
the passport says `unsupported`. The daemon has not been run against a real
controller yet, and a virtual controller does not enforce everything a real one
does: take what you see on one as evidence about virtual controllers.

The runs behind the table used abb-rws-client's 1.4.0 code. abb-rws-client 1.4.0
and 1.5.0 were prepared but not published. Their changes ship in abb-rws-client
1.5.1, the client this release installs, together with later fixes. With 1.5.1 the
daemon passes its own tests.

On 2026-10-28 the packages as npm serves them, abb-rws-daemon 0.1.0 with
abb-rws-client 1.5.1 and abb-rws-mcp 0.1.0 on top, ran against RobotStudio virtual
controllers on RobotWare 6.16.03, 7.21.4 and 8.2.1. Every MCP tool and the prompt
was called on each controller: 66 checks passed, none failed, and 3 were skipped
because no program was running. The daemon logged out of every controller at the end.

## Security notes

- **Loopback only.** The daemon binds 127.0.0.1, with no option to widen it.
  Requests with a non-local `Host` (unless the name is listed with
  `--allowed-hosts`, see [Reaching the daemon from a container](#reaching-the-daemon-from-a-container)),
  a browser `Origin` other than its own or the configured panel origins, or `Sec-Fetch-Site: cross-site` are refused, and so is a
  request marked `Sec-Fetch-Site: same-site` (a page on another port of this host)
  that carries no `Origin`.
- **The token, and who can read it.** The daemon has no user accounts of its own:
  whoever can read its token file can use it. That is the account that runs the
  daemon, and administrators. The file is written owner-only, and the daemon warns
  at startup when other accounts can open it; on Linux also when the file belongs to
  another account, or when other accounts can write to its folder and so replace the
  file. It warns and still starts: refusing would lock you out of your own daemon.
- **The config file holds controller passwords** and is written owner-only. On
  Linux the daemon writes it with mode 0600 and warns at startup when its mode gives
  other accounts access, when the file belongs to another account, or when other
  accounts can write to its folder and so replace the file. On Windows
  the file is restricted to the current user and SYSTEM, and the daemon warns when
  its permissions let another account open it.
- **The client's session file.** For RWS 1.0 controllers abb-rws-client keeps the
  cookie of each open session in `~/.abb-rws-session`, in the home folder of the
  account that runs the daemon: owner-only, keyed by controller and credentials,
  and an entry is removed when the daemon logs that session out. While a session
  lasts its cookie is a way in to that controller, so treat the file like the config
  file. `--config`, `--token-file` and `--record-dir` do not move it.
- **Controller connections.** The daemon does not verify a controller's TLS
  certificate (controllers use self-signed ones by default), and RWS 1.0 is plain
  HTTP. Use it on a network you trust.
- **A recording is private controller data.** Passwords, the token and session
  secrets are masked, but names, addresses, event texts and RAPID source are not.
  Sanitize a recording before you share it, and read the result.
- **Found a problem?** Report it privately: see [SECURITY.md](SECURITY.md).

## Stopping and running as a service

A daemon that exits without logging out leaves its session on every controller
until the controller times it out, and a controller takes only a few sessions from
one address. So every way of stopping it runs the same stop: SIGINT (Ctrl+C) and
SIGTERM; on Windows also Ctrl+Break and closing the console window; and
`POST /v0/admin/shutdown` with the access token, which answers 202 before the stop
begins. The stop closes stream consumers with code 1001 (going away), logs out of
every controller at once, ends a recording that runs (the logouts are in it, and its
last part gets its end record), closes the server and exits. The log has a line for
each controller saying whether it was logged out, was not connected, or did not
finish its logout in time, and a summary naming them all.

The stop takes at most 8 s, however many controllers there are. A logout that has
not finished by then is given up, and that controller ends the session when it
times it out. The exit code is 0 when the stop ran to its end and 1 when it had
to be cut short. Windows ends a process a few seconds after its console window
closes, whatever it is doing, so closing the window can cut the stop short; Ctrl+C
in the window, or the shutdown route, does not. Elsewhere SIGHUP is left alone, so a
daemon started under `nohup` keeps running when its terminal closes; a daemon started
in a plain terminal, without `nohup`, ends with that terminal at once and without the
logout, like any other program. To run it unattended use `nohup`, a service unit
(below) or a terminal multiplexer, and stop it with a signal or the shutdown route.

```powershell
$token = Get-Content "$env:APPDATA\abb-rws-daemon\token"
curl.exe -X POST -H "x-abb-rws-token: $token" http://127.0.0.1:7810/v0/admin/shutdown
```

**As a service.** A service wrapper should wait at least 8 s before it kills the
process. On Windows, NSSM and WinSW stop a console program with Ctrl+C, which the
daemon handles (raise NSSM's Ctrl+C timeout from its 1.5 s default). systemd sends
SIGTERM.

A systemd unit runs in `/`, and a service account often has no home folder, so the
default config path (the current folder) and the default token and recordings
folders (the home folder) are all wrong there. This unit names every path the
daemon's own options set, under a state folder systemd makes for the account (the
client's session file for RWS 1.0 controllers stays in the account's home folder,
see [Security notes](#security-notes); an account without one simply keeps none):

```ini
[Unit]
Description=abb-rws-daemon
After=network-online.target
Wants=network-online.target

[Service]
User=abb-rws
StateDirectory=abb-rws-daemon
StateDirectoryMode=0700
WorkingDirectory=%S/abb-rws-daemon
ExecStart=/usr/bin/node /usr/lib/node_modules/abb-rws-daemon/dist/cli.js \
  --config %S/abb-rws-daemon/config.json \
  --token-file %S/abb-rws-daemon/token \
  --record-dir %S/abb-rws-daemon/recordings
KillSignal=SIGTERM
TimeoutStopSec=15
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

- Create the account first (for example `sudo useradd --system abb-rws`), and
  install the daemon for every account: `sudo npm install -g abb-rws-daemon@0.1.0`.
- The two absolute paths in `ExecStart` are examples: `command -v node` and
  `npm root -g` give yours.
- `%S` is `/var/lib` for a system unit. A consumer on the same machine reads the
  token from `/var/lib/abb-rws-daemon/token`, and needs to be that account or root
  to do so.
- Save the unit as `/etc/systemd/system/abb-rws-daemon.service`, then run
  `sudo systemctl daemon-reload` and `sudo systemctl enable --now abb-rws-daemon`.

In a container, or under any account without a home folder, name the files with
`--token-file` and `--record-dir` (or set `XDG_CONFIG_HOME`), and keep the token and
the recordings on a named volume. An account that is not in the system's user list
(an arbitrary user id in a container) also needs `HOME` set: abb-rws-client looks
the home folder up when it loads, and the daemon does not start when there is none
to find.

## Who talks to it

| Consumer | How | Status |
|---|---|---|
| Robot Panel (abb-rws-panel) | browser, loopback HTTP + WebSocket through its own server, which adds the token | in development |
| [abb-rws-ros2](https://github.com/ichbinmeraj/abb-rws-ros2) | loopback HTTP + WebSocket (the bridge is Python) | built, read-only, needs schema 0.14 |
| [abb-rws-mcp](https://github.com/ichbinmeraj/abb-rws-mcp) | loopback HTTP | released (0.1.0), read-only, tested with schema 0.14, reads 0.13 or a later 0.x |
| Python client | loopback HTTP | planned |

Not everything needs it. A VS Code extension on a developer's laptop uses
`abb-rws-client` directly, and so will the planned conformance suite, which measures
the protocol itself. The daemon earns its place when a consumer is not TypeScript or
shares a controller with another live consumer, and, once they exist, when it needs
the write gate and audit log.

## Related projects

- [abb-rws-client](https://github.com/ichbinmeraj/abb-rws-client): TypeScript RWS client tested on RobotWare 6, 7 and 8
- [abb-rws-vscode](https://github.com/ichbinmeraj/abb-rws-vscode): RAPID Live, VS Code extension for ABB controllers
- [abb-rws-ros2](https://github.com/ichbinmeraj/abb-rws-ros2): ROS 2 supervisory bridge (built, read-only, needs schema 0.14)
- [abb-rws-mcp](https://github.com/ichbinmeraj/abb-rws-mcp): read-only Model Context Protocol server over this daemon (released, 0.1.0)
- abb-rws-conformance: conformance suite and compatibility matrix (planned)

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). If you redistribute this
work, keep the NOTICE file.

Contributions are accepted under the DCO - see [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

Independent open-source project by [Meraj Safari](https://github.com/ichbinmeraj).
ABB is a trademark of ABB Asea Brown Boveri Ltd. IRC5, OmniCore, RobotWare, RobotStudio
and FlexPendant are trademarks of their respective owners. **This project is not
affiliated with, endorsed by, sponsored by or supported by ABB, ABB Robotics or any later
owner of these products.** Project names and trademark position: see
[TRADEMARKS.md](TRADEMARKS.md).
