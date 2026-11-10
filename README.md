# HTH — Harness ↔ Telegram Bridge

**Use your DeepSeek Harness agent from Telegram.** Send a message from your phone, get the agent's answer back — while the agent keeps running on your PC, in the same session, with all its tools, files and context.

The bridge is a small **host plugin** for DeepSeek Harness plus a **relay bot** that can run on any always-on server (a VPS, a Raspberry Pi, or the same PC). No inbound ports, no public endpoints — everything works over an SSH connection initiated by the PC.

```
┌──────────┐    Telegram     ┌──────────────────┐    SSH     ┌─────────────────────┐
│  Phone   │ ──────────────► │  Relay bot (VPS) │ ◄───────── │  Harness plugin     │
│ Telegram │ ◄────────────── │  queue files     │ ─────────► │  (your PC, session) │
└──────────┘                 └──────────────────┘            └─────────┬───────────┘
                                                                      │
                                                              ┌───────▼────────┐
                                                              │  Agent session │
                                                              │  tools · files │
                                                              └────────────────┘
```

## Features

- **One session, anywhere.** Continue the very same Harness conversation from your phone; the context, the workspace, the tools — all of it.
- **No inbound ports.** The plugin opens an outbound SSH connection and tails a queue file; nothing is exposed to the internet.
- **Queue survives downtime.** Turn the PC off; messages wait on the server and are delivered when the harness comes back.
- **Only Telegram turns are mirrored.** Replies to messages you type directly in the PC chat are *not* sent to Telegram.
- **One answer per turn.** The plugin aggregates the assistant's text for the whole turn and sends it once, split into Telegram-sized chunks.
- **Admin-only.** The relay answers a single configured Telegram user and ignores everyone else.
- **Configurable trigger.** `чат:` (Russian "chat:"), `>` or any other prefix — or no prefix at all.
- **Crash-tolerant.** SSH connection drops are re-established; the read offset is persisted on disk.

## Requirements

