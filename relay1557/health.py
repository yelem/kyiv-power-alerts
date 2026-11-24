"""Asks the worker about problems it cannot report to Telegram itself (its scheduled
check stopped, or Telegram rejects the bot). Fails the job in that case, so GitHub
emails the repository owner. The worker limits this to one email per 6 hours.

Env: RELAY_URL, RELAY_SECRET
"""
import json
import os
import sys
import urllib.request

url = os.environ["RELAY_URL"].rsplit("/", 1)[0] + "/health"
req = urllib.request.Request(url, headers={
    "Authorization": f"Bearer {os.environ['RELAY_SECRET']}",
    "User-Agent": "kyiv-power-alerts-relay",
})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        h = json.load(r)
except Exception as e:
    sys.exit(f"The bot's Cloudflare worker is unreachable ({type(e).__name__}). "
             "Check https://dash.cloudflare.com -> Workers & Pages -> kyiv-power-alerts.")

for issue in h["issues"]:
    print("problem:", issue)
if h["notify"]:
    sys.exit("The bot cannot report this to Telegram itself, see the problems above.")
print("ok" if h["ok"] else "known problem, the email was already sent")
