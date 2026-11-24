# Kyiv power alerts

Watches the Kyiv power outage schedule (Yasno / DTEK data) for one outage group
and posts to a Telegram chat when:

- the schedule for today or tomorrow is published;
- the schedule changes (the message includes the previous version);
- emergency shutdowns are announced and the schedule stops applying, and when they end;
- an outage is about to start (30 minutes ahead by default).

Messages are in Ukrainian. Runs on GitHub Actions every 10 minutes, no server needed.
The last seen schedule is stored in `state.json`.

## Setup

Settings → Secrets and variables → Actions:

| Kind | Name | Value |
|---|---|---|
| Secret | `TELEGRAM_BOT_TOKEN` | bot token from @BotFather |
| Secret | `TELEGRAM_CHAT_ID` | chat id (group chats start with `-100`) |
| Variable | `GROUP` | outage group, e.g. `3.1` |
| Variable | `REMIND_MINUTES` | optional, default `30`; `0` disables reminders |

Then enable the `check` workflow in the Actions tab.

## Local run

Prints messages instead of sending them:

```
GROUP=3.1 DRY_RUN=1 python check.py
```

## Data source

`https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages`
(unofficial API, may change without notice).
