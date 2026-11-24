"""Run once on your own PC: logs into your Telegram account and saves the session
straight into the repository's GitHub secrets (it is never printed).

Get api_id and api_hash at https://my.telegram.org -> API development tools.
Requires: pip install telethon, and gh logged in.
"""
import subprocess

from telethon.sessions import StringSession
from telethon.sync import TelegramClient

REPO = "yelem/kyiv-power-alerts"

api_id = input("api_id: ").strip()
api_hash = input("api_hash: ").strip()

# start() asks for the phone number, the login code and the 2FA password if set
with TelegramClient(StringSession(), int(api_id), api_hash) as client:
    session = client.session.save()
    name = client.get_me().first_name

for key, value in (("TG_API_ID", api_id), ("TG_API_HASH", api_hash), ("TG_SESSION", session)):
    subprocess.run(["gh", "secret", "set", key, "-R", REPO], input=value, text=True, check=True)

print(f"Done: logged in as {name}, session saved to GitHub secrets of {REPO}.")
