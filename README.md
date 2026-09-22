# abb-rws-daemon

Local daemon that exposes ABB robot controllers as a typed, versioned
`ControllerSnapshot` over HTTP and WebSocket. Covers RWS 1.0 (IRC5 / RobotWare 6)
and RWS 2.0 (OmniCore / RobotWare 7 and 8).

> **Status: early development.** Nothing to install yet. Watch or star the repo to
> follow progress.

## What it does

Built on [abb-rws-client](https://github.com/ichbinmeraj/abb-rws-client), it sits
between a controller and everything that wants to read from or write to it:

- **One state model.** Every consumer renders the same `ControllerSnapshot` -
  identity, link health, capabilities, panel, RAPID, motion, I/O, write access and
  the event log, each group carrying its own freshness.
- **One session per controller.** Robot Web Services caps sessions and degrades
  badly under churn. The daemon owns the session; consumers read the same snapshot
  instead of each opening their own.
- **One write gate.** Read-only by default. Writes are opt-in per surface and per
  action, pass a mastership-aware gate, and are audited.
- **Recordable.** Every controller interaction can be written to a file, so a
  session can be replayed as a test fixture.

## What it does not do

It is not a motion driver and issues no jog or motion commands of its own.

## Who talks to it

| Consumer | How |
|---|---|
| [abb-rws-ros2](https://github.com/ichbinmeraj/abb-rws-ros2) | loopback HTTP + WebSocket (the bridge is Python) |
| [abb-rws-mcp](https://github.com/ichbinmeraj/abb-rws-mcp) | in-process, as a library |
| Python client | loopback HTTP |

Not everything needs it. A VS Code extension on a developer's laptop, or the
conformance suite measuring the protocol itself, use `abb-rws-client` directly.
The daemon earns its place when a consumer is not TypeScript, shares a controller
with another live consumer, or needs the write gate and audit log.

## Related projects

- [abb-rws-client](https://github.com/ichbinmeraj/abb-rws-client): TypeScript RWS client tested on RobotWare 6, 7 and 8
- [abb-rws-ros2](https://github.com/ichbinmeraj/abb-rws-ros2): ROS 2 supervisory bridge
- [abb-rws-mcp](https://github.com/ichbinmeraj/abb-rws-mcp): MCP server for AI agents
- [abb-rws-conformance](https://github.com/ichbinmeraj/abb-rws-conformance): conformance suite and compatibility matrix
- [abb-rws-vscode](https://github.com/ichbinmeraj/abb-rws-vscode): RAPID Live, VS Code extension for ABB controllers

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). If you redistribute this
work, keep the NOTICE file.

Contributions are accepted under the DCO - see [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

Independent open-source project by [Meraj Safari](https://github.com/ichbinmeraj).
ABB, IRC5, OmniCore, RobotWare, RobotStudio and FlexPendant are trademarks of
ABB Ltd. **This project is not affiliated with, endorsed by, or supported by ABB Ltd.**
Project names and trademark position: see [TRADEMARKS.md](TRADEMARKS.md).
