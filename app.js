// Word Shake: a multiplayer word-dice game.
// Shared state lives in Firebase Firestore (see README.md). Without a Firebase
// config the game runs solo on one device using an in-memory store.
import { firebaseConfig } from "./firebase-config.js";

// ---------- rules ----------
const DICE4 = ["AAEEGN","ABBJOO","ACHOPS","AFFKPS","AOOTTW","CIMOTU","DEILRX","DELRVY","DISTTY","EEGHNW","EEINSU","EHRTVW","EIOSST","ELRTTY","HIMNUQ","HLNNRZ"];
const DICE5 = ["AAAFRS","AAEEEE","AAFIRS","ADENNN","AEEEEM","AEEGMU","AEGMNN","AFIRSY","BJKQXZ","CCENST","CEIILT","CEILPT","CEIPST","DDHNOT","DHHLOR","DHLNOR","DHLNOR","EIIITT","EMOTTT","ENSSSU","FIPRSY","GORRVW","IPRRRY","NOOTUW","OOOTTU"];
const DEF = { duration: 180, size: 4, minLen: 3, cancel: true, dict: true, ready: "all" };
const HEARTBEAT = 25000, AWAY_AFTER = 75000; // players whose page hasn't checked in for 75 s don't count
const DURATIONS = [60, 90, 120, 180, 240, 300];
const COUNTDOWN = 3500;
const pts = n => n < 3 ? 0 : n <= 4 ? 1 : n === 5 ? 2 : n === 6 ? 3 : n === 7 ? 5 : 11;
const FIREBASE_VERSION = "10.12.2";

// ---------- state ----------
const S = {
  store: null, uid: null, skew: 0, room: null, joined: false, name: "",
  game: null, players: {}, subs: [], strikes: {},
  found: [], foundKey: "", lastPhase: null, boardKey: "", fresh: null, confirmNew: false,
  roomUnsubs: [], gameUnsubs: [], gid: null, missed: {},
};
const $ = id => document.getElementById(id);
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const rid = () => Math.random().toString(36).slice(2, 10);
const now = () => Date.now() + S.skew;
const roomPath = (sub = "") => "rooms/" + S.room + sub;
const settings = () => ({ ...DEF, ...(S.game?.settings || {}) });
const fmt = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const k in (attrs || {})) {
    const v = attrs[k]; if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; el.append(c instanceof Node ? c : document.createTextNode(String(c))); }
  return el;
}

// ---------- stores ----------
async function firebaseStore(cfg) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
  const [{ initializeApp }, A, F] = await Promise.all([
    import(base + "firebase-app.js"), import(base + "firebase-auth.js"), import(base + "firebase-firestore.js")]);
  const app = initializeApp(cfg);
  const cred = await A.signInAnonymously(A.getAuth(app));
  const fs = F.getFirestore(app);
  const wrap = s => ({ id: s.id, exists: s.exists(), data: s.exists() ? s.data() : undefined });
  return {
    uid: cred.user.uid,
    serverTime: () => F.serverTimestamp(),
    doc: p => {
      const r = F.doc(fs, p);
      return {
        get: async () => wrap(await F.getDoc(r)),
        set: d => F.setDoc(r, d),
        merge: d => F.setDoc(r, d, { merge: true }),
        update: d => F.updateDoc(r, d),
        onSnapshot: (next, err) => F.onSnapshot(r, s => next(wrap(s)), err),
      };
    },
    list: (cp, field, value, next, err) => {
      let q = F.collection(fs, cp);
      if (field) q = F.query(q, F.where(field, "==", value));
      return F.onSnapshot(q, s => next(s.docs.map(wrap)), err);
    },
    transact: (p, fn) => F.runTransaction(fs, async tx => {
      const r = F.doc(fs, p); const s = await tx.get(r);
      const next = fn(s.exists() ? s.data() : null);
      if (next) tx.set(r, next);
      return !!next;
    }),
    // Writes the doc with a server timestamp and returns (server clock - this device's clock).
    stamp: async (p, d) => {
      const r = F.doc(fs, p); const t0 = Date.now();
      await F.setDoc(r, { ...d, seenAt: F.serverTimestamp() }, { merge: true });
      const t1 = Date.now(); const s = await F.getDoc(r); const ts = s.data()?.seenAt;
      return ts?.toMillis ? ts.toMillis() - (t0 + t1) / 2 : 0;
    },
  };
}
function localStore() {
  const docs = new Map(), subs = new Set(); const notify = () => subs.forEach(f => f());
  const snap = p => { const d = docs.get(p); return { id: p.split("/").pop(), exists: !!d, data: d ? structuredClone(d) : undefined }; };
  const parent = p => p.slice(0, p.lastIndexOf("/"));
  const listen = f => { subs.add(f); queueMicrotask(f); return () => subs.delete(f); };
  let uid = ls.get("ws-id"); if (!uid) { uid = "p" + rid() + rid(); ls.set("ws-id", uid); }
  return {
    uid, local: true,
    serverTime: () => Date.now(),
    doc: p => ({
      get: async () => snap(p),
      set: async d => { docs.set(p, structuredClone(d)); notify(); },
      merge: async d => { docs.set(p, { ...(docs.get(p) || {}), ...structuredClone(d) }); notify(); },
      update: async d => { const c = docs.get(p); if (!c) throw new Error("missing"); Object.assign(c, structuredClone(d)); notify(); },
      onSnapshot: next => listen(() => next(snap(p))),
    }),
    list: (cp, field, value, next) => listen(() => {
      const out = []; for (const [p, d] of docs) if (parent(p) === cp && (!field || d[field] === value)) out.push(snap(p));
      next(out);
    }),
    transact: async (p, fn) => { const next = fn(snap(p).data ?? null); if (next) { docs.set(p, structuredClone(next)); notify(); } return !!next; },
    stamp: async (p, d) => { docs.set(p, { ...(docs.get(p) || {}), ...d }); notify(); return 0; },
  };
}

