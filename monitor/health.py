"""Asks the worker about problems it cannot report to Telegram itself (its scheduled
check stopped, or Telegram rejects the bot). Fails the job in that case, so GitHub
emails the repository owner. The worker limits this to one email per problem per 6 hours.

Env: WORKER_URL (https://<worker>.workers.dev), HEALTH_SECRET
"""
import json
import os
import sys
import urllib.request

req = urllib.request.Request(os.environ["WORKER_URL"].rstrip("/") + "/health", headers={
    "Authorization": f"Bearer {os.environ['HEALTH_SECRET']}",
    # Cloudflare rejects the default "Python-urllib" user agent (error 1010)
    "User-Agent": "kyiv-power-alerts-monitor",
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
