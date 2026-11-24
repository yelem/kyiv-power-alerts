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

STATUS_TEXT = {
    "WaitingForSchedule": "⏳ график ещё не опубликован",
    "EmergencyShutdowns": "⚠️ аварийные отключения — график не действует",
}


def fetch():
    req = urllib.request.Request(API, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


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
        return ["✅ отключений нет"]
    lines = []
    for a, b, t in outages:
        mark = "🔴" if t == "Definite" else "🟡 возможно"
        lines.append(f"{mark} {hhmm(a)}–{hhmm(b)}")
    off = sum(b - a for a, b, t in outages if t == "Definite")
    if off:
        h, m = divmod(off, 60)
        lines.append(f"Без света: {h} ч" + (f" {m} мин" if m else ""))
    return lines


def fmt_day(day, title):
    d = datetime.fromisoformat(day["date"])
    lines = [f"<b>{title}, {d:%d.%m}</b> (группа {GROUP})"]
    if day["status"] != "ScheduleApplies":
        lines.append(STATUS_TEXT.get(day["status"], f"статус: {day['status']}"))
    if day["status"] == "ScheduleApplies" or day["outages"]:
        lines += fmt_outages(day["outages"])
    return "\n".join(lines)


def outage_intervals(days):
    """Absolute Definite outage intervals across days, merged over midnight."""
    res = []
    for day in days:
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
        sys.exit(f"group {GROUP!r} not found; available: {', '.join(sorted(data))}")
    g = data[GROUP]

    state = json.loads(STATE_FILE.read_text("utf-8")) if STATE_FILE.exists() else {}
    prev_days = state.get("days", {})
    reminded = state.get("reminded", [])
    now = datetime.now(TZ)
    today = now.strftime("%Y-%m-%d")

    days = [(t, parse_day(g.get(k))) for k, t in (("today", "Сегодня"), ("tomorrow", "Завтра"))]
    days = [(t, d) for t, d in days if d]
    messages = []

    # 1. schedule published / changed
    new_days = {}
    for title, day in days:
        snap = {"status": day["status"], "outages": day["outages"]}
        new_days[day["date"]] = snap
        old = prev_days.get(day["date"])
        if old == snap:
            continue
        if old is None:
            messages.append("🗓 <b>График</b>\n" + fmt_day(day, title))
        else:
            was = "\n".join(fmt_outages(old["outages"])) if old["status"] == "ScheduleApplies" \
                else STATUS_TEXT.get(old["status"], old["status"])
            messages.append("🔄 <b>График изменился</b>\n" + fmt_day(day, title) + "\n\n<i>Было:</i>\n" + was)

    # 2. reminders before outages
    if REMIND_MIN > 0:
        for start, end in outage_intervals([d for _, d in days]):
            key = start.isoformat()
            left = (start - now).total_seconds() / 60
            if 0 < left <= REMIND_MIN and key not in reminded:
                reminded.append(key)
                messages.append(f"⏰ Через {round(left)} мин отключение света: "
                                f"{start:%H:%M}–{end:%H:%M}")

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
