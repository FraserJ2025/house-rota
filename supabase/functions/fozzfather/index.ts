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
function rotaBase(monday: number) {
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

const payersOf = (e: any): Record<string, number> => typeof e.paidBy === "string" ? { [e.paidBy]: e.amount } : (e.paidBy || {});
const gbp = (p: number) => "£" + (Math.abs(p) / 100).toFixed(2);
function nets(m: any) {
  const n: Record<string, number> = Object.fromEntries(PEOPLE.map(p => [p, 0]));
  for (const [p, v] of Object.entries(m.opening || {})) n[p] += v as number;
  for (const e of m.expenses || []) { for (const [p, v] of Object.entries(payersOf(e))) n[p] += v as number; for (const [p, v] of Object.entries(e.split)) n[p] -= v as number; }
  for (const t of m.settlements || []) { n[t.from] += t.amount; n[t.to] -= t.amount; }
  return n;
}

// Rota for a week including edits stored in week:<date>.assign = { roomId: person }
function rotaWith(store: Record<string, any>) {
  return (monday: number) => {
    const base = rotaBase(monday), assign = store["week:" + keyOf(monday)]?.assign;
    if (!assign || !Object.keys(assign).length) return base;
    const all = HALVES.flat(), owner: Record<string, string> = {};
    for (const [p, rooms] of base.people) for (const r of rooms) owner[r.id] = assign[r.id] || p;
    const people = PEOPLE.map(p => [p, all.filter(r => owner[r.id] === p)] as [string, { id: string; name: string }[]]).filter(([, rs]) => rs.length);
    return { pair: people.map(([p]) => p), people };
  };
}
function overdueFor(store: Record<string, any>, now: ReturnType<typeof london>) {
  const rotaFor = rotaWith(store), out: Record<string, string[]> = {};
  for (let m = now.monday - 7 * DAY; m >= START; m -= 7 * DAY) {
    const k = keyOf(m), w = store["week:" + k] || {}, t = w.ticks || {}, ext = w.ext || {};
    for (const [p, rooms] of rotaFor(m).people) for (const r of rooms) {
      const endDay = m + 6 * DAY + (ext[p]?.days || 0) * DAY;
      if (!t[r.id] && now.today > endDay) (out[p] ||= []).push(r.name);
    }
  }
  return out;
}

type Msg = { person: string; title: string; body: string; url: string; tag: string };

async function compute(now = london()): Promise<Msg[]> {
  const { data: rows } = await db.from("rota").select("key,data");
  const store: Record<string, any> = Object.fromEntries((rows || []).map((r: any) => [r.key, r.data || {}]));
  const wk = (k: string) => store["week:" + k] || {};
  const msgs: Msg[] = [];
  const send = (person: string, body: string, tag: string, url = APP + "#home") => msgs.push({ person, title: "The Fozzfather", body, url, tag });
  const rotaFor = rotaWith(store);
  const thisKey = keyOf(now.monday), thisRota = rotaFor(now.monday), ticks = wk(thisKey).ticks || {};

  const overdue = overdueFor(store, now);

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

  // 18:00: standing orders due tomorrow
  if (now.hour === 18) {
    const tomorrowDay = new Date(now.today + DAY).getUTCDate();
    for (const it of (store.recurring?.items || []) as any[]) if (it.day === tomorrowDay) {
      const each = Math.floor(it.amount / it.split.length);
      for (const p of it.split as string[]) send(p, it.mode === "expense"
        ? `${it.title} goes out tomorrow (${gbp(it.amount)}). ${it.paidBy} pays and your share of ${gbp(each)} gets added to the Money tab.`
        : `${it.title} is due tomorrow. Your share: ${gbp(each)}. Make sure it's paid.`, "so-" + it.id, APP + "#money");
    }
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
  // New/edited expense, comment, or settle up: notify the people involved, once per item/revision
  if (["expense", "settle", "excomment"].includes(body.mode) && typeof body.id === "string") {
    const { data: rows } = await db.from("rota").select("key,data").in("key", ["money", "fozz:items"]);
    const get = (k: string) => (rows || []).find((r: any) => r.key === k)?.data || {};
    const money = get("money"), done: string[] = get("fozz:items").ids || [];
    const dkey = `${body.mode}:${body.id}:${body.rev || body.cid || 0}`;
    if (done.includes(dkey)) return json({ skipped: "already sent" });
    const msgs: Msg[] = [];
    const mk = (person: string, text: string, tag: string) => msgs.push({ person, title: "The Fozzfather", body: text, url: APP + "#money", tag });
    if (body.mode === "settle") {
      const t = (money.settlements || []).find((x: any) => x.id === body.id);
      if (!t) return json({ error: "not found" }, 404);
      mk(t.to, `${t.from} says they've paid you ${gbp(t.amount)}${t.method ? ` (${t.method.toLowerCase()})` : ""}. Check it's arrived.`, "st-" + t.id);
    } else {
      const e = (money.expenses || []).find((x: any) => x.id === body.id);
      if (!e) return json({ error: "not found" }, 404);
      const pay = payersOf(e), payerNames = Object.keys(pay), involved = new Set([...payerNames, ...Object.keys(e.split)]);
      if (body.mode === "excomment") {
        const c = (e.comments || []).find((x: any) => x.id === body.cid);
        if (!c) return json({ error: "not found" }, 404);
        for (const p of involved) if (p !== c.by) mk(p, `💬 ${c.by} on ${e.desc}: "${String(c.text).slice(0, 120)}"`, "cm-" + e.id);
      } else {
        const who = body.rev ? (e.editedBy || "Someone") : (e.by || payerNames[0]);
        for (const p of Object.keys(e.split)) if (!(pay[p] && pay[p] >= e.split[p]) && p !== who)
          mk(p, body.rev ? `${who} edited ${e.desc}. Your share is now ${gbp(e.split[p])}.` : `${who} added ${e.desc} · ${gbp(e.amount)}. Your share: ${gbp(e.split[p])}.`, "ex-" + e.id);
      }
    }
    await db.from("rota").upsert({ key: "fozz:items", data: { ids: [...done, dkey].slice(-300) } });
    return json(await deliver(msgs));
  }

  // Nudge: someone taps the nudge button on an overdue room or money owed. Text is built here, never taken from the caller.
  if (body.mode === "nudge" && PEOPLE.includes(body.to) && (body.kind === "overdue" || body.kind === "money")) {
    const from = PEOPLE.includes(body.from) ? body.from : "Someone";
    const { data: rows } = await db.from("rota").select("key,data");
    const store: Record<string, any> = Object.fromEntries((rows || []).map((r: any) => [r.key, r.data || {}]));
    const log = store["fozz:nudges"] || {}, k = `${body.kind}:${body.to}`;
    if (log[k] && Date.now() - log[k] < 3 * 3600 * 1000) return json({ limited: true, sent: 0 });
    let text = "";
    if (body.kind === "overdue") {
      const rooms = overdueFor(store, london())[body.to] || [];
      if (!rooms.length) return json({ sent: 0, nothing: true });
      text = `👉 ${from} nudged you: ${list(rooms)} ${rooms.length > 1 ? "are" : "is"} overdue. Get it done and tick it off.`;
    } else {
      const owed = nets(store.money || {})[body.to];
      if (!(owed < 0)) return json({ sent: 0, nothing: true });
      text = `👉 ${from} nudged you: you owe ${gbp(owed)} in the house. Settle up in the Money tab.`;
    }
    await db.from("rota").upsert({ key: "fozz:nudges", data: { ...log, [k]: Date.now() } });
    return json(await deliver([{ person: body.to, title: "The Fozzfather", body: text, url: APP + (body.kind === "money" ? "#money" : "#rota"), tag: "nudge-" + body.kind }]));
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
    const extra: Msg[] = [];
    if (now.hour >= 9) {
      const { data: rr } = await db.from("rota").select("key,data").in("key", ["recurring", "money"]);
      const rec = (rr || []).find((r: any) => r.key === "recurring")?.data || { items: [] };
      const money = (rr || []).find((r: any) => r.key === "money")?.data || {};
      const month = keyOf(now.today).slice(0, 7), dayNum = new Date(now.today).getUTCDate();
      let changed = false;
      for (const it of rec.items || []) {
        if (it.mode !== "expense" || it.day > dayNum || it.lastRun === month) continue;
        const base = Math.floor(it.amount / it.split.length), remPence = it.amount - base * it.split.length;
        const split = Object.fromEntries(it.split.map((p: string, i: number) => [p, base + (i < remPence ? 1 : 0)]));
        money.expenses = [...(money.expenses || []), { id: `so-${it.id}-${month}`, desc: `${it.title} (standing order)`, amount: it.amount, paidBy: it.paidBy, split, date: keyOf(now.today), receipt: null, by: "Fozzfather", at: Date.now() }];
        it.lastRun = month; changed = true;
        for (const [p, share] of Object.entries(split) as [string, number][]) if (p !== it.paidBy)
          extra.push({ person: p, title: "The Fozzfather", body: `${it.title} has gone out. You owe ${it.paidBy} ${gbp(share)}.`, url: APP + "#money", tag: "so-" + it.id });
      }
      if (changed) { await db.from("rota").upsert({ key: "money", data: money }); await db.from("rota").upsert({ key: "recurring", data: rec }); }
    }
    const result = await deliver([...(await compute(now)), ...extra]);
    await db.from("rota").upsert({ key: "fozz:log", data: { slots: [...log, slot].slice(-60) } });
    return json({ slot, ...result });
  }
  return json({ error: "unknown mode" }, 400);
});