// ---------- dictionary ----------
let WORDS = null, DICT = null;
fetch("words.txt").then(r => r.ok ? r.text() : Promise.reject(r.status)).then(t => {
  WORDS = t.split("\n").map(w => w.trim()).filter(Boolean).sort();
  DICT = new Set(WORDS);
  if (phase() === "results") renderAll();
}).catch(() => {});
function hasPrefix(p) {
  let lo = 0, hi = WORDS.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (WORDS[m] < p) lo = m + 1; else hi = m; }
  return lo < WORDS.length && WORDS[lo].startsWith(p);
}
function solve(board, n, min) {
  const b = board.map(x => x.toLowerCase()), out = new Set(), used = new Array(b.length).fill(false);
  const go = (i, w) => {
    w += b[i]; if (!hasPrefix(w)) return;
    if (w.length >= min && DICT.has(w)) out.add(w);
    used[i] = true;
    for (let j = 0; j < b.length; j++) if (!used[j] && adj(i, j, n)) go(j, w);
    used[i] = false;
  };
  for (let i = 0; i < b.length; i++) go(i, "");
  return [...out];
}

// ---------- boot ----------
async function boot() {
  if (firebaseConfig?.apiKey) {
    try { S.store = await firebaseStore(firebaseConfig); }
    catch (e) { console.error(e); note("Couldn't reach the game server. Check your connection and reload. (Details are in the browser console.)"); $("v-loading").hidden = true; return; }
  } else {
    S.store = localStore();
    note("Firebase isn't set up yet, so this is solo play on one device. Follow README.md to turn on multiplayer.");
  }
  S.uid = S.store.uid;
  S.name = ls.get("ws-name") || "";
  const urlRoom = cleanCode(new URLSearchParams(location.search).get("room") || "");
  const lastRoom = ls.get("ws-room");
  setInterval(tick, 250);
  setInterval(heartbeat, HEARTBEAT);
  document.addEventListener("visibilitychange", heartbeat);
  if (S.name && urlRoom && urlRoom === lastRoom && !S.store.local) { await enterRoom(urlRoom, false, true); }
  S.invited = urlRoom || null;
  renderAll();
}
const cleanCode = c => c.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
function newCode() {
  const C = "BCDFGHJKLMNPRSTVWZ", V = "AEIOU", r = s => s[Math.floor(Math.random() * s.length)];
  return r(C) + r(V) + r(C) + r(V) + Math.floor(10 + Math.random() * 90);
}

