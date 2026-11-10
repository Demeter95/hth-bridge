#!/usr/bin/env python3
"""HTH relay bot — Telegram side of the Harness ↔ Telegram bridge.

Receives messages from one allowed Telegram user, appends them to
``<HTH_DIR>/in.jsonl`` (read by the Harness plugin over SSH) and tails
``<HTH_DIR>/out.jsonl`` to deliver the agent's answers back to Telegram.

Pure standard library; no webhooks, no inbound ports — long polling only.

Environment:
    HTH_BOT_TOKEN        Telegram bot token (required)
    HTH_ADMIN_ID         numeric Telegram id allowed to use the bridge (required)
    HTH_DIR              queue directory (default /var/lib/hth)
    HTH_PREFIX           message prefix routed to the harness (default "чат:")
    HTH_ALLOW_NO_PREFIX  1 = route every message of the admin (default 0)
"""
import json
import os
import ssl
import sys
import threading
import time
import urllib.request

TOKEN = os.environ.get("HTH_BOT_TOKEN", "").strip()
ADMIN = int(os.environ.get("HTH_ADMIN_ID", "0") or 0)
DIR = os.environ.get("HTH_DIR", "/var/lib/hth")
PREFIX = os.environ.get("HTH_PREFIX", "чат:")
ALLOW_NO_PREFIX = os.environ.get("HTH_ALLOW_NO_PREFIX", "0") == "1"

IN_FILE = os.path.join(DIR, "in.jsonl")
OUT_FILE = os.path.join(DIR, "out.jsonl")
OUT_OFFSET = os.path.join(DIR, "out.offset")

API = "https://api.telegram.org/bot" + TOKEN
CTX = ssl.create_default_context()

if not TOKEN or not ADMIN:
    print("HTH_BOT_TOKEN and HTH_ADMIN_ID are required", flush=True)
    sys.exit(1)

os.makedirs(DIR, exist_ok=True)


def api(method, **params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(API + "/" + method, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print("telegram error", method, e, flush=True)
        return {"ok": False}


def send(chat_id, text):
    for i in range(0, len(text), 3900):
        api("sendMessage", chat_id=chat_id, text=text[i:i + 3900],
            disable_web_page_preview=True)


def queue_in(text):
    line = json.dumps({"id": str(int(time.time() * 1000)), "ts": int(time.time()),
                       "text": text}, ensure_ascii=False)
    with open(IN_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")
        f.flush()
        os.fsync(f.fileno())


def pump():
    """Watch out.jsonl and deliver the agent's answers to Telegram."""
    offset = 0
    buf = b""
    try:
        if os.path.exists(OUT_OFFSET):
            offset = int(open(OUT_OFFSET, encoding="utf-8").read().strip() or 0)
    except Exception:
        offset = 0
    while True:
        try:
            size = os.path.getsize(OUT_FILE) if os.path.exists(OUT_FILE) else 0
            if offset > size:
                offset, buf = 0, b""
            if size > offset:
                with open(OUT_FILE, "rb") as f:
                    f.seek(offset)
                    buf += f.read(size - offset)
                offset = size
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    kind = obj.get("kind")
                    if kind == "assistant" and obj.get("text"):
                        send(ADMIN, str(obj["text"]))
                    elif kind == "ack" and obj.get("ok") is False:
                        send(ADMIN, "⚠️ Harness rejected the message: "
                             + str(obj.get("error"))[:200])
                with open(OUT_OFFSET, "w", encoding="utf-8") as f:
                    f.write(str(offset))
        except Exception as e:
            print("pump error", e, flush=True)
        time.sleep(2)


def strip_prefix(text):
    low = text.lower()
    if PREFIX and low.startswith(PREFIX.lower()):
        return text[len(PREFIX):].strip()
    return None


def handle_message(m):
    if m.get("chat", {}).get("type") != "private":
        return
    uid = m["from"]["id"]
    cid = m["chat"]["id"]
    text = (m.get("text") or "").strip()
    if uid != ADMIN:
        send(cid, "Access denied.")
        return
    if text.startswith("/start") or text.startswith("/help"):
        send(cid, "HTH bridge.\n\n"
                  f"Send «{PREFIX} your message» — it goes to the Harness session on the PC; "
                  "the agent's answer comes back here.\n\n"
                  "/status — queue state.")
        return
    if text.startswith("/status"):
        try:
            size_in = os.path.getsize(IN_FILE) if os.path.exists(IN_FILE) else 0
            size_out = os.path.getsize(OUT_FILE) if os.path.exists(OUT_FILE) else 0
            off = open(OUT_OFFSET, encoding="utf-8").read().strip() if os.path.exists(OUT_OFFSET) else "0"
        except Exception:
            size_in = size_out = 0
            off = "0"
        send(cid, f"in queue: {size_in} bytes\nout queue: {size_out} bytes (read {off})\n"
                  f"prefix: «{PREFIX}»")
        return
    body = strip_prefix(text)
    if body is None and ALLOW_NO_PREFIX and not text.startswith("/"):
        body = text
    if body is not None:
        if not body:
            send(cid, f"Add the text after the prefix, e.g. «{PREFIX} check the logs».")
            return
        queue_in(body)
        send(cid, "⏳ Forwarded to the Harness session. The answer will arrive here.")
        return
    send(cid, f"Use the prefix «{PREFIX}», e.g. «{PREFIX} what's in my workspace?»")


def run():
    print("hth relay started", flush=True)
    threading.Thread(target=pump, daemon=True).start()
    offset = 0
    while True:
        try:
            r = api("getUpdates", offset=offset, timeout=25,
                    allowed_updates=["message"])
        except Exception as e:
            print("poll error", e, flush=True)
            time.sleep(5)
            continue
        if not r.get("ok"):
            time.sleep(5)
            continue
        for upd in r.get("result", []):
            offset = max(offset, upd["update_id"] + 1)
            try:
                if "message" in upd:
                    handle_message(upd["message"])
            except Exception as e:
                print("update error", e, flush=True)


if __name__ == "__main__":
    run()
