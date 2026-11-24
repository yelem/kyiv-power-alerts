"""Reads new messages from the ДІМ.1557 Telegram bot (@claim_1557_bot) in the owner's
account and hands them to the worker, which posts them to the family chat.

Env: TG_API_ID, TG_API_HASH, TG_SESSION (from login.py), RELAY_URL, RELAY_SECRET
"""
import json
import os
import sys
import urllib.request

from telethon.sessions import StringSession
from telethon.sync import TelegramClient

BOT = "claim_1557_bot"
# Bot messages within this many seconds after our own message are replies to our
# requests, not outage notices, so they are skipped.
SOLICITED_WINDOW = 600

client = TelegramClient(StringSession(os.environ["TG_SESSION"]),
                        int(os.environ["TG_API_ID"]), os.environ["TG_API_HASH"])
client.connect()
try:
    if not client.is_user_authorized():
        sys.exit("Telegram session is no longer valid, run relay1557/login.py again")
    msgs = client.get_messages(BOT, limit=30)
finally:
    client.disconnect()

ours = [m.date for m in msgs if m.out]
items = [
    {"id": m.id, "date": int(m.date.timestamp()), "text": m.message}
    for m in msgs
    if not m.out and m.message
    and not any(0 <= (m.date - t).total_seconds() <= SOLICITED_WINDOW for t in ours)
]

req = urllib.request.Request(
    os.environ["RELAY_URL"],
    data=json.dumps({"messages": items}).encode(),
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ['RELAY_SECRET']}"},
)
with urllib.request.urlopen(req, timeout=30) as r:
    print(r.read().decode())