async function enterRoom(code, create, quiet) {
  const name = ($("nameinput").value || S.name).trim().slice(0, 20);
  if (!name) { if (!quiet) { toast("Type your name first"); $("nameinput").focus(); } return; }
  S.name = name; ls.set("ws-name", name);
  try {
    if (create) {
      do { code = newCode(); } while ((await S.store.doc("rooms/" + code).get()).exists);
      await S.store.doc("rooms/" + code).set({ code, gameId: rid(), round: 0, settings: DEF, createdAt: Date.now() });
    } else {
      code = cleanCode(code);
      if (!code) { toast("Type the table code"); return; }
      if (!(await S.store.doc("rooms/" + code).get()).exists) {
        if (!quiet) toast(`No table with code ${code}. Check the code, or start a new table.`);
        return;
      }
    }
    if (code !== S.room) leaveRoom();
    S.room = code;
    S.skew = await S.store.stamp(roomPath("/players/" + S.uid), { name });
    ls.set("ws-room", code);
    history.replaceState(null, "", location.pathname + "?room=" + code);
    S.joined = true; S.invited = code;
    subscribeRoom();
  } catch (e) { failWrite(e); }
  renderAll();
}
function leaveRoom() {
  S.roomUnsubs.forEach(u => u()); S.gameUnsubs.forEach(u => u());
  S.roomUnsubs = []; S.gameUnsubs = []; S.gid = null;
  S.game = null; S.players = {}; S.subs = []; S.strikes = {}; S.found = []; S.foundKey = ""; S.boardKey = ""; S.lastPhase = null;
}
function subscribeRoom() {
  const store = S.store;
  S.roomUnsubs.push(store.doc(roomPath()).onSnapshot(snap => {
    S.game = snap.exists ? snap.data : null;
    const gid = S.game?.gameId || null;
    if (gid !== S.gid) { S.gid = gid; subscribeGame(gid); }
    syncRoundKey(); renderAll();
  }, lost));
  S.roomUnsubs.push(store.list(roomPath("/players"), null, null, docs => {
    const m = {}; docs.forEach(d => m[d.id] = d.data); S.players = m; renderAll();
  }, lost));
}
function subscribeGame(gid) {
  S.gameUnsubs.forEach(u => u()); S.gameUnsubs = []; S.subs = []; S.strikes = {};
  if (!gid) return;
  S.gameUnsubs.push(S.store.list(roomPath("/subs"), "gameId", gid, docs => {
    S.subs = docs.map(d => d.data); restoreMine(); renderAll();
  }, lost));
  S.gameUnsubs.push(S.store.list(roomPath("/strikes"), "gameId", gid, docs => {
    const m = {}; docs.forEach(d => { const x = d.data; if (x.struck) m[x.round + "|" + x.word] = true; }); S.strikes = m; renderAll();
  }, lost));
}
// ---------- who's here, who's ready ----------
const ms = t => t?.toMillis ? t.toMillis() : typeof t === "number" ? t : 0;
function heartbeat() {
  if (!S.joined || document.visibilityState !== "visible") return;
  S.store.doc(roomPath("/players/" + S.uid)).merge({ seenAt: S.store.serverTime() }).catch(() => {});
}
// The next round's id: a player is ready when their `ready` field equals it, so it resets itself each round.
const readyKey = () => (S.game?.gameId || "") + ":" + ((S.game?.round || 0) + 1);
function activeIds() {
  const cutoff = now() - AWAY_AFTER;
  return Object.keys(S.players).filter(id => id === S.uid || ms(S.players[id].seenAt) > cutoff);
}
function readyState() {
  const active = activeIds(), key = readyKey();
  const ready = active.filter(id => S.players[id].ready === key);
  const mode = settings().ready;
  const need = mode === "all" ? active.length : Math.floor(active.length / 2) + 1;
  return { active, ready, need, mode, met: mode !== "off" && ready.length >= need && ready.length > 0, meReady: ready.includes(S.uid) };
}
async function setReady(on) {
  try { await S.store.doc(roomPath("/players/" + S.uid)).merge({ ready: on ? readyKey() : null, seenAt: S.store.serverTime() }); }
  catch (e) { failWrite(e); }
}
function maybeAutoStart() {
  const p = phase(); if (p !== "lobby" && p !== "results") return;
  const r = readyState();
  // Only ready players try to start it; the transaction in startRound makes sure just one start lands.
  if (r.met && r.meReady && S.autoKey !== readyKey()) { S.autoKey = readyKey(); startRound().then(ok => { if (!ok) setTimeout(() => S.autoKey = null, 2000); }); }
}
function onStartClick() {
  if (settings().ready === "off") return startRound();
  setReady(!readyState().meReady);
}

function lost(e) { console.error(e); note("Lost the connection to the table. Reload the page to rejoin."); }
function note(t) { const n = $("notice"); n.textContent = t; n.hidden = !t; }
let toastT = 0;
function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 2600); }

