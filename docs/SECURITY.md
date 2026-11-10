# Security

## Threat model

The bridge is a **remote control for an agent that has full access to your machine** — it can read files, run commands, and change the workspace. Anyone who can write to the bot controls that agent. Treat the bot token as a root credential.

| Asset | Risk | Mitigation |
|---|---|---|
| Bot token | full control of the bridge | BotFather token, stored in a `0600` systemd unit, never committed |
| Queue files | plaintext commands and answers | directory `0700`, owned by root |
| SSH key | remote shell on the server | key-based auth, dedicated key, no agent forwarding |
| Harness session | full tool access | one configured session, one admin id |
| Telegram account | bot takeover via 2FA bypass | enable 2FA and session management in Telegram |

## Defaults that matter

- The relay answers **only** `HTH_ADMIN_ID`; every other user gets a single “Access denied”.
- The plugin opens **outbound** SSH only. Nothing listens on the internet; no webhook URL exists.
- The prompt is injected with `mode: 'queue'` — a stray message cannot interrupt a running turn.
- Only **Telegram-originated** turns are mirrored; GUI turns stay on the PC.

## Hardening checklist

- [ ] Use a dedicated SSH key (`ssh-keygen -t ed25519 -C hth-bridge`) with `no-port-forwarding` if the key is only for the queue.
- [ ] `chmod 700 /var/lib/hth`, `chmod 600 /etc/systemd/system/hth-relay.service`.
- [ ] Run the relay as a dedicated unprivileged user when you do not need `/var/lib` root access.
- [ ] Do not add the bridge to a group chat; the relay ignores non-private chats by design.
- [ ] Revoke the token in BotFather if it ever leaks; restart the relay.
- [ ] Keep Harness and the plugin up to date; the `sessionController` API is versioned by the harness.

## What this project does not protect against

- A compromised PC (the agent runs with your user rights).
- A Telegram account takeover (the attacker becomes the admin).
- Malicious prompts: the agent may act on instructions it receives through Telegram — review what you send.

## Reporting

Open an issue for vulnerabilities; do not paste tokens, keys, or session logs.
