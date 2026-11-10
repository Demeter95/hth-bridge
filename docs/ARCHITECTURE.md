# Architecture

## Components

| Component | Where | Role |
|---|---|---|
| Relay bot (`server/hth_relay.py`) | any always-on Linux host | Telegram long polling, queue files, delivery |
| Bridge plugin (`plugin/index.js`) | the PC running Harness | SSH queue reader, prompt injection, reply mirroring |
| Harness session | Harness | executes the agent turn with all tools |

## Data flow

```
Telegram → relay → in.jsonl ──ssh tail -f──► plugin ──sessionController.prompt──► session
                                                                                    │
Telegram ◄── relay ◄── out.jsonl ◄──ssh cat >>── plugin ◄──session/event── agent/turn ─┘
```

## Queue format

`in.jsonl` — one JSON object per line:

```json
{"id": "1794322766081", "ts": 1794322766, "text": "check the logs"}
```

`out.jsonl` — one JSON object per line:

```json
{"kind": "ack", "id": "1794322766081", "ok": true}
{"kind": "assistant", "text": "…", "ts": 1794322803270}
{"kind": "diag", "resolvedSession": "session-…", "agents": ["session-…"], "ts": 1794323014064}
{"kind": "bridge", "status": "started", "ts": 1794323014067}
```

`ack` with `ok:false` carries the harness-side error (unknown session, invalid prompt, etc.) and is surfaced in Telegram. `diag` and `bridge` are informational.
`out.offset` (server) and `stateDir/in.offset` (PC) are plain decimal byte counters.

## Reading without losing data

The plugin runs one long-lived `ssh host "tail -c +<offset+1> -f in.jsonl"`. Every consumed byte advances the local offset file, so:

- restarting the harness resumes from the exact byte;
- if the queue grows while the PC is off, the next start reads the backlog from the saved offset;
- if the SSH connection dies, the plugin reconnects after 3 s and continues from the same offset.

The relay mirrors this with `out.offset`.

## Prompt injection

The plugin calls the same API the web UI uses:

```js
await ctx.sessionController.prompt({
  requestId: randomUUID(),
  sessionId,
  mode: 'queue',              // queued behind an active turn, not interrupting it
  content: [{ type: 'text', text }],
}, new AbortController().signal)
```

`mode: 'steer'` would interrupt a running turn — deliberately not used.

## Reply filtering

Only turns **started by a bridged message** are mirrored:

- on successful injection the plugin increments a per-session counter;
- `turn/start` consumes one counter unit and records `bridgeTurn[session]`;
- `assistant/message` collects text blocks;
- `turn/end` writes the aggregated text only when `bridgeTurn[session]` is true.

Messages typed directly into the PC chat therefore stay local, and scheduled/goal turns are not mirrored either.

## Failure modes

| Failure | Behaviour |
|---|---|
| PC off | relay keeps queueing; delivery resumes on start |
| Harness restart | plugin reloads, offset preserved |
| SSH drop | reconnect with backoff |
| Bot token revoked | relay exits; restart after setting a new token |
| Wrong session id | `ack ok=false` with `session/not-found`, shown in Telegram |
| Message > 4096 chars | relay splits into 3900-char chunks |

## Compatibility

Written against the DeepSeek Harness Cordis host API: `ctx.sessionController.prompt`, `ctx.agents`, `ctx.sessions`, `ctx.on('session/event')`. The plugin is installed through the profile's `plugin_manager`, so it survives harness restarts and profile updates.
