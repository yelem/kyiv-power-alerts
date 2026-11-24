import { API, COMMANDS, buildCheck, commandReply, fmtNotice, fmtStatus } from "./core.js";

// Secrets: TELEGRAM_BOT_TOKEN, CHAT_ID, GROUP, WEBHOOK_SECRET, RELAY_SECRET
// Optional: ALLOWED_CHATS (comma-separated extra chat ids for commands), REMIND_MINUTES

async function fetchGroup(env) {
  const r = await fetch(API, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`Yasno HTTP ${r.status}`);
  const g = (await r.json())[env.GROUP];
  if (!g) throw new Error(`group ${env.GROUP} not found`);
  return g;
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}

const send = (env, chat_id, text) =>
  tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });

const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

async function check(env) {
  let g;
  try {
    g = await fetchGroup(env);
  } catch (e) {
    console.log("fetch failed:", e.message); // Yasno is flaky sometimes, try on the next tick
    return;
  }
  const state = (await env.KV.get("state", "json")) || {};
  const res = buildCheck(state, g, env.GROUP, Date.now(), Number(env.REMIND_MINUTES ?? 30));
  for (const m of res.messages) await send(env, env.CHAT_ID, m);
  if (changed(res.state, state)) await env.KV.put("state", JSON.stringify(res.state));
}

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
      g = await fetchGroup(env);
    } catch (e) {
      console.log("fetch failed:", e.message);
    }
  }
  const dim = (await env.KV.get("dim1557", "json")) || {};
  const text = commandReply(cmd, g, env.GROUP, Date.now(), dim.notices || [], dim.status);
  if (text) await send(env, msg.chat.id, text);
}

async function relay1557(req, env) {
  const { messages = [], status = null } = await req.json();
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

async function setup(req, env) {
  const origin = new URL(req.url).origin;
  const me = await tg(env, "getMe", {});
  await env.KV.put("bot_username", me.username);
  await tg(env, "setWebhook", {
    url: `${origin}/telegram`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message"],
  });
  await tg(env, "setMyCommands", { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
  return Response.json({ ok: true, bot: me.username, webhook: `${origin}/telegram` });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env));
  },

  async fetch(req, env, ctx) {
    const { pathname, searchParams } = new URL(req.url);
    const bearer = req.headers.get("Authorization");

    if (req.method === "POST" && pathname === "/telegram") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      const update = await req.json();
      ctx.waitUntil(handleUpdate(update, env).catch((e) => console.log("update failed:", e.message)));
      return new Response("ok");
    }
    if (req.method === "POST" && pathname === "/relay1557") {
      if (bearer !== `Bearer ${env.RELAY_SECRET}`) return new Response("forbidden", { status: 403 });
      return relay1557(req, env);
    }
    if (pathname === "/setup") {
      if (searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      return setup(req, env);
    }
    if (pathname === "/check") {
      if (searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      await check(env);
      return new Response("checked");
    }
    return new Response("not found", { status: 404 });
  },
};