// ---------- phases ----------
function phase() {
  const g = S.game; if (!g || !g.round) return "lobby";
  const t = now(); if (t < g.startsAt) return "countdown"; if (t < g.endsAt) return "play"; return "results";
}
function roundKey() { const g = S.game; return g && g.round ? g.gameId + "-" + g.round : ""; }
function syncRoundKey() { const k = roundKey(); if (k !== S.foundKey) { S.foundKey = k; S.found = []; S.fresh = null; restoreMine(); } }
function restoreMine() {
  if (S.found.length || !S.game) return;
  const mine = S.subs.find(s => s.uid === S.uid && s.round === S.game.round && s.gameId === S.game.gameId);
  if (mine) S.found = [...mine.words];
}
function tick() {
  if (!S.joined) return;
  const p = phase();
  if (p !== S.lastPhase) {
    const prev = S.lastPhase; S.lastPhase = p;
    if (p === "play") wake(true);
    if (prev === "play" && p === "results") { endTrace(); wake(false); buzz([60, 40, 60]); }
    renderAll();
  }
  if (p === "countdown" || p === "play") renderClock();
  else maybeAutoStart();
}

// ---------- render ----------
function renderAll() {
  if (!S.store) return;
  const p = phase();
  $("v-loading").hidden = true;
  const showJoin = !S.joined;
  $("v-join").hidden = !showJoin;
  if (showJoin) renderJoin();
  const playing = !showJoin && (p === "play" || p === "countdown");
  $("v-play").hidden = !playing;
  $("v-between").hidden = showJoin || playing;
  $("chips").hidden = !S.joined;
  if (S.joined) {
    $("mechip").replaceChildren(h("b", null, S.name));
    $("roomchip").replaceChildren("Table ", h("span", { class: "code" }, S.room));
  }
  $("roundtag").textContent = S.joined && S.game?.round ? "Round " + S.game.round : "";
  if (playing) renderPlay(p); else if (!showJoin) renderBetween(p);
}
function renderJoin() {
  const ni = $("nameinput"); if (!ni.value && document.activeElement !== ni) ni.value = S.name;
  const inv = S.invited;
  $("join-invited").hidden = !inv; $("join-open").hidden = !!inv;
  $("invitedcode").textContent = inv || "";
  $("jointitle").textContent = inv ? "You're invited to table " + inv : "Pull up a chair";
}

function buildBoard(grid, board, n, blank) {
  grid.style.setProperty("--n", n); grid.style.setProperty("--gap", n === 5 ? "6px" : "8px");
  grid.replaceChildren(...board.map((L, i) => h("div", { class: "die" + (blank ? " blank" : ""), "data-i": i },
    L === "Qu" ? h("span", { class: "qu" }, "Qu") : L)));
}
function renderPlay(p) {
  const g = S.game, key = roundKey() + (p === "countdown" ? "c" : "");
  if (S.boardKey !== key) {
    S.boardKey = key;
    buildBoard($("grid"), g.board, g.size || 4, p === "countdown");
    $("grid").append(svgTrace());
    $("tray").classList.toggle("rolling", p === "countdown");
    $("countdown").hidden = p !== "countdown";
    $("word").textContent = ""; $("word").className = "word";
  }
  renderFound(); renderOthers(); renderClock();
}
function renderClock() {
  const g = S.game; if (!g) return; const t = now();
  if (t < g.startsAt) {
    $("countdown").textContent = Math.ceil((g.startsAt - t) / 1000);
    $("clock").textContent = fmt((g.endsAt - g.startsAt) / 1000); $("timefill").style.transform = "scaleX(1)"; return;
  }
  const left = (g.endsAt - t) / 1000, total = (g.endsAt - g.startsAt) / 1000;
  $("clock").textContent = fmt(left);
  $("timefill").style.transform = `scaleX(${Math.max(0, left / total)})`;
  $("timer").classList.toggle("low", left <= 10);
}
function renderFound() {
  const tot = S.found.reduce((a, w) => a + pts(w.length), 0);
  $("mytally").textContent = S.found.length + (S.found.length === 1 ? " word · " : " words · ") + tot + " pts";
  $("mywords").replaceChildren(...[...S.found].reverse().map(w => h("li", { class: w === S.fresh ? "fresh" : null }, w, h("span", { class: "pts" }, "+" + pts(w.length)))));
  $("nowords").hidden = S.found.length > 0;
}
function renderOthers() {
  const g = S.game; const others = S.subs.filter(s => s.round === g.round && s.uid !== S.uid);
  $("others").replaceChildren(...(others.length ? [h("span", null, "Others:")] : []),
    ...others.map(s => h("span", null, nameOf(s) + " ", h("b", null, s.words.length))));
}
const nameOf = s => S.players[s.uid]?.name || s.name || "Player";

