// Pure logic: parsing the Yasno schedule, detecting changes, formatting messages.
// No I/O here, so it can be tested with plain Node.

export const API =
  "https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages";
const TZ = "Europe/Kyiv";
const APPLIES = "ScheduleApplies";
const WAITING = "WaitingForSchedule";
const MIN = 60_000;

// "EmergencyShutdowns" or any unknown status means the schedule is not in effect.
export const isEmergency = (s) => s != null && s !== APPLIES && s !== WAITING;

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
// Whole day as alternating periods, one per line: red = no power, green = power.
// `from` (minutes) drops periods that are already over; the current one starts at "зараз".
function timeline(outages, from = 0) {
  const seg = [];
  let cur = 0;
  for (const [a, b, t] of outages) {
    if (a > cur) seg.push([cur, a, "on"]);
    seg.push([a, b, t]);
    cur = b;
  }
  if (cur < 1440) seg.push([cur, 1440, "on"]);
  return seg
    .filter(([, b]) => b > from)
    .map(([a, b, t]) => {
      const mark = t === "on" ? "🟢" : t === "Definite" ? "🔴" : "🟡";
      const note = t === "on" || t === "Definite" ? "" : " (можливо без світла)";
      return `${mark} ${a < from ? "зараз" : hhmm(a)} – ${hhmm(b)}${note}`;
    });
}
const ddmm = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const kyivFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function kyiv(ts) {
  const p = Object.fromEntries(kyivFmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// End of an interval: show midnight as 24:00 of the previous day.
const endTime = (ts) => (kyiv(ts).time === "00:00" ? "24:00" : kyiv(ts).time);

export function dur(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h && m) return `${h} год ${m} хв`;
  return h ? `${h} год` : `${m} хв`;
}

export function parseDay(d) {
  if (!d || !d.date) return null;
  const outages = [];
  for (const s of d.slots || []) {
    if (s.type === "NotPlanned") continue;
    const last = outages[outages.length - 1];
    if (last && last[1] === s.start && last[2] === s.type) last[1] = s.end;
    else outages.push([s.start, s.end, s.type]);
  }
  return { date: d.date.slice(0, 10), iso: d.date, status: d.status ?? null, outages };
}

// [[title, day], ...] for today and tomorrow
export const parseGroup = (g) =>
  [["сьогодні", parseDay(g.today)], ["завтра", parseDay(g.tomorrow)]].filter(([, d]) => d);

// Absolute [start, end] timestamps of definite outages, merged over midnight.
export function intervals(days) {
  const res = [];
  for (const day of days) {
    if (day.status !== APPLIES) continue;
    const base = Date.parse(day.iso);
    for (const [a, b, t] of day.outages) {
      if (t !== "Definite") continue;
      const s = base + a * MIN, e = base + b * MIN;
      const last = res[res.length - 1];
      if (last && last[1] === s) last[1] = e;
      else res.push([s, e]);
    }
  }
  return res;
}

export function nowHint(days, now) {
  const today = kyiv(now).date;
  const d = days.find((x) => x.date === today);
  if (!d) return null;
  if (isEmergency(d.status)) return "Діють аварійні відключення, графік не діє.";
  if (d.status !== APPLIES) return null;
  const at = (ts) => (kyiv(ts).date === today ? "о " : "завтра о ") + kyiv(ts).time;
  const iv = intervals(days);
  const cur = iv.find(([s, e]) => s <= now && now < e);
  if (cur) {
    const back = kyiv(cur[1] - 1).date === today ? `о ${endTime(cur[1])}` : at(cur[1]);
    return `За графіком зараз світла немає, увімкнуть ${back}.`;
  }
  const next = iv.find(([s]) => s > now);
  if (next) return `За графіком зараз світло є, наступне відключення ${at(next[0])}.`;
  return "За графіком зараз світло є, відключень більше не заплановано.";
}

function outageLines(outages) {
  if (!outages.length) return ["🟢 Відключень не заплановано."];
  const lines = timeline(outages);
  const off = outages.filter((o) => o[2] === "Definite").reduce((s, [a, b]) => s + b - a, 0);
  if (off) lines.push("", `Разом без світла: ${dur(off)}`);
  return lines;
}

export function fmtDay(day, title, group, hint, heading) {
  const lines = [`<b>${heading || `Графік на ${title}, ${ddmm(day.date)}`}</b>`, `група ${group}`, ""];
  if (isEmergency(day.status)) lines.push("Діють аварійні відключення, графік не діє.");
  else if (day.status !== APPLIES) lines.push("Графік ще не опубліковано.");
  else {
    lines.push(...outageLines(day.outages));
    if (hint) lines.push("", hint);
  }
  return lines.join("\n");
}

/**
 * Compare fresh data with saved state.
 * Returns {messages: [html, ...], state: newState}.
 */
export function buildCheck(state, g, group, now, remindMin) {
  const parsed = parseGroup(g);
  const days = parsed.map(([, d]) => d);
  const prev = state.days || {};
  const today = kyiv(now).date;
  const hint = nowHint(days, now);
  const newDays = {};
  const ch = { emergency: [], ended: [], fresh: [], other: [] };

  for (const [title, day] of parsed) {
    newDays[day.date] = { status: day.status, outages: day.outages };
    const old = prev[day.date];
    const os = old ? old.status : null, ns = day.status, dm = ddmm(day.date);
    const h = day.date === today ? hint : null;

    if (isEmergency(ns)) {
      if (!isEmergency(os)) ch.emergency.push(dm);
    } else if (ns === WAITING) {
      if (os === APPLIES) ch.other.push(`<b>Графік на ${title}, ${dm} скасовано</b>\nОчікується новий.`);
      else if (isEmergency(os))
        ch.other.push(`<b>Аварійні відключення завершено</b>\nГрафік на ${title}, ${dm} ще не опубліковано.`);
    } else if (ns === APPLIES) {
      if (isEmergency(os)) ch.ended.push(fmtDay(day, title, group, h));
      else if (os !== APPLIES) ch.fresh.push(fmtDay(day, title, group, h));
      else if (JSON.stringify(old.outages) !== JSON.stringify(day.outages))
        ch.other.push(
          fmtDay(day, title, group, h, `Графік на ${title}, ${dm} змінився`) +
            "\n\nБуло без світла: " + (old.outages.length
              ? old.outages.map(([a, b]) => `${hhmm(a)} – ${hhmm(b)}`).join(", ")
              : "жодного разу"),
        );
    }
  }

  const messages = [];
  if (ch.emergency.length)
    messages.push(
      `<b>Аварійні відключення</b>\nГрафік на ${ch.emergency.join(" і ")} не діє, ` +
        "світло можуть вимкнути будь-коли.",
    );
  if (ch.ended.length)
    messages.push("<b>Аварійні відключення завершено, графік знову діє</b>\n\n" + ch.ended.join("\n\n"));
  messages.push(...ch.fresh, ...ch.other);

  let reminded = state.reminded || [];
  if (remindMin > 0) {
    for (const [s, e] of intervals(days)) {
      const key = new Date(s).toISOString();
      const left = (s - now) / MIN;
      if (left > 0 && left <= remindMin && !reminded.includes(key)) {
        reminded.push(key);
        messages.push(
          `<b>Через ${Math.round(left)} хв відключення світла</b>\n` +
            `🔴 ${kyiv(s).time} – ${endTime(e)}, ${dur((e - s) / MIN)}`,
        );
      }
    }
  }
  reminded = reminded.filter((k) => Date.parse(k) > now - 24 * 60 * MIN);

  return { messages, state: { days: newDays, reminded } };
}

// ---- ДІМ.1557 notices ----

export const fmtNotice = (n) => {
  const t = kyiv(n.date * 1000);
  return `<b>ДІМ.1557</b>, ${ddmm(t.date)} ${t.time}\n\n${esc(n.text)}`;
};

// 1557 answers "...відсутні зафіксовані аварійні ситуації..." when everything is fine
const noAccidents = (text) => /відсутні\s+зафіксовані/i.test(text);

export function fmtStatus(text, since) {
  const t = kyiv(since * 1000);
  const head = noAccidents(text) ? "🟢 ДІМ.1557: аварій за адресою немає" : "🔴 ДІМ.1557: аварія за адресою";
  return `<b>${head}</b>\n${ddmm(t.date)} ${t.time}\n\n${esc(text)}`;
}

// ---- commands ----

export const COMMANDS = [
  ["status", "Що зараз за графіком"],
  ["today", "Графік на сьогодні"],
  ["tomorrow", "Графік на завтра"],
  ["dim1557", "Останні повідомлення ДІМ.1557"],
  ["help", "Довідка"],
];

const HELP =
  "<b>Команди</b>\n\n" + COMMANDS.map(([c, d]) => `/${c} – ${d.toLowerCase()}`).join("\n") +
  "\n\nСам бот пише, коли публікується або змінюється графік, коли діють аварійні " +
  "відключення, за 30 хв до відключення та коли приходить повідомлення від ДІМ.1557.";

const NODATA = "Не вдалося отримати дані Yasno, спробуйте трохи пізніше.";

export function commandReply(cmd, g, group, now, notices = [], status = null) {
  if (cmd === "/help" || cmd === "/start") return HELP;
  if (cmd === "/dim1557") {
    const parts = [];
    if (status) parts.push(fmtStatus(status.text, status.since).replace(/\n/, "\nбез змін з "));
    else parts.push("ДІМ.1557 ще не перевірявся, перша перевірка – протягом 10 хв.");
    if (notices.length) parts.push(...notices.slice(0, 2).map(fmtNotice));
    return parts.join("\n\n— — —\n\n");
  }
  if (!["/status", "/today", "/tomorrow"].includes(cmd)) return null;
  if (!g) return NODATA;

  const parsed = parseGroup(g);
  const days = parsed.map(([, d]) => d);
  const get = (title) => parsed.find(([t]) => t === title)?.[1];

  if (cmd === "/today" || cmd === "/tomorrow") {
    const title = cmd === "/today" ? "сьогодні" : "завтра";
    const d = get(title);
    if (!d) return `Графіка на ${title} поки немає.`;
    return fmtDay(d, title, group, title === "сьогодні" ? nowHint(days, now) : null);
  }

  // /status
  const lines = [`<b>Зараз, ${kyiv(now).time}</b>`, `група ${group}`, ""];
  lines.push(nowHint(days, now) || "Графік на сьогодні ще не опубліковано.");
  const td = get("сьогодні");
  if (td?.status === APPLIES) {
    const [h, m] = kyiv(now).time.split(":").map(Number);
    lines.push("", "Решта дня:", ...timeline(td.outages, h * 60 + m));
  }
  const t = get("завтра");
  lines.push(
    "",
    !t || t.status === WAITING ? "Графіка на завтра ще немає."
      : isEmergency(t.status) ? "На завтра оголошено аварійні відключення."
      : "Графік на завтра: /tomorrow",
  );
  if (status)
    lines.push(noAccidents(status.text)
      ? "ДІМ.1557: аварій за адресою немає"
      : "ДІМ.1557: є аварія за адресою, деталі /dim1557");
  return lines.join("\n");
}
