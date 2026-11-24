import {
  API, COMMANDS, buildCheck, commandReply, dur, esc, fmtNotice, fmtStatus, kyiv, validateGroup,
} from "./core.js";

// Secrets: TELEGRAM_BOT_TOKEN, CHAT_ID, GROUP, WEBHOOK_SECRET, RELAY_SECRET
// Optional: ALLOWED_CHATS (comma-separated extra chat ids for commands), REMIND_MINUTES
//
// KV keys: state (schedule), dim1557 (1557 answers), health (cron health + alerts),
// relay_health (written by the 1557 relay), webhook_url, bot_username, email_at

const MIN = 60_000;

class Problem extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// ---------- I/O ----------

async function fetchGroup(env) {
  let r;
  try {
    r = await fetch(API, { headers: { "User-Agent": "Mozilla/5.0" } });
  } catch (e) {
    throw new Problem("yasno_fetch", `мережева помилка: ${e.message}`);
  }
  if (!r.ok) throw new Problem("yasno_fetch", `HTTP ${r.status}`);
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Problem("yasno_format", "відповідь не є JSON");
  }
  const g = data?.[env.GROUP];
  if (!g || typeof g !== "object") throw new Problem("yasno_format", `у відповіді немає групи ${env.GROUP}`);
  const v = validateGroup(g);
  if (v.errors.length) throw new Problem("yasno_format", v.errors.join("; "));
  return { g, unknown: v.unknown };
}

async function tg(env, method, body) {
  let j;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    j = await r.json();
  } catch (e) {
    throw new Problem("telegram", `${method}: ${e.message}`);
  }
  if (!j.ok) throw new Problem("telegram", `${method}: ${j.description}`);
  return j.result;
}

const send = (env, chat_id, text) =>
  tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });

const setWebhook = (env, url) =>
  tg(env, "setWebhook", { url, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message"] });

const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

// ---------- health ----------

// minutes a problem must last before the chat is told about it
const DELAY = { yasno_fetch: 60, yasno_format: 10, code: 10, stale: 30, unknown: 0, relay_silent: 0, relay_err: 0, webhook: 0 };

const RECOVERED = {
  yasno_fetch: "Графік з Yasno знову отримується.",
  yasno_format: "Дані Yasno знову коректні, графік оновлюється.",
  code: "Перевірка графіка знову працює без помилок.",
  stale: "Yasno знову віддає актуальний графік.",
  unknown: "Yasno знову повертає лише відомі значення.",
  relay_silent: "Перевірка ДІМ.1557 знову запускається.",
  relay_err: "Перевірка ДІМ.1557 знову працює.",
  webhook: "Команди бота знову доходять.",
};

function recordTg(h, e, now) {
  h.tgFail ||= { since: now };
  h.tgFail.err = e.message;
}

async function trySend(env, h, now, text) {
  try {
    await send(env, env.CHAT_ID, text);
    h.tgFail = null;
    return true;
  } catch (e) {
    recordTg(h, e, now);
    return false;
  }
}

// ---------- scheduled check ----------

async function check(env) {
  const now = Date.now();
  const h = (await env.KV.get("health", "json")) || {};
  // fields that change every run are left out, so KV is written only on real changes
  // (plus a heartbeat every 10 min; free KV allows 1000 writes a day)
  const sig = (x) => JSON.stringify({ ...x, lastCron: 0, savedAt: 0, yasnoOk: 0, webhookAt: 0 });
  const before = sig(h);
  h.lastCron = now;
  h.created ||= now;
  h.problems ||= {};
  const active = {}; // problem key -> message

  // 1. schedule
  try {
    const { g, unknown } = await fetchGroup(env);
    h.yasnoOk = now;
    if (unknown.length)
      active.unknown = `Yasno повертає невідомі значення: ${unknown.join(", ")}. Графік може показуватися неточно.`;
    const today = kyiv(now).date, dataDay = g.today.date.slice(0, 10);
    if (dataDay !== today && kyiv(now).time >= "00:30")
      active.stale = `Yasno віддає застарілі дані: графік на ${dataDay} замість сьогоднішнього.`;

    const state = (await env.KV.get("state", "json")) || {};
    const res = buildCheck(state, g, env.GROUP, now, Number(env.REMIND_MINUTES ?? 30));
    for (const m of res.messages) await send(env, env.CHAT_ID, m);
    if (res.messages.length) h.tgFail = null;
    if (changed(res.state, state)) await env.KV.put("state", JSON.stringify(res.state));
    h.yasnoFail = null;
  } catch (e) {
    if (e.kind === "telegram") recordTg(h, e, now);
    else {
      const kind = e.kind || "code"; // no kind: a bug in our code on unexpected data
      if (h.yasnoFail?.kind !== kind) h.yasnoFail = { kind, since: now };
      h.yasnoFail.err = e.kind ? e.message : `${e.name}: ${e.message}`;
    }
  }
  const yf = h.yasnoFail;
  if (yf) {
    const ago = dur(Math.round((now - yf.since) / MIN));
    active[yf.kind] = {
      yasno_fetch: `Не вдається отримати графік з Yasno вже ${ago} (${yf.err}). Сповіщення про графік зараз не надходять.`,
      yasno_format: `Yasno повертає дані в незрозумілому форматі (${yf.err}). Графік не оновлюється, ймовірно, змінився API.`,
      code: `Помилка при обробці графіка (${yf.err}). Графік не оновлюється.`,
    }[yf.kind];
  }

  // 2. ДІМ.1557 relay (GitHub Actions, every 10 min)
  const rh = (await env.KV.get("relay_health", "json")) || {};
  const rlast = rh.last || h.created;
  if (now - rlast > 60 * MIN)
    active.relay_silent = `ДІМ.1557 не перевірявся вже ${dur(Math.round((now - rlast) / MIN))}. ` +
      "Ймовірно, зупинився GitHub Actions (вимкнений workflow або збій GitHub).";
  if (rh.errStreak >= 3)
    active.relay_err = `Перевірка ДІМ.1557 не вдається ${rh.errStreak} рази поспіль: ${rh.err}`;

  // 3. once an hour (every run while Telegram is failing): is the bot still in the chat,
  //    and is the webhook for commands intact
  if (now - (h.webhookAt || 0) >= 60 * MIN || h.tgFail) {
    h.webhookAt = now;
    try {
      const botId = Number(String(env.TELEGRAM_BOT_TOKEN).split(":")[0]);
      const member = await tg(env, "getChatMember", { chat_id: env.CHAT_ID, user_id: botId });
      if (["left", "kicked"].includes(member.status) || member.can_send_messages === false)
        throw new Problem("telegram", `бот не може писати в чат (статус: ${member.status})`);

      const info = await tg(env, "getWebhookInfo", {});
      const want = await env.KV.get("webhook_url");
      h.webhookErr = null;
      if (want && info.url !== want) {
        await setWebhook(env, want);
        if (now - (h.webhookHealedAt || 0) < 3 * 60 * MIN)
          h.webhookErr = "Налаштування команд бота постійно скидається. Ймовірно, інший скрипт " +
            "читає повідомлення цього ж бота (getUpdates/webhook); команди можуть не працювати.";
        else await trySend(env, h, now, "ℹ️ Налаштування команд бота було скинуто, відновлено автоматично.");
        h.webhookHealedAt = now;
      } else if (info.last_error_date && now / 1000 - info.last_error_date < 3600) {
        h.webhookErr = `Telegram не може доставити команди боту: ${info.last_error_message}`;
      }
      h.tgFail = null;
    } catch (e) {
      if (e.kind === "telegram") recordTg(h, e, now);
      else throw e;
    }
  }
  if (h.webhookErr) active.webhook = h.webhookErr;

  // 4. tell the chat about new problems and about recoveries
  for (const [key, msg] of Object.entries(active)) {
    const p = (h.problems[key] ||= { since: now });
    if (!p.alerted && now - p.since >= (DELAY[key] ?? 0) * MIN)
      p.alerted = await trySend(env, h, now, `⚠️ <b>Проблема з ботом</b>\n${esc(msg)}`);
  }
  for (const [key, p] of Object.entries(h.problems)) {
    if (active[key]) continue;
    if (!p.alerted || (await trySend(env, h, now, `✅ <b>Бот знову працює</b>\n${RECOVERED[key] || "Проблему усунено."}`)))
      delete h.problems[key];
  }

  if (sig(h) !== before || now - (h.savedAt || 0) >= 10 * MIN) {
    h.savedAt = now;
    await env.KV.put("health", JSON.stringify(h));
  }
}

// Called by GitHub Actions. Reports what the bot can't report in Telegram itself
// (the scheduled check stopped, or Telegram rejects the bot); GitHub then emails the owner.
async function health(env) {
  const now = Date.now();
  const h = (await env.KV.get("health", "json")) || {};
  const issues = {};
  if (!h.savedAt || now - h.savedAt > 25 * MIN)
    issues.cron = "перевірка графіка за розкладом не запускається " +
      (h.savedAt ? `вже ${dur(Math.round((now - h.savedAt) / MIN))}` : "(жодного запуску)");
  if (h.tgFail && now - h.tgFail.since > 5 * MIN)
    issues.telegram = `Telegram не приймає повідомлення від бота: ${h.tgFail.err}`;
  // at most one email per problem type per 6 hours
  const emailed = (await env.KV.get("email_at", "json")) || {};
  const due = Object.keys(issues).filter((k) => now - (emailed[k] || 0) > 6 * 60 * MIN);
  if (due.length) {
    for (const k of due) emailed[k] = now;
    await env.KV.put("email_at", JSON.stringify(emailed));
  }
  return Response.json({ ok: !Object.keys(issues).length, notify: due.length > 0, issues: Object.values(issues) });
}

// ---------- commands ----------

async function handleUpdate(u, env) {
  const msg = u.message;
  if (!msg?.text?.startsWith("/")) return;
  const allowed = [env.CHAT_ID, ...(env.ALLOWED_CHATS || "").split(",")].map((s) => s.trim());
  if (!allowed.includes(String(msg.chat.id))) return;

  const [cmd, target] = msg.text.trim().split(/\s+/)[0].toLowerCase().split("@");
  const me = await env.KV.get("bot_username");
  if (target && me && target !== me.toLowerCase()) return; // command for another bot

  let g = null;
  if (["/status", "/today", "/tomorrow"].includes(cmd)) {
    try {
      g = (await fetchGroup(env)).g;
    } catch (e) {
      console.log("fetch failed:", e.message);
    }
  }
  const dim = (await env.KV.get("dim1557", "json")) || {};
  const text = commandReply(cmd, g, env.GROUP, Date.now(), dim.notices || [], dim.status);
  if (text) await send(env, msg.chat.id, text);
}

// ---------- ДІМ.1557 relay ----------

async function relay1557(req, env) {
  const { messages = [], status = null, error = null } = await req.json();

  const rh = (await env.KV.get("relay_health", "json")) || {};
  rh.last = Date.now();
  if (error) {
    rh.errStreak = (rh.errStreak || 0) + 1;
    rh.err = String(error).slice(0, 300);
  } else {
    rh.errStreak = 0;
    rh.err = null;
  }
  await env.KV.put("relay_health", JSON.stringify(rh));
  if (error) return Response.json({ recordedError: true, streak: rh.errStreak });

  const st = (await env.KV.get("dim1557", "json")) || { seen: [], notices: [] };
  const before = JSON.parse(JSON.stringify(st));
  const first = !st.init; // first sync: remember existing messages without posting them
  const fresh = messages.filter((m) => !st.seen.includes(m.id)).sort((a, b) => a.id - b.id);
  for (const m of fresh) {
    if (!first) await send(env, env.CHAT_ID, fmtNotice(m));
    st.seen.push(m.id);
    st.notices.unshift(m);
  }

  // answer of "Аварії за адресами": post only when it changes (not on the very first one)
  let statusChanged = false;
  if (status && status.trim() !== st.status?.text) {
    const now = Math.floor(Date.now() / 1000);
    if (st.status) await send(env, env.CHAT_ID, fmtStatus(status.trim(), now));
    st.status = { text: status.trim(), since: now };
    statusChanged = true;
  }
  st.init = true;
  st.seen = st.seen.slice(-300);
  st.notices = st.notices.slice(0, 10);
  if (changed(st, before)) await env.KV.put("dim1557", JSON.stringify(st));
  return Response.json({ received: messages.length, sent: first ? 0 : fresh.length, statusChanged });
}

// ---------- setup ----------

async function setup(req, env) {
  const url = `${new URL(req.url).origin}/telegram`;
  const me = await tg(env, "getMe", {});
  await env.KV.put("bot_username", me.username);
  await env.KV.put("webhook_url", url);
  await setWebhook(env, url);
  await tg(env, "setMyCommands", { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
  return Response.json({ ok: true, bot: me.username, webhook: url });
}

// ---------- entry points ----------

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env).catch((e) => console.log("check failed:", e.message)));
  },

  async fetch(req, env, ctx) {
    const { pathname, searchParams } = new URL(req.url);
    const relayAuth = req.headers.get("Authorization") === `Bearer ${env.RELAY_SECRET}`;
    const keyAuth = searchParams.get("key") === env.WEBHOOK_SECRET;

    if (req.method === "POST" && pathname === "/telegram") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      const update = await req.json();
      ctx.waitUntil(handleUpdate(update, env).catch((e) => console.log("update failed:", e.message)));
      return new Response("ok");
    }
    if (req.method === "POST" && pathname === "/relay1557") {
      if (!relayAuth) return new Response("forbidden", { status: 403 });
      return relay1557(req, env);
    }
    if (pathname === "/health") {
      if (!relayAuth) return new Response("forbidden", { status: 403 });
      return health(env);
    }
    if (pathname === "/setup") {
      if (!keyAuth) return new Response("forbidden", { status: 403 });
      return setup(req, env);
    }
    if (pathname === "/check") {
      if (!keyAuth) return new Response("forbidden", { status: 403 });
      await check(env);
      return new Response("checked");
    }
    return new Response("not found", { status: 404 });
  },
};