function renderBetween(p) {
  const g = S.game, st = settings();
  const res = $("results"), tots = $("totals");
  if (p === "results") { res.hidden = false; renderResults(res, g.round); } else res.hidden = true;
  const done = !g ? 0 : p === "results" ? g.round : g.round - 1;
  if (done >= 2) { tots.hidden = false; renderTotals(tots, done); } else tots.hidden = true;

  const r = readyState(), next = (g?.round || 0) + 1;
  const pname = id => S.players[id]?.name || "Player";
  const ids = [...r.active].sort((a, b) => pname(a).localeCompare(pname(b)));
  $("people").replaceChildren(...ids.map(id => h("li", {
    class: [id === S.uid ? "me" : "", r.mode !== "off" && r.ready.includes(id) ? "ready" : ""].join(" ").trim() || null,
  }, pname(id) + (id === S.uid ? " (you)" : ""))));
  const first = !g || !g.round;
  $("lobbytitle").textContent = first ? "Table " + S.room : "Ready for round " + next + "?";
  $("lobbycode").textContent = S.room;
  $("invitebox").hidden = !first;
  const btn = $("startbtn"), status = $("readystatus");
  if (r.mode === "off") {
    btn.textContent = "Shake & start round " + next; btn.classList.remove("isready"); status.hidden = true;
  } else {
    btn.textContent = r.meReady ? "✓ Ready (tap to undo)" : "I'm ready for round " + next;
    btn.classList.toggle("isready", r.meReady);
    const waiting = r.active.filter(id => !r.ready.includes(id)).map(pname);
    status.hidden = false;
    status.replaceChildren(h("b", null, `${r.ready.length} of ${r.active.length} ready`),
      r.mode === "most" ? ` · starts at ${r.need}` : "",
      waiting.length && waiting.length <= 4 ? ` · waiting for ${waiting.join(", ")}` : "");
  }

  seg($("s-duration"), DURATIONS.map(s => [s, fmt(s)]), st.duration, v => writeSettings({ duration: v }));
  const ci = $("s-custom"); if (document.activeElement !== ci) ci.value = DURATIONS.includes(st.duration) ? "" : String(st.duration / 60);
  seg($("s-size"), [[4, "4 × 4"], [5, "5 × 5"]], st.size, v => writeSettings({ size: v }));
  seg($("s-min"), [[3, "3 letters"], [4, "4 letters"]], st.minLen, v => writeSettings({ minLen: v }));
  seg($("s-ready"), [["all", "Everyone is ready"], ["most", "Most are ready"], ["off", "Anyone taps start"]], st.ready, v => writeSettings({ ready: v }));
  seg($("s-cancel"), [[true, "Cancel out (classic)"], [false, "Count for both"]], st.cancel, v => writeSettings({ cancel: v }));
  seg($("s-dict"), [[true, "On"], [false, "Off (anything goes)"]], st.dict, v => writeSettings({ dict: v }));
  $("newgamebtn").textContent = S.confirmNew ? "Tap again to reset" : "New game";
  $("newgamebtn").disabled = first;
}
function seg(el, opts, cur, on) {
  el.replaceChildren(...opts.map(([v, label]) => h("button", { type: "button", "aria-pressed": String(v === cur), onclick: () => on(v) }, label)));
}

