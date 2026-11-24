"""Checks ДІМ.1557 (@claim_1557_bot) from the owner's Telegram account and hands the
result to the worker, which posts changes to the family chat.

1557 does not push outage notices by itself: the info is shown on request via
"Аварії за адресами" -> address button. So every run walks that menu, reads the answer
and deletes the service messages afterwards. Unsolicited bot messages, if any ever
come, are relayed too.

Errors are reported to the worker (it alerts the chat after several failures in a row)
instead of failing the job, so GitHub doesn't send an email every 10 minutes.

Env: TG_API_ID, TG_API_HASH, TG_SESSION (from login.py), RELAY_URL, RELAY_SECRET,
     DIM1557_ADDRESS (optional: part of the address button text if there are several)

Nothing about the address or the answers is printed: Actions logs of a public repo are public.
"""
import json
import os
import time
import urllib.request

from telethon.sessions import StringSession
from telethon.sync import TelegramClient
from telethon.tl.types import ReplyKeyboardMarkup

BOT = "claim_1557_bot"
MENU_BUTTON = "Аварії за адресами"
ADDRESS = os.environ.get("DIM1557_ADDRESS", "").strip().lower()
# Bot messages within this many seconds after our own message are replies to our
# requests, not notices, so they are not relayed as notices.
SOLICITED_WINDOW = 600


class Failure(Exception):
    """Expected failure with a human-readable (Ukrainian) reason for the chat."""


def wait_for(client, after_id, pred, timeout=20):
    """Newest bot message after `after_id` matching `pred`, polling for up to `timeout` s."""
    end = time.time() + timeout
    while time.time() < end:
        time.sleep(1.5)
        for m in client.get_messages(BOT, min_id=after_id, limit=20):
            if not m.out and pred(m):
                return m
    return None


def menu_button_text(client):
    for m in client.get_messages(BOT, limit=50):
        if isinstance(m.reply_markup, ReplyKeyboardMarkup):
            for row in m.reply_markup.rows:
                for b in row.buttons:
                    if MENU_BUTTON in b.text:
                        return b.text
    return None


def query_status(client, ids):
    """Walk the menu and return the answer text; collect ids of service messages in `ids`."""
    text = menu_button_text(client)
    if not text:
        m = client.send_message(BOT, "/menu")
        ids.append(m.id)
        kb = wait_for(client, m.id, lambda x: isinstance(x.reply_markup, ReplyKeyboardMarkup))
        if not kb:
            raise Failure("1557 не показав меню у відповідь на /menu")
        ids.append(kb.id)
        text = menu_button_text(client)
        if not text:
            raise Failure(f"у меню 1557 немає кнопки «{MENU_BUTTON}»")

    start = client.send_message(BOT, text)
    ids.append(start.id)
    picker = wait_for(client, start.id, lambda x: bool(x.buttons))
    if not picker:
        raise Failure("1557 не запропонував вибрати адресу")
    ids.append(picker.id)
    buttons = [b for row in picker.buttons for b in row if "Назад" not in b.text]
    if ADDRESS:
        buttons = [b for b in buttons if ADDRESS in b.text.lower()]
    if not buttons:
        raise Failure("у 1557 не знайдено кнопку з адресою (можливо, адресу видалено з профілю)")
    buttons[0].click()

    # the answer comes as a new message or as an edit of the picker
    end = time.time() + 20
    while time.time() < end:
        time.sleep(1.5)
        for m in client.get_messages(BOT, min_id=start.id, limit=20):
            if m.out:
                continue
            if m.id not in ids:
                ids.append(m.id)
            if m.message and not m.message.startswith("Оберіть адресу"):
                if "адрес" not in m.message.lower():
                    raise Failure("1557 відповів у незнайомому форматі, можливо, змінилося меню")
                return m.message
    raise Failure("1557 не відповів після вибору адреси")


def run():
    client = TelegramClient(StringSession(os.environ["TG_SESSION"]),
                            int(os.environ["TG_API_ID"]), os.environ["TG_API_HASH"])
    client.connect()
    try:
        if not client.is_user_authorized():
            raise Failure("сесія Telegram недійсна (завершена в «Пристроях» або Telegram її скинув), "
                          "потрібно заново запустити relay1557/login.py")
        msgs = client.get_messages(BOT, limit=30)
        ours = [m.date for m in msgs if m.out]
        notices = [
            {"id": m.id, "date": int(m.date.timestamp()), "text": m.message}
            for m in msgs
            if not m.out and m.message
            and not any(0 <= (m.date - t).total_seconds() <= SOLICITED_WINDOW for t in ours)
        ]
        service_ids = []
        try:
            status = query_status(client, service_ids)
        finally:
            if service_ids:
                client.delete_messages(BOT, service_ids, revoke=True)
        print(f"ok, service messages deleted: {len(service_ids)}")
        return {"messages": notices, "status": status}
    finally:
        client.disconnect()


def post(payload):
    req = urllib.request.Request(
        os.environ["RELAY_URL"],
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.environ['RELAY_SECRET']}",
            # Cloudflare rejects the default "Python-urllib" user agent (error 1010)
            "User-Agent": "kyiv-power-alerts-relay",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        print(r.read().decode())


try:
    payload = run()
except Failure as e:
    print("failure reported to the worker")
    payload = {"error": str(e)}
except Exception as e:  # unexpected: only the type goes to the public log
    print(f"error reported to the worker: {type(e).__name__}")
    payload = {"error": f"{type(e).__name__}: {e}"[:300]}
post(payload)