| Part | What you need |
|---|---|
| PC | DeepSeek Harness desktop with the `plugin_manager` tool (any profile) |
| Server | any Linux host reachable over SSH (a VPS, a home server, or the same machine) |
| Telegram | a bot token from [@BotFather](https://t.me/BotFather) and your numeric Telegram user id |
| Access | an SSH key that the PC can use to reach the server |

## Quick start

### 1. Create the bot

Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token. Find your numeric id with [@userinfobot](https://t.me/userinfobot).

### 2. Install the relay on the server

```bash
install -d /opt/hth
cp server/hth_relay.py /opt/hth/
cat > /etc/systemd/system/hth-relay.service <<'EOF'
[Unit]
Description=HTH relay bot
After=network-online.target

[Service]
Environment=HTH_BOT_TOKEN=123456:ABC-your-token
Environment=HTH_ADMIN_ID=123456789
Environment=HTH_DIR=/var/lib/hth
ExecStart=/usr/bin/python3 /opt/hth/hth_relay.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now hth-relay
```

### 3. Install the plugin on the PC

Copy the `plugin/` directory to your machine and install it through the plugin manager (or add it to your Cordis composition by hand):

```
plugin_manager install_bundle  target=<absolute path to the plugin directory>
```

Then edit the bundle entry's config (or `plugin/cordis.patch.yml` before installing):

```yaml
- insert:
    - id: hth-bridge
      name: '@local/hth-bridge'
      config:
        host: root@your-server.example
        keyPath: 'C:\Users\you\.ssh\id_ed25519'
        stateDir: 'C:\Users\you\.hth-bridge'
        sessionId: ''        # empty = auto: the most recently active session
```

### 4. Write to the bot

```
чат: привет, что у тебя в рабочей папке?
```

The agent answers in the chat, and the answer arrives in Telegram.

## Configuration

### Plugin (`cordis.patch.yml`)

| Key | Default | Meaning |
|---|---|---|
| `host` | `user@your-server.example` | SSH target for the relay |
| `keyPath` | `''` | private key path (empty = SSH agent/default keys) |
| `knownHostsPath` | `''` | known_hosts file |
| `stateDir` | `~/.hth-bridge` | where the read offset is stored |
| `sessionId` | `''` | exact session id; empty = newest session on disk |
| `inFile` | `/var/lib/hth/in.jsonl` | inbound queue path on the server |
| `outFile` | `/var/lib/hth/out.jsonl` | outbound queue path |
| `dryRun` | `false` | log incoming messages without injecting them |

> The paths in the example config point to the queue files the relay writes. They must match `HTH_DIR` on the server.

### Relay (`hth_relay.py`, environment)

| Variable | Default | Meaning |
|---|---|---|
| `HTH_BOT_TOKEN` | — | Telegram bot token (required) |
| `HTH_ADMIN_ID` | — | numeric Telegram id allowed to use the bridge (required) |
| `HTH_DIR` | `/var/lib/hth` | directory for `in.jsonl`, `out.jsonl`, `out.offset` |
| `HTH_PREFIX` | `чат:` | message prefix that routes to the harness |
| `HTH_ALLOW_NO_PREFIX` | `0` | `1` = every private message from the admin goes to the harness |

## How it works

1. You send `чат: <text>` to the bot. The relay appends `{"id": "...", "text": "<text>"}` to `in.jsonl` and answers “forwarded”.
2. The plugin keeps a long-lived `ssh host "tail -c +<offset+1> -f in.jsonl"` and reads new lines, persisting `<offset>` locally.
3. Each line is injected into the Harness session with `sessionController.prompt({ mode: 'queue', ... })` — the same path the web UI uses, so the message queues behind an active turn instead of interrupting it.
4. The plugin listens to `session/event`:
   - `turn/start` — remembers whether this turn was started by a bridged message,
   - `assistant/message` — collects the assistant's text blocks,
   - `turn/end` — writes `{"kind": "assistant", "text": "..."}` to `out.jsonl` **only if the turn came from Telegram**.
5. The relay tails `out.jsonl` (offset persisted) and sends the text to you, splitting long messages into 3900-character chunks.

Because the queue lives on the server and the offset lives on the PC, a shutdown on either side loses nothing: the relay keeps the outbound lines, the plugin resumes from the exact byte it stopped at.

## Security

This plugin gives Telegram **full control of an agent that has full control of your machine**. Treat the bot token like a root password.

- Only `HTH_ADMIN_ID` is served; other users get a single "access denied" message.
- SSH is key-based; the PC initiates the connection; no ports are opened on either side.
- Queue files are plain JSONL — keep them readable only by the relay user (`chmod 700` on the directory).
- The bot token lives in the systemd unit — restrict the unit file to root (`chmod 600`).
- If the token leaks, revoke it in BotFather immediately and restart the relay.

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model.

## Limitations

- The PC and the harness must be running; otherwise messages wait in the queue.
- The bridge drives **one session** at a time (the configured id or the most recently active one).
- Telegram allows ~4096 characters per message; the relay splits longer answers.
- The relay speaks the Telegram Bot API over plain HTTPS long polling — no webhooks needed.

## FAQ

**Does it need a public IP or a tunnel?** No. The plugin connects *out* over SSH. Nothing listens on the internet.

**Can I use it without a VPS?** Yes — run the relay on the same machine; the plugin will use a local SSH connection (or `localhost`).

**Does it work with other agents?** It is written against the DeepSeek Harness Cordis API (`sessionController`, `session/event`). Porting to another framework means replacing those two integration points.

**Can several people use one bridge?** No. One admin id, one session. That is a deliberate safety choice.

**What if I restart the harness?** The plugin reloads with it and resumes from the saved offset.

## Project layout

```
plugin/          Cordis host plugin (index.js, manifest, patch, locales, icon)
server/          Telegram relay bot (Python, stdlib only)
docs/            INSTALL.md, ARCHITECTURE.md, SECURITY.md
```

## License

MIT — see [LICENSE](LICENSE).

---

## По-русски

**HTH** — мост между DeepSeek Harness на вашем ПК и Telegram. Пишете боту «чат: …» — сообщение попадает в ту же сессию агента (со всеми инструментами и контекстом), ответ возвращается в Telegram. Работает через исходящий SSH, портов не открывает; очередь переживает выключение ПК.

Подробная установка — [docs/INSTALL.md](docs/INSTALL.md). Кратко: создайте бота у @BotFather → разверните `server/hth_relay.py` на сервере → установите `plugin/` в Harness через plugin manager → укажите в конфиге `host`, `keyPath`, пути к очередям.
