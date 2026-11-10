# Installation

> Time: ~15 minutes. You need a PC with DeepSeek Harness, a Linux host reachable over SSH, and a Telegram bot.

## 0. Prerequisites

- **DeepSeek Harness** on the PC — the profile must include the `plugin_manager` tool (the desktop build does).
- **SSH access** from the PC to the server, key-based (passwordless). Verify: `ssh -i <key> user@server 'echo ok'`.
- **A Telegram bot**: [@BotFather](https://t.me/BotFather) → `/newbot` → token.
- **Your Telegram id**: [@userinfobot](https://t.me/userinfobot).

## 1. Server: queue directory and relay

```bash
install -d -m 700 /var/lib/hth
install -d /opt/hth
cp server/hth_relay.py /opt/hth/
chmod 755 /opt/hth/hth_relay.py
```

Create `/etc/systemd/system/hth-relay.service`:

```ini
[Unit]
Description=HTH relay bot
After=network-online.target

[Service]
Environment=HTH_BOT_TOKEN=123456:ABC-your-token
Environment=HTH_ADMIN_ID=123456789
Environment=HTH_DIR=/var/lib/hth
Environment=HTH_PREFIX=чат:
ExecStart=/usr/bin/python3 /opt/hth/hth_relay.py
Restart=always
RestartSec=3
StandardOutput=journal

[Install]
WantedBy=multi-user.target
```

```bash
chmod 600 /etc/systemd/system/hth-relay.service   # the token lives here
touch /var/lib/hth/in.jsonl /var/lib/hth/out.jsonl
chown -R root:root /var/lib/hth
systemctl daemon-reload
systemctl enable --now hth-relay
journalctl -u hth-relay -n 20 --no-pager
```

Write `чат: ping` to the bot: it should answer “⏳ Forwarded…”. The message is now in `/var/lib/hth/in.jsonl`.

## 2. PC: install the plugin

1. Copy the `plugin/` directory somewhere permanent, e.g. `C:\Tools\hth-bridge`.
2. Edit `plugin/cordis.patch.yml` — set at least `host` and `keyPath`:

```yaml
- insert:
    - id: hth-bridge
      name: '@local/hth-bridge'
      config:
        host: root@your-server.example
        keyPath: 'C:\Users\you\.ssh\id_ed25519'
        inFile: /var/lib/hth/in.jsonl
        outFile: /var/lib/hth/out.jsonl
        stateDir: 'C:\Users\you\.hth-bridge'
        sessionId: ''
```

3. Install it in the current profile (through the harness, not by hand):

```
plugin_manager action=install_bundle target=<absolute path to plugin/>
```

Read the result: `application` must be `applied`. The new row appears in Settings → Plugins as **HTH Bridge**.

4. Verify the plugin is alive: the log shows `starting bridge to …` and the server's `out.jsonl` receives a `{"kind":"bridge","status":"started"}` line within a couple of seconds.

If the file did not exist yet, the plugin starts at the current end of the queue — it never replays history.

## 3. First round trip

```
чат: hello
```

Expected sequence:

1. relay → `in.jsonl` + Telegram reply “⏳ Forwarded…”;
2. plugin → injects the prompt into the newest session;
3. the agent answers in the harness;
4. at the end of the turn the plugin writes `{"kind":"assistant","text":"…"}` to `out.jsonl`;
5. relay → Telegram message.

## 4. Choosing the session

By default the plugin targets the **most recently active session** (the newest `session.v*.jsonl.*` under `~/.dsh/sessions`). To pin a specific one, set `sessionId` in the config — the exact id, including the `session-` prefix when present (e.g. `session-0fed2e76-3bed-4d53-ab2c-6589b86a5d18`).

## Troubleshooting

| Symptom | Check |
|---|---|
| Bot answers “Forwarded”, nothing in the harness | plugin log `tail from offset`; `journalctl -u hth-relay`; SSH from the PC by hand |
| `ack ok=false, error "session: session/not-found"` | wrong `sessionId` — clear it (auto) or copy the exact id |
| `ack ok=false, error "signal…"` / other | plugin and harness versions are incompatible — update the plugin |
| Answers never reach Telegram | `out.offset` vs file size on the server; relay must be running; only Telegram-originated turns are mirrored |
| SSH keeps dropping | keepalive is built in; check `ServerAliveInterval` and the server's `ClientAliveInterval` |
| Duplicate answers | two bridge plugins installed (old and new) — remove the old one |

## Uninstall

```
plugin_manager action=remove_bundle target=@local/hth-bridge
systemctl disable --now hth-relay
rm -rf /opt/hth /var/lib/hth
```