function tally(round) {
  const subs = S.subs.filter(s => s.round === round);
  const rules = { ...settings(), ...(subs[0]?.rules || {}) };
  const count = {};
  subs.forEach(s => new Set(s.words).forEach(w => { if (!S.strikes[round + "|" + w]) count[w] = (count[w] || 0) + 1; }));
  const rows = subs.map(s => {
    const words = [...new Set(s.words)].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(w => {
      const struck = !!S.strikes[round + "|" + w], shared = !struck && count[w] > 1, cancelled = shared && rules.cancel;
      return { w, struck, shared, pts: struck || cancelled ? 0 : pts(w.length) };
    });
    return { uid: s.uid, name: nameOf(s), words, score: words.reduce((a, x) => a + x.pts, 0) };
  });
  rows.sort((a, b) => b.score - a.score || b.words.length - a.words.length);
  return { rows, rules };
}
function renderResults(el, round) {
  const { rows, rules } = tally(round), g = S.game;
  const best = rows.flatMap(r => r.words.filter(x => !x.struck).map(x => ({ ...x, name: r.name }))).sort((a, b) => b.w.length - a.w.length)[0];
  const tray = h("div", { class: "tray board-mini" }, h("div", { class: "grid" }));
  buildBoard(tray.firstChild, g.board, g.size || 4, false);

  let missedEl = null;
  if (DICT) {
    const key = roundKey();
    S.missed[key] ||= solve(g.board, g.size || 4, rules.minLen || 3);
    const foundAll = new Set(rows.flatMap(r => r.words.map(x => x.w)));
    const missed = S.missed[key].filter(w => !foundAll.has(w)).sort((a, b) => b.length - a.length || a.localeCompare(b));
    if (missed.length) missedEl = h("details", null,
      h("summary", null, `Words nobody found (${missed.length})`),
      h("ul", { class: "words missed" }, missed.slice(0, 80).map(w => h("li", null, w))),
      missed.length > 80 ? h("p", { class: "muted", style: "margin-top:8px;font-size:.85rem" }, `Showing the 80 longest.`) : null);
  }

  el.replaceChildren(
    h("div", { class: "reshead" }, tray, h("div", null,
      h("h2", null, "Round " + round + " scores"),
      best ? h("p", { class: "bestword" }, "Longest word: ", h("b", null, best.w), " by " + best.name) : null,
      h("div", { class: "legend" }, h("span", { class: "l-shared" }, rules.cancel ? "Found by 2+ (no points)" : "Found by 2+"), h("span", { class: "l-struck" }, "Challenged")),
      h("p", { class: "muted", style: "font-size:.85rem" }, "Disagree with a word? Tap it to challenge. Tap again to restore it.")
    )),
    rows.length ? h("ol", { class: "scores" }, rows.map((r, i) => h("li", { class: "score" + (i === 0 && r.score > 0 ? " first" : "") },
      h("div", { class: "scoreline" }, h("span", { class: "rank" }, i + 1), h("span", { class: "pname" }, r.name + (r.uid === S.uid ? " (you)" : "")),
        h("span", { class: "pscore" }, r.score, h("small", null, r.words.length + (r.words.length === 1 ? " word" : " words")))),
      r.words.length ? h("div", { class: "words" }, r.words.map(x => h("button", {
        type: "button", class: (x.struck ? "struck" : x.shared ? "shared" : ""),
        title: x.struck ? "Challenged. Tap to restore" : "Tap to challenge",
        onclick: () => toggleStrike(round, x.w, !x.struck),
      }, x.w, h("span", { class: "pts" }, x.struck ? "✕" : x.pts ? "+" + x.pts : "0")))) : h("p", { class: "muted" }, "No words this round.")
    ))) : h("p", { class: "muted" }, "Nobody found any words. Tough board!"),
    missedEl
  );
}
function renderTotals(el, done) {
  const tot = {};
  for (let r = 1; r <= done; r++) tally(r).rows.forEach(x => {
    const t = (tot[x.uid] ||= { name: x.name, score: 0, rounds: 0, words: 0 });
    t.score += x.score; t.rounds++; t.words += x.words.length;
  });
  const rows = Object.entries(tot).sort((a, b) => b[1].score - a[1].score);
  el.replaceChildren(h("h2", null, "Game totals"), h("p", { class: "muted" }, "After " + done + " rounds"),
    h("div", { class: "tablewrap" }, h("table", { class: "totals" },
      h("thead", null, h("tr", null, h("th", null, "Player"), h("th", { class: "n" }, "Rounds"), h("th", { class: "n" }, "Words"), h("th", { class: "n" }, "Points"))),
      h("tbody", null, rows.map(([id, x], i) => h("tr", { class: i === 0 ? "lead" : null },
        h("td", null, x.name + (id === S.uid ? " (you)" : "")), h("td", { class: "n" }, x.rounds), h("td", { class: "n" }, x.words), h("td", { class: "n" }, x.score)))))));
}

