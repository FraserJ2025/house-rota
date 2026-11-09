// The Fozzfather: sends the house's phone notifications.
// Called hourly by pg_cron (mode "tick"); also "welcome" (one test to a just-subscribed phone)
// and "preview" (returns what would be sent, sends nothing).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
webpush.setVapidDetails("mailto:house@example.com", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);
const SECRET = Deno.env.get("CRON_SECRET") || "";
const APP = "https://fraserj2025.github.io/house-rota/";
const SPLITWISE = "https://secure.splitwise.com/#/groups/102632907";

// ---- Rota rules (same as the app) ----
const PEOPLE = ["Fraser", "Ewan", "Tom", "Jayden"];
const PAIRS = [["Fraser", "Ewan"], ["Tom", "Jayden"]];
const HALVES = [
  [{ id: "kitchen", name: "Kitchen" }, { id: "hallway", name: "Hallway" }],
  [{ id: "living", name: "Living room" }, { id: "toilet", name: "Toilet" }, { id: "shower", name: "Shower room" }],
];
const DAY = 86400000;
const ANCHOR = Date.UTC(2026, 10, 9); // Mon 9 Nov 2026
const START = Date.UTC(2026, 10, 2);  // first tracked week
const mod = (n: number, k: number) => ((n % k) + k) % k;
const keyOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const list = (xs: string[]) => xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
function rotaFor(monday: number) {
  const w = Math.round((monday - ANCHOR) / (7 * DAY)), pair = PAIRS[mod(w, 2)], swap = mod(Math.floor(w / 2), 2) === 1;
  return { pair, people: (swap ? [[pair[1], HALVES[0]], [pair[0], HALVES[1]]] : [[pair[0], HALVES[0]], [pair[1], HALVES[1]]]) as [string, { id: string; name: string }[]][] };
}

// UK wall-clock time, as a UTC-based "local day" number so date maths ignores DST.
function london() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(new Date()).map(p => [p.type, p.value]));
  const today = Date.UTC(+parts.year, +parts.month - 1, +parts.day);
  const dow = (new Date(today).getUTCDay() + 6) % 7; // 0 = Monday
  return { today, hour: +parts.hour, dow, monday: today - dow * DAY };
}

const gbp = (p: number) => "£" + (Math.abs(p) / 100).toFixed(2);
function nets(m: any) {
  const n: Record<string, number> = Object.fromEntries(PEOPLE.map(p => [p, 0]));
  for (const [p, v] of Object.entries(m.opening || {})) n[p] += v as number;
  for (const e of m.expenses || []) { n[e.paidBy] += e.amount; for (const [p, v] of Object.entries(e.split)) n[p] -= v as number; }
  for (const t of m.settlements || []) { n[t.from] += t.amount; n[t.to] -= t.amount; }
  return n;
}

type Msg = { person: string; title: string; body: string; url: string; tag: string };

async function compute(now = london()): Promise<Msg[]> {
  const { data: rows } = await db.from("rota").select("key,data");
  const store: Record<string, any> = Object.fromEntries((rows || []).map((r: any) => [r.key, r.data || {}]));
  const wk = (k: string) => store["week:" + k] || {};
  const msgs: Msg[] = [];
  const send = (person: string, body: string, tag: string, url = APP + "#home") => msgs.push({ person, title: "The Fozzfather", body, url, tag });
  const thisKey = keyOf(now.monday), thisRota = rotaFor(now.monday), ticks = wk(thisKey).ticks || {};

  // Overdue from earlier weeks (respecting extensions)
  const overdue: Record<string, string[]> = {};
  for (let m = now.monday - 7 * DAY; m >= START; m -= 7 * DAY) {
    const k = keyOf(m), t = wk(k).ticks || {}, ext = wk(k).ext || {};
    for (const [p, rooms] of rotaFor(m).people) for (const r of rooms) {
      const endDay = m + 6 * DAY + (ext[p]?.days || 0) * DAY; // last allowed day
      if (!t[r.id] && now.today > endDay) (overdue[p] ||= []).push(r.name);
    }
  }

  // 09:00 every day: overdue nag
  if (now.hour === 9) for (const [p, rooms] of Object.entries(overdue))
    send(p, `🔴 Overdue: ${list(rooms)}. The house is waiting. Sort it today and tick it off.`, "overdue", APP + "#rota");

  // Monday 09:00: new week jobs
  if (now.dow === 0 && now.hour === 9) for (const [p, rooms] of thisRota.people)
    send(p, `New week. You're on ${list(rooms.map(r => r.name))}. Due Sunday 23:59.`, "newweek", APP + "#rota");

  // Thursday 18:00 nudge, Sunday 18:00 last call (skip anyone with an extension)
  if ((now.dow === 3 || now.dow === 6) && now.hour === 18) for (const [p, rooms] of thisRota.people) {
    const left = rooms.filter(r => !ticks[r.id]).map(r => r.name);
    if (!left.length || (now.dow === 6 && wk(thisKey).ext?.[p])) continue;
    send(p, now.dow === 3 ? `Halfway through the week. Still to do: ${list(left)}.` : `Last call: ${list(left)} due tonight at 23:59.`, "nudge", APP + "#rota");
  }

  // 18:00 every day: tomorrow's bills and plans, to everyone
  if (now.hour === 18) {
    const tomorrow = keyOf(now.today + DAY);
    for (const e of (store.calendar?.events || []) as any[]) {
      if (e.start !== tomorrow) continue;
      const note = e.note ? ` · ${e.note}` : "";
      const body = e.type === "bill" ? `💷 ${e.title} due tomorrow${note}. Settle up on Splitwise.` : `Tomorrow: ${e.title}${note}.`;
      for (const p of PEOPLE) send(p, body, "cal-" + e.id, e.type === "bill" ? SPLITWISE : APP + "#calendar");
    }
  }

  // Sunday 12:00: settle-up nudge for anyone who owes money
  if (now.dow === 6 && now.hour === 12) {
    const n = nets(store.money || {});
    for (const p of PEOPLE) if (n[p] < 0) send(p, `💷 You owe ${gbp(n[p])} in the house. Settle up in the Money tab when you can.`, "owe", APP + "#money");
  }

  // Saturday 10:00: shopping list
  if (now.dow === 5 && now.hour === 10) {
    const needed = ((store.supplies?.items || []) as any[]).filter(i => !i.got).map(i => i.name);
    if (needed.length) for (const p of PEOPLE) send(p, `Running low: ${list(needed)}. Whoever's at the shops, grab them and tick them off.`, "shopping", APP + "#house");
  }
  return msgs;
}

