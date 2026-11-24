"""Checks the Yasno outage schedule for one Kyiv group and posts changes to Telegram.

Env:
  GROUP               outage group, e.g. "3.1" (required)
  TELEGRAM_BOT_TOKEN  bot token (required unless DRY_RUN)
  TELEGRAM_CHAT_ID    target chat id (required unless DRY_RUN)
  REMIND_MINUTES      remind this many minutes before an outage (default 30, 0 = off)
  DRY_RUN             if set, print messages instead of sending
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

API = "https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages"
TZ = ZoneInfo("Europe/Kyiv")
STATE_FILE = Path(__file__).with_name("state.json")

GROUP = os.environ.get("GROUP", "").strip()
REMIND_MIN = int(os.environ.get("REMIND_MINUTES") or 30)
DRY_RUN = bool(os.environ.get("DRY_RUN"))

APPLIES = "ScheduleApplies"
WAITING = "WaitingForSchedule"


def is_emergency(status):
    # "EmergencyShutdowns" or any other unknown status means the schedule is not in effect
    return status not in (APPLIES, WAITING, None)


def fetch():
    req = urllib.request.Request(API, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def ddmm(date):
    return datetime.fromisoformat(date).strftime("%d.%m")


def parse_day(d):
    """Return {date, status, outages: [[start_min, end_min, type], ...]} with adjacent slots merged."""
    if not d or "date" not in d:
        return None
    outages = []
    for s in d.get("slots", []):
        t = s.get("type")
        if t == "NotPlanned":
            continue
        if outages and outages[-1][1] == s["start"] and outages[-1][2] == t:
            outages[-1][1] = s["end"]
        else:
            outages.append([s["start"], s["end"], t])
    return {"date": d["date"][:10], "status": d.get("status"), "outages": outages}


def fmt_outages(outages):
    if not outages:
        return ["Відключень немає."]
    lines = []
    for a, b, t in outages:
        lines.append(f"  {hhmm(a)}–{hhmm(b)}" + ("" if t == "Definite" else " (можливо)"))
    off = sum(b - a for a, b, t in outages if t == "Definite")
    if off:
        h, m = divmod(off, 60)
        lines.append(f"Без світла: {h} год" + (f" {m} хв" if m else ""))
    return lines


def fmt_day(day, title):
    head = f"<b>{title}, {ddmm(day['date'])}</b> (група {GROUP})"
    return "\n".join([head] + fmt_outages(day["outages"]))


def day_message(title, day, old):
    """Change of one day's schedule as (kind, text), or None.

    kind "emergency" -> text is the date; "ended"/"new" -> text is the day block
    (same-kind entries share one header); "other" -> a complete message.
    """
    new_st, old_st = day["status"], old["status"] if old else None
    date = ddmm(day["date"])

    if is_emergency(new_st):
        if is_emergency(old_st):
            return None
        return "emergency", date

    if new_st == WAITING:
        if old_st == APPLIES:
            return "other", f"Графік на {date} скасовано, очікується новий."
        if is_emergency(old_st):
            return "other", f"Аварійні відключення на {date} завершено. Новий графік ще не опубліковано."
        return None

    # new_st == APPLIES
    if is_emergency(old_st):
        return "ended", fmt_day(day, title)
    if old_st != APPLIES:
        return "new", fmt_day(day, title)
    if old["outages"] != day["outages"]:
        return "other", ("<b>Графік змінився</b>\n" + fmt_day(day, title)
                + "\n\n<i>Було:</i>\n" + "\n".join(fmt_outages(old["outages"])))
    return None


def outage_intervals(days):
    """Absolute Definite outage intervals of days where the schedule applies, merged over midnight."""
    res = []
    for day in days:
        if day["status"] != APPLIES:
            continue
        base = datetime.fromisoformat(day["date"]).replace(tzinfo=TZ)
        for a, b, t in day["outages"]:
            if t != "Definite":
                continue
            start, end = base + timedelta(minutes=a), base + timedelta(minutes=b)
            if res and res[-1][1] == start:
                res[-1][1] = end
            else:
                res.append([start, end])
    return res


def send(text):
    if DRY_RUN:
        print("---- message ----\n" + text)
        return
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    body = urllib.parse.urlencode({
        "chat_id": os.environ["TELEGRAM_CHAT_ID"],
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": "true",
    }).encode()
    with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", body, timeout=30) as r:
        r.read()


def main():
    if not GROUP:
        sys.exit("GROUP is not set")
    try:
        data = fetch()
    except Exception as e:  # Yasno is flaky sometimes; don't fail the run, try next time
        print(f"WARN: fetch failed: {e}")
        return
    if GROUP not in data:
        sys.exit(f"group {GROUP!r} not found; available: {', '.join(data)}")
    g = data[GROUP]

    state = json.loads(STATE_FILE.read_text("utf-8")) if STATE_FILE.exists() else {}
    prev_days = state.get("days", {})
    reminded = state.get("reminded", [])
    now = datetime.now(TZ)
    today = now.strftime("%Y-%m-%d")

    days = [(t, parse_day(g.get(k))) for k, t in (("today", "Сьогодні"), ("tomorrow", "Завтра"))]
    days = [(t, d) for t, d in days if d]
    messages = []

    # 1. schedule published / changed / emergency mode
    new_days, changes = {}, []
    for title, day in days:
        new_days[day["date"]] = {"status": day["status"], "outages": day["outages"]}
        change = day_message(title, day, prev_days.get(day["date"]))
        if change:
            changes.append(change)

    def of(kind):
        return [text for k, text in changes if k == kind]

    if of("emergency"):
        messages.append(f"<b>Увага: аварійні відключення.</b>\nГрафік на {' і '.join(of('emergency'))} "
                        f"(група {GROUP}) не діє, світло можуть вимкнути в будь-який час.")
    if of("ended"):
        messages.append("<b>Аварійні відключення завершено, графік знову діє.</b>\n\n" + "\n\n".join(of("ended")))
    if of("new"):
        messages.append("<b>Графік відключень</b>\n\n" + "\n\n".join(of("new")))
    messages += of("other")

    # 2. reminders before scheduled outages
    if REMIND_MIN > 0:
        for start, end in outage_intervals([d for _, d in days]):
            key = start.isoformat()
            left = (start - now).total_seconds() / 60
            if 0 < left <= REMIND_MIN and key not in reminded:
                reminded.append(key)
                messages.append(f"Через {round(left)} хв відключення світла: {start:%H:%M}–{end:%H:%M}")

    if messages:
        send("\n\n".join(messages))

    new_state = {
        "days": new_days,
        "reminded": [k for k in reminded if k[:10] >= today],
    }
    if new_state != state:
        STATE_FILE.write_text(json.dumps(new_state, ensure_ascii=False, indent=1) + "\n", "utf-8")


if __name__ == "__main__":
    main()