// ---------- writes ----------
function failWrite(e) {
  console.error(e);
  note(e?.code === "permission-denied" ? "The game server refused that change. Check the Firestore rules (see README.md)." : "Couldn't save just now. Check your connection.");
}
async function writeSettings(patch) {
  try { await S.store.doc(roomPath()).update({ settings: { ...settings(), ...patch } }); } catch (e) { failWrite(e); }
}
async function startRound() {
  const btn = $("startbtn"); btn.disabled = true;
  const seen = S.game?.round || 0;
  try {
    return await S.store.transact(roomPath(), cur => {
      if (!cur || (cur.round || 0) !== seen) return null; // someone else already started it
      const st = { ...DEF, ...(cur.settings || {}) }; const t = now();
      return { ...cur, round: seen + 1, board: roll(st.size), size: st.size, settings: st,
        startsAt: t + COUNTDOWN, endsAt: t + COUNTDOWN + st.duration * 1000 };
    });
  } catch (e) { failWrite(e); return false; }
  finally { btn.disabled = false; }
}
async function newGame() {
  if (!S.confirmNew) { S.confirmNew = true; renderAll(); setTimeout(() => { S.confirmNew = false; renderAll(); }, 4000); return; }
  S.confirmNew = false;
  try { await S.store.doc(roomPath()).update({ gameId: rid(), round: 0 }); } catch (e) { failWrite(e); }
}
async function toggleStrike(round, word, struck) {
  const gid = S.game.gameId;
  try { await S.store.doc(roomPath(`/strikes/${gid}-${round}-${word}`)).set({ gameId: gid, round, word, struck, by: S.uid }); } catch (e) { failWrite(e); }
}
let saving = false, dirty = false;
async function save() {
  dirty = true; if (saving) return; saving = true;
  while (dirty) {
    dirty = false; const g = S.game; if (!g) break;
    const st = settings();
    try {
      await S.store.doc(roomPath(`/subs/${g.gameId}-${g.round}-${S.uid}`)).set({
        gameId: g.gameId, round: g.round, uid: S.uid, name: S.name, words: [...S.found],
        rules: { cancel: st.cancel, minLen: st.minLen }, at: Date.now() });
    } catch (e) { failWrite(e); break; }
  }
  saving = false;
}
async function invite() {
  const url = location.origin + location.pathname + "?room=" + S.room;
  if (navigator.share && matchMedia("(pointer:coarse)").matches) {
    try { await navigator.share({ title: "Word Shake", text: `Join my Word Shake table (code ${S.room})`, url }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(url); toast("Invite link copied"); }
  catch { toast(url); }
}

// ---------- dice ----------
function roll(n) {
  const dice = [...(n === 5 ? DICE5 : DICE4)];
  for (let i = dice.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [dice[i], dice[j]] = [dice[j], dice[i]]; }
  return dice.map(d => { const f = d[Math.floor(Math.random() * 6)]; return f === "Q" ? "Qu" : f; });
}
const adj = (a, b, n) => a !== b && Math.abs((a % n) - (b % n)) <= 1 && Math.abs(Math.floor(a / n) - Math.floor(b / n)) <= 1;

// ---------- tracing ----------
let trace = null;
const grid = $("grid");
function svgTrace() {
  const NS = "http://www.w3.org/2000/svg", s = document.createElementNS(NS, "svg");
  s.setAttribute("class", "trace"); s.append(document.createElementNS(NS, "polyline")); return s;
}
function geometry() {
  const gr = grid.getBoundingClientRect();
  return { gr, cells: [...grid.querySelectorAll(".die")].map(c => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2 - gr.left, y: r.top + r.height / 2 - gr.top, s: r.width }; }) };
}
function hit(e, loose) {
  const { gr, cells } = trace.geo; const x = e.clientX - gr.left, y = e.clientY - gr.top;
  let best = -1, bd = 1e9; cells.forEach((c, i) => { const d = Math.hypot(c.x - x, c.y - y); if (d < bd) { bd = d; best = i; } });
  return best >= 0 && bd <= cells[best].s * (loose ? .75 : .42) ? best : -1;
}
grid.addEventListener("pointerdown", e => {
  if (phase() !== "play") return; e.preventDefault();
  trace = { id: e.pointerId, path: [], geo: geometry() };
  const i = hit(e, true); if (i < 0) { trace = null; return; }
  try { grid.setPointerCapture(e.pointerId); } catch {}
  trace.path = [i]; buzz(6); drawTrace();
});
grid.addEventListener("pointermove", e => {
  if (!trace || e.pointerId !== trace.id) return;
  const i = hit(e, false); if (i < 0) return; const p = trace.path, last = p[p.length - 1];
  if (i === last) return;
  if (p.length > 1 && i === p[p.length - 2]) { p.pop(); drawTrace(); return; }
  if (p.includes(i) || !adj(last, i, S.game.size || 4)) return;
  p.push(i); buzz(6); drawTrace();
});
grid.addEventListener("pointerup", e => { if (!trace || e.pointerId !== trace.id) return; const p = trace.path; endTrace(); if (p.length) submit(p); });
grid.addEventListener("pointercancel", e => { if (trace && e.pointerId === trace.id) endTrace(); });
function drawTrace() {
  const dice = grid.querySelectorAll(".die"); dice.forEach(d => d.classList.remove("on"));
  const line = grid.querySelector(".trace polyline");
  if (!trace) { if (line) line.setAttribute("points", ""); return; }
  trace.path.forEach(i => dice[i].classList.add("on"));
  const c = trace.geo.cells;
  line.setAttribute("points", trace.path.map(i => c[i].x + "," + c[i].y).join(" "));
  line.setAttribute("stroke-width", (c[0]?.s || 40) * .22);
  const w = $("word"); w.className = "word"; w.textContent = trace.path.map(i => S.game.board[i]).join("").toUpperCase();
}
function endTrace() { trace = null; drawTrace(); }