async function deliver(msgs: Msg[], onlyEndpoint?: string) {
  const { data: subs } = await db.from("push_subs").select("endpoint,person,sub");
  let sent = 0, failed = 0;
  for (const m of msgs) for (const s of (subs || []) as any[]) {
    if (onlyEndpoint ? s.endpoint !== onlyEndpoint : s.person !== m.person) continue;
    try { await webpush.sendNotification(s.sub, JSON.stringify(m), { TTL: 6 * 3600 }); sent++; }
    catch (e: any) {
      failed++;
      if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subs").delete().eq("endpoint", s.endpoint);
    }
  }
  return { sent, failed };
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });

Deno.serve(async req => {
  if (req.method === "OPTIONS") return json({});
  const body = await req.json().catch(() => ({}));
  const authed = SECRET && req.headers.get("x-fozz-secret") === SECRET;

  if (body.mode === "welcome" && typeof body.endpoint === "string") {
    const msg = { person: "", title: "The Fozzfather", body: "It's the Fozzfather. You'll hear from me about cleaning, bills and the house.", url: APP + "#home", tag: "welcome" };
    return json(await deliver([msg], body.endpoint));
  }
  // New expense / settle up: notify the people involved, once per item
  if ((body.mode === "expense" || body.mode === "settle") && typeof body.id === "string") {
    const { data: rows } = await db.from("rota").select("key,data").in("key", ["money", "fozz:items"]);
    const get = (k: string) => (rows || []).find((r: any) => r.key === k)?.data || {};
    const money = get("money"), done: string[] = get("fozz:items").ids || [];
    if (done.includes(body.id)) return json({ skipped: "already sent" });
    const msgs: Msg[] = [];
    if (body.mode === "expense") {
      const e = (money.expenses || []).find((x: any) => x.id === body.id);
      if (!e) return json({ error: "not found" }, 404);
      for (const [p, share] of Object.entries(e.split) as [string, number][]) if (p !== e.paidBy)
        msgs.push({ person: p, title: "The Fozzfather", body: `${e.paidBy} added ${e.desc} · ${gbp(e.amount)}. Your share: ${gbp(share)}.`, url: APP + "#money", tag: "ex-" + e.id });
    } else {
      const t = (money.settlements || []).find((x: any) => x.id === body.id);
      if (!t) return json({ error: "not found" }, 404);
      msgs.push({ person: t.to, title: "The Fozzfather", body: `${t.from} says they've paid you ${gbp(t.amount)}. Check it's arrived.`, url: APP + "#money", tag: "st-" + t.id });
    }
    await db.from("rota").upsert({ key: "fozz:items", data: { ids: [...done, body.id].slice(-200) } });
    return json(await deliver(msgs));
  }

  if (!authed) return json({ error: "not allowed" }, 401);

  // Message everyone who has notifications on
  if (body.mode === "broadcast" && typeof body.body === "string") {
    const msgs = PEOPLE.map(p => ({ person: p, title: "The Fozzfather", body: body.body, url: APP + "#home", tag: "broadcast" }));
    return json(await deliver(msgs));
  }

  if (body.mode === "preview") return json(await compute(body.at ? { ...london(), ...body.at } : london()));
  if (body.mode === "tick") {
    const now = london(), slot = `${keyOf(now.today)}T${now.hour}`;
    const { data: logRow } = await db.from("rota").select("data").eq("key", "fozz:log").maybeSingle();
    const log = logRow?.data?.slots || [];
    if (log.includes(slot)) return json({ skipped: slot });
    const result = await deliver(await compute(now));
    await db.from("rota").upsert({ key: "fozz:log", data: { slots: [...log, slot].slice(-60) } });
    return json({ slot, ...result });
  }
  return json({ error: "unknown mode" }, 400);
});
