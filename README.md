# Kyiv power alerts

A Telegram bot for a family chat in Kyiv. It watches the power outage schedule for one
outage group and posts when:

- the schedule for today or tomorrow is published or changes;
- emergency shutdowns are announced and the schedule stops applying, and when they end;
- an outage is about to start (30 minutes ahead by default);
- something in the bot itself breaks, and when it is fixed.

Commands, answered instantly:

| Command | Reply |
|---|---|
| `/status` | what the schedule says right now, the rest of today, tomorrow at a glance |
| `/today`, `/tomorrow` | the schedule for the day |

Messages are in Ukrainian.

## How it works

```
Cloudflare Worker  (worker/)
  cron every 2 min  -> Yasno API -> compare with KV state -> Telegram
  POST /telegram    <- bot commands (webhook)
  GET  /health      <- GitHub Actions monitor

GitHub Actions  (monitor/, every 30 min)
  asks /health; fails the run on problems the bot can't post itself -> GitHub emails the owner
```

Schedule data: `https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages`
(unofficial API, may change without notice).

## Failure monitoring

The bot reports its own problems to the chat once when they start and once when they
are fixed:

| Problem | Reported after |
|---|---|
| Yasno unreachable / HTTP errors | 60 min |
| Yasno data in an unexpected format, or a bug while processing it | 10 min |
| Unknown status or interval type in Yasno data | at once |
| Yasno serves yesterday's schedule | 30 min |
| Command webhook broken or repeatedly reset (reset once is repaired silently) | hourly check |

Problems the bot can't post to Telegram itself — the worker's scheduled check stopped,
or Telegram rejects the bot (token revoked, bot removed from the chat) — make the
`health` workflow fail, so GitHub emails the repository owner (at most once per
6 hours per problem). If the worker is unreachable at all, every run fails.

## Setup

```
cd worker
npx wrangler login
npx wrangler kv namespace create KV      # put the id into wrangler.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put CHAT_ID          # family chat id, starts with -100
npx wrangler secret put GROUP            # outage group, e.g. 3.1
npx wrangler secret put WEBHOOK_SECRET   # any random string
npx wrangler secret put HEALTH_SECRET    # another random string
npx wrangler deploy
```

Then open `https://<worker-url>/setup?key=<WEBHOOK_SECRET>` once: it registers the
webhook and the command list.

Repository secrets for the monitor: `WORKER_URL` (`https://<worker-url>`) and
`HEALTH_SECRET` (same value as in the worker).

Optional worker settings: `REMIND_MINUTES` (default `30`, `0` disables reminders),
`ALLOWED_CHATS` (extra chat ids allowed to use commands, comma-separated). Commands
from other chats are ignored.

## Local test

```
node -e "import('./worker/src/core.js').then(m => console.log(m.commandReply('/help')))"
```