function submit(path) {
  if (phase() !== "play") return;
  const w = path.map(i => S.game.board[i]).join("").toLowerCase();
  const st = settings();
  if (w.length < st.minLen) return say(w.length <= 1 ? "" : "Too short · " + st.minLen + "+ letters", "bad");
  if (S.found.includes(w)) return say(w.toUpperCase() + " · already have it", "dup");
  if (st.dict && DICT && !DICT.has(w)) return say(w.toUpperCase() + " · not in the dictionary", "bad");
  S.found.push(w); S.fresh = w; renderFound(); save(); buzz(20);
  say(w.toUpperCase() + "  +" + pts(w.length), "good");
}
let sayT = 0;
function say(text, kind) {
  const el = $("word"); el.textContent = text; el.className = "word say " + kind; void el.offsetWidth;
  clearTimeout(sayT); sayT = setTimeout(() => { if (!trace) { el.textContent = ""; el.className = "word"; } }, 1400);
}
function pathFor(word) {
  const b = S.game.board.map(x => x.toLowerCase()), n = S.game.size || 4;
  const go = (pos, used) => {
    if (pos === word.length) return used;
    for (let j = 0; j < b.length; j++) {
      if (used.includes(j) || (used.length && !adj(used[used.length - 1], j, n))) continue;
      if (word.startsWith(b[j], pos)) { const r = go(pos + b[j].length, [...used, j]); if (r) return r; }
    }
    return null;
  };
  return go(0, []);
}

// ---------- device niceties ----------
function buzz(p) { try { navigator.vibrate?.(p); } catch {} }
let lock = null;
async function wake(on) {
  try { if (on && !lock) lock = await navigator.wakeLock?.request("screen"); else if (!on && lock) { await lock.release(); lock = null; } }
  catch { lock = null; }
}

// ---------- light / dark ----------
// Follows the device setting until the player taps the toggle; after that their choice is remembered.
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light")) === "dark";
function syncThemeToggle() {
  const label = isDark() ? "Switch to light mode" : "Switch to dark mode";
  $("themetoggle").setAttribute("aria-label", label); $("themetoggle").title = label;
  document.querySelector('meta[name="theme-color"]').content = isDark() ? "#0e161c" : "#1d4e63";
}
$("themetoggle").addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next; ls.set("ws-theme", next); syncThemeToggle();
});
darkQuery.addEventListener("change", syncThemeToggle);
syncThemeToggle();

// ---------- wiring ----------
$("typeform").addEventListener("submit", e => {
  e.preventDefault(); const inp = $("typeinput");
  const w = inp.value.trim().toLowerCase().replace(/[^a-z]/g, ""); inp.value = "";
  if (!w || phase() !== "play") return;
  const p = pathFor(w); if (!p) return say(w.toUpperCase() + " · not on the board", "bad");
  submit(p);
});
document.addEventListener("keydown", e => {
  if (!S.joined || phase() !== "play" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[a-zA-Z]$/.test(e.key) && !(document.activeElement instanceof HTMLInputElement)) $("typeinput").focus();
});
$("newtablebtn").addEventListener("click", () => enterRoom(null, true));
$("codeform").addEventListener("submit", e => { e.preventDefault(); enterRoom($("codeinput").value, false); });
$("joininvitedbtn").addEventListener("click", () => enterRoom(S.invited, false));
$("notthisbtn").addEventListener("click", () => { S.invited = null; renderAll(); });
$("nameinput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); S.invited ? enterRoom(S.invited, false) : $("codeinput").focus(); } });
$("mechip").addEventListener("click", () => { S.joined = false; S.invited = S.room; renderAll(); $("nameinput").focus(); });
$("roomchip").addEventListener("click", invite);
$("invitebtn").addEventListener("click", invite);
$("startbtn").addEventListener("click", onStartClick);
$("newgamebtn").addEventListener("click", newGame);
$("s-custom").addEventListener("change", e => { const m = parseFloat(e.target.value); if (m >= 0.5 && m <= 15) writeSettings({ duration: Math.round(m * 60) }); });

boot();
