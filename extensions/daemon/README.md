# Pi Remote Daemon

The extension automatically starts a local daemon (if necessary), registers the
current Pi session, forwards lifecycle/tool/message events, and makes browser
messages available to the live Pi session.

## Usage

Load `extensions/daemon/index.ts` in Pi (it is included in this package). The
daemon listens on this machine's current Tailscale IPv4 address
(`100.64.209.124:4317` in this setup) by default. Open
<http://100.64.209.124:4317> from a device on the same tailnet to view sessions.

Override the endpoint with `PI_REMOTE_HOST` and `PI_REMOTE_PORT`. Access is
governed by your Tailscale ACLs. Do not bind to `0.0.0.0` unless you
intentionally accept the additional security implications. Alternatively, bind
to localhost and expose it through Tailscale Serve:

```sh
PI_REMOTE_HOST=127.0.0.1 tailscale serve http://127.0.0.1:4317
```

You can also start the daemon manually with `node
extensions/daemon/daemon/main.js`. It remains alive after Pi exits. For sessions
registered while the daemon is running, the session page reads the active branch
from Pi's JSONL file (read-only) and loads older messages in pages. Offline
session discovery after a daemon restart is not implemented.

## HTTP and WebSocket API

- `GET /health`
- `GET /api/sessions`
- `GET /api/sessions/:sessionId`
- `GET /api/sessions/:sessionId/history?limit=60&before=<entryId>`
- `POST /api/sessions/:sessionId/messages` with `{ "text": "..." }`
- `POST /api/sessions/:sessionId/abort` to stop the current Pi generation
- `POST /api/sessions/:sessionId/commands` with `{ "name": "...", "args": "..." }`
- `WS /internal` for Pi extension clients
- `WS /ws/sessions/:sessionId` for session event streams

The daemon forwards input only to a writable live instance. The first instance
for a session gets write access; additional simultaneously registered
instances are marked non-writable to avoid duplicate input delivery.

The session page renders streamed thinking in a collapsed section, pages
read-only history from the registered session's active branch, and swaps the
Send button for Stop while Pi is generating. Type `/` to filter available
commands; selecting one completes it in the input. Commands are dispatched back
through Pi's extension/prompt command expansion rather than executed by the daemon.
