# Kyiv power alerts

A Telegram bot for a family chat in Kyiv. It watches the power outage schedule for one
outage group and relays address-specific notices from the city utility dispatch service
ДІМ.1557.

The bot posts when:

- the schedule for today or tomorrow is published or changes;
- emergency shutdowns are announced and the schedule stops applying, and when they end;
- an outage is about to start (30 minutes ahead by default);
- @claim_1557_bot sends a notice about the subscribed address.

Commands, answered instantly:

| Command | Reply |
|---|---|
| `/status` | what the schedule says right now, the rest of today, tomorrow at a glance |
| `/today`, `/tomorrow` | the schedule for the day |
| `/dim1557` | the last notices from ДІМ.1557 |

Messages are in Ukrainian.

## How it works

```
Cloudflare Worker  (worker/)
  cron every 2 min  -> Yasno API -> compare with KV state -> Telegram
  POST /telegram    <- bot commands (webhook)
  POST /relay1557   <- notices from the relay below

GitHub Actions  (relay1557/, every 10 min)
  owner's Telegram account (Telethon) -> new messages from @claim_1557_bot -> worker
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
| ДІМ.1557 check failing (session revoked, menu changed, no answer) | 3 runs in a row |
| ДІМ.1557 check not running at all (GitHub Actions stopped) | 60 min |
| Command webhook broken or repeatedly reset (reset once is repaired silently) | hourly check |

Problems the bot can't post to Telegram itself — the worker's scheduled check stopped,
or Telegram rejects the bot (token revoked, bot removed from the chat) — make the
`relay-1557` workflow fail, so GitHub emails the repository owner (at most once per
6 hours per problem). If the worker is unreachable at all, every run fails.

## Setup

### Worker

```
cd worker
npx wrangler login
npx wrangler kv namespace create KV      # put the id into wrangler.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put CHAT_ID          # family chat id, starts with -100
npx wrangler secret put GROUP            # outage group, e.g. 3.1
npx wrangler secret put WEBHOOK_SECRET   # any random string
npx wrangler secret put RELAY_SECRET     # another random string
npx wrangler deploy
```

Then open `https://<worker-url>/setup?key=<WEBHOOK_SECRET>` once: it registers the
webhook and the command list.

Optional: `REMIND_MINUTES` (default `30`, `0` disables reminders), `ALLOWED_CHATS`
(extra chat ids allowed to use commands, comma-separated). Commands from other chats
are ignored.

### ДІМ.1557 relay

1. Subscribe to your address in @claim_1557_bot.
2. Get `api_id` and `api_hash` at https://my.telegram.org (API development tools).
3. On your PC: `pip install telethon`, then `python relay1557/login.py`. It logs in and
   stores `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` as repository secrets.
4. Add repository secrets `RELAY_URL` (`https://<worker-url>/relay1557`) and
   `RELAY_SECRET` (same value as in the worker).

The first sync only remembers existing messages; later ones are posted to the chat.
Bot replies within 10 minutes after your own message to @claim_1557_bot are treated as
answers to your requests and are not relayed.

`TG_SESSION` gives full access to the Telegram account. Keep it only in GitHub secrets;
to revoke it, end the session in Telegram → Settings → Devices.

## Local test

```
node -e "import('./worker/src/core.js').then(m => console.log(m.commandReply('/help')))"
```
