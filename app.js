'use strict';
/* Macro Tracker (web) — same parser and food table as the desktop app (macro_tracker.pyw). */

const MEALS = ['Morning', 'Afternoon', 'Evening', 'Night'];
const MACROS = [['kcal', 'Calories', 'kcal'], ['protein', 'Protein', 'g'], ['carbs', 'Carbs', 'g'], ['fat', 'Fat', 'g']];
const DEFAULT_TARGETS = { kcal: 2200, protein: 120, carbs: 260, fat: 70 };
const STORE_KEY = 'macroTracker.v1';

// ---------------------------------------------------------------- parser
const D = FOOD_DATA;
const UNIT_LOOKUP = new Map();
for (const [canon, aliases] of Object.entries(D.unit_aliases)) for (const a of aliases) UNIT_LOOKUP.set(a, canon);
const UNIT_WORDS = new Set(UNIT_LOOKUP.keys());
const NUM_WORDS = new Map(Object.entries(D.num_words));
const STOPWORDS = new Set(D.stopwords);
const SPELLING = new Map(Object.entries(D.spelling));
const GENERIC_UNITS = D.generic_units;

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = words => [...words].sort((a, b) => b.length - a.length).map(reEsc).join('|');
const NUM = String.raw`\d+\s*/\s*\d+|\d+(?:\.\d+)?|` + alt(NUM_WORDS.keys());
const UNIT = alt(UNIT_WORDS);
const qtyRe = () => new RegExp(`(^|[^a-z\\d.])(${NUM})\\s*(${UNIT})?(?![a-z])`, 'gi');
const UNIT_ONLY_RE = new RegExp(`(^|[^a-z])(${UNIT})(?![a-z])`, 'i');
const SPLIT_RE = /\s*(?:\band\b|\bwith\b|&|\+|\bplus\b)\s*/i;

function normalizeToken(w) {
  w = SPELLING.get(w) ?? w;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return SPELLING.get(w) ?? w;
}

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z]+/g) || [])
    .filter(w => !STOPWORDS.has(w) && !UNIT_WORDS.has(w) && !NUM_WORDS.has(w))
    .map(normalizeToken);
}

function matchingChars(a, b) { // Ratcliff/Obershelp, as in Python's difflib
  if (!a || !b) return 0;
  let best = 0, ai = 0, bj = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    let k = 0;
    while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
    if (k > best) { best = k; ai = i; bj = j; }
  }
  if (!best) return 0;
  return best + matchingChars(a.slice(0, ai), b.slice(0, bj)) + matchingChars(a.slice(ai + best), b.slice(bj + best));
}
const ratio = (a, b) => (a.length + b.length) ? 2 * matchingChars(a, b) / (a.length + b.length) : 0;

function tokSim(a, b) {
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;
  const r = ratio(a, b);
  return r >= 0.82 ? r : 0;
}

function parseNumber(s) {
  s = s.toLowerCase().replace(/\s+/g, '');
  if (NUM_WORDS.has(s)) return NUM_WORDS.get(s);
  if (s.includes('/')) { const [a, b] = s.split('/').map(Number); return b ? a / b : 0; }
  return parseFloat(s);
}

function extractQuantity(text) {
  const ms = [...text.matchAll(qtyRe())];
  if (ms.length) {
    const rank = m => (m[3] ? 2 : 0) + (/^\d/.test(m[2]) ? 1 : 0);
    const best = ms.reduce((a, m) => (rank(m) > rank(a) ? m : a));
    return [parseNumber(best[2]), best[3] ? UNIT_LOOKUP.get(best[3].toLowerCase()) : null];
  }
  const m = text.match(UNIT_ONLY_RE);
  if (m) {
    const u = UNIT_LOOKUP.get(m[2].toLowerCase());
    if (!['g', 'kg', 'ml', 'l'].includes(u)) return [1, u];
  }
  return [null, null];
}

const fmtNum = x => String(Math.round(x * 100) / 100);

function resolveAmount(food, qty, unit) {
  const mass = food.liquid ? 'ml' : 'g';
  const units = food.units;
  if (unit === 'g' || unit === 'ml') return [qty, `${fmtNum(qty)} ${mass}`];
  if (unit === 'kg' || unit === 'l') return [qty * 1000, `${fmtNum(qty * 1000)} ${mass}`];
  if (qty == null) { qty = 1; unit = food.default; }
  else if (unit == null) {
    if (qty > 20) return [qty, `${fmtNum(qty)} ${mass}`];   // "150 rice" -> grams
    unit = 'piece' in units ? 'piece' : food.default;
  }
  let per;
  if (unit in units) per = units[unit];
  else if (unit === 'spoon' && 'tsp' in units) per = units.tsp * 2;
  else if (unit === 'piece') { unit = food.default; per = units[unit] ?? GENERIC_UNITS[unit] ?? 100; }
  else per = GENERIC_UNITS[unit] ?? 100;
  const grams = qty * per;
  const label = unit === 'serving' && qty === 1 ? '' : `${fmtNum(qty)} ${unit}`;
  const g = `${Math.round(grams)} ${mass}`;
  return [grams, label ? `${label} · ${g}` : g];
}

const newId = () => Math.random().toString(36).slice(2, 12);
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;

function makeItem(food, grams, amount, typed, id) {
  const k = grams / 100;
  return { id: id || newId(), food: food.name, typed, amount, grams: r1(grams),
    kcal: r1(food.kcal * k), protein: r2(food.protein * k), carbs: r2(food.carbs * k), fat: r2(food.fat * k) };
}

function totals(items) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const i of items) for (const k in t) t[k] += i[k];
  return t;
}

function F(name, kcal, protein, carbs, fat, aliases, units, def, liquid) {
  units = { ...(units || {}) };
  if (!('serving' in units)) units.serving = 100;
  return { name, kcal, protein, carbs, fat, aliases: (aliases || '').split(',').map(s => s.trim()).filter(Boolean),
    units, default: def || 'serving', liquid: !!liquid };
}

class FoodDB {
  constructor(custom) { this.reload(custom); }

  reload(custom) {
    this.customNames = new Set(custom.map(c => c.name));
    this.foods = new Map(D.foods.map(f => [f.name, f]));
    for (const c of custom) this.foods.set(c.name, c);
    this.aliasIndex = [];
    for (const f of this.foods.values()) {
      const isCustom = this.customNames.has(f.name);
      for (const a of new Set([...f.aliases, f.name])) {
        const toks = tokenize(a);
        if (toks.length) this.aliasIndex.push([toks, f.name, isCustom]);
      }
    }
  }

  match(tokens) {
    if (!tokens.length) return null;
    let bestKey = null, best = null;
    for (const [aliasToks, name, isCustom] of this.aliasIndex) {
      let total = 0, last = -1, ok = true;
      for (const at of aliasToks) {
        let s = 0, pos = -1;
        tokens.forEach((t, i) => { const v = tokSim(at, t); if (v > 0 && v >= s) { s = v; pos = i; } });
        if (!s) { ok = false; break; }
        total += s; last = Math.max(last, pos);
      }
      if (!ok) continue;
      const key = [aliasToks.length, Math.round(total / aliasToks.length * 1000) / 1000, last, isCustom ? 1 : 0];
      if (!bestKey || cmpKey(key, bestKey) > 0) { bestKey = key; best = [name, aliasToks.length]; }
    }
    if (best) return best;
    const joined = tokens.join(' ');
    let bestR = 0.8, close = null;
    for (const [aliasToks, name] of this.aliasIndex) {
      const r = ratio(joined, aliasToks.join(' '));
      if (r >= bestR) { bestR = r; close = name; }
    }
    return close ? [close, 1] : null;
  }

  splitChunk(chunk) {
    const parts = chunk.split(SPLIT_RE).filter(p => p.trim());
    if (parts.length <= 1) return [chunk];
    const whole = this.match(tokenize(chunk));
    const lens = parts.map(p => this.match(tokenize(p))).filter(Boolean).map(m => m[1]);
    if (whole && (!lens.length || whole[1] > Math.max(...lens))) return [chunk];
    return parts;
  }

  parse(text) {
    text = text.replace(/\(([^)]*)\)/g, (_, inner) => ' ' + inner.replace(/,/g, ' ') + ' ');
    const chunks = text.split(/[,\n;]+/).map(c => c.trim()).filter(Boolean);
    const items = [], unknown = [];
    let lastImplicit = null;
    for (const chunk of chunks) {
      for (let part of this.splitChunk(chunk)) {
        part = part.replace(/^[\s.\-]+|[\s.\-]+$/g, '');
        const [qty, unit] = extractQuantity(part);
        const toks = tokenize(part);
        if (!toks.length) {
          if (qty != null && lastImplicit) {
            const [idx, food] = lastImplicit;
            const [grams, amount] = resolveAmount(food, qty, unit);
            const old = items[idx];
            items[idx] = makeItem(food, grams, amount, `${old.typed} ${part}`, old.id);
            lastImplicit = null;
          }
          continue;
        }
        const m = this.match(toks);
        if (!m) { if (part) unknown.push(part); continue; }
        const food = this.foods.get(m[0]);
        const [grams, amount] = resolveAmount(food, qty, unit);
        items.push(makeItem(food, grams, amount, part.split(/\s+/).join(' ')));
        lastImplicit = qty == null ? [items.length - 1, food] : null;
      }
    }
    return [items, unknown];
  }
}

function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function mealForTime(d) {
  const h = d.getHours();
  if (h < 4) return 'Night';
  return h < 11 ? 'Morning' : h < 16 ? 'Afternoon' : h < 19 ? 'Evening' : 'Night';
}

// ---------------------------------------------------------------- storage
function loadState() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { /* private mode / blocked */ }
  s = s && typeof s === 'object' ? s : {};
  return { days: s.days || {}, custom: s.custom || [], targets: { ...DEFAULT_TARGETS, ...(s.targets || {}) } };
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save — storage is full or blocked'); }
}

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmt0 = x => Math.round(x).toLocaleString('en-IN');
const fmt1 = x => (Math.round(x * 10) / 10).toFixed(1);

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function shareOrDownload(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  try {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

// ---------------------------------------------------------------- app state
const state = loadState();
const db = new FoodDB(state.custom);
let day = isoDay(new Date());
let view = 'today';
let mealChoice = 'Auto';
let pendingUnknown = [];   // [{text, meal}]
let lastAdded = [];

const dayItems = () => state.days[day] || [];
function setDayItems(items) {
  if (items.length) state.days[day] = items; else delete state.days[day];
  saveState();
}

// ---------------------------------------------------------------- rendering
function renderHeader() {
  const d = fromIso(day);
  const today = isoDay(new Date());
  const label = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  $('#dateBtn').innerHTML = `${esc(label)}<small>${day === today ? 'Today' : 'Tap to go to today'}</small>`;
}

function macroTiles(t, targets) {
  return MACROS.map(([key, label, unit]) => {
    const val = t[key], tgt = targets[key] || 0;
    const fill = tgt ? Math.min(val * 100 / tgt, 100) : 0;
    const over = tgt && val > tgt;
    const sub = !tgt ? '' : over ? `${fmt0(val - tgt)} ${unit} over` : `${fmt0(tgt - val)} ${unit} left`;
    return `<div class="tile"><div class="lbl">${label}</div>
      <div class="val">${fmt0(val)}<span> / ${fmt0(tgt)} ${unit}</span></div>
      <div class="bar"><i style="width:${fill.toFixed(0)}%;background:var(--${key})"></i></div>
      <div class="sub${over ? ' over' : ''}">${sub}</div></div>`;
  }).join('');
}

function splitBar(t) {
  const cal = { protein: t.protein * 4, carbs: t.carbs * 4, fat: t.fat * 9 };
  const sum = cal.protein + cal.carbs + cal.fat;
  if (!sum) return `<div class="split"></div><div class="legend">Log some food to see where your calories come from</div>`;
  const bars = Object.entries(cal).map(([k, v]) => `<i style="width:${(v * 100 / sum).toFixed(1)}%;background:var(--${k})"></i>`).join('');
  const legend = Object.entries(cal).map(([k, v]) => `<span><b style="background:var(--${k})"></b>${k[0].toUpperCase() + k.slice(1)} ${Math.round(v * 100 / sum)}%</span>`).join('');
  return `<div class="split">${bars}</div><div class="legend">${legend}</div>`;
}

function renderToday() {
  const items = dayItems();
  const t = totals(items);
  $('#totals').innerHTML = `<div class="tiles">${macroTiles(t, state.targets)}</div>${splitBar(t)}`;
  const html = MEALS.map(meal => {
    const rows = items.filter(i => i.meal === meal).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (!rows.length) return '';
    const mt = totals(rows);
    return `<div class="meal"><header>${meal}<span>${fmt0(mt.kcal)} kcal · P ${fmt0(mt.protein)} · C ${fmt0(mt.carbs)} · F ${fmt0(mt.fat)}</span></header>
      ${rows.map(i => `<button class="item" data-id="${esc(i.id)}">
        <span class="name"><b>${esc(i.food)}</b><small>${esc(i.amount)} · “${esc(i.typed)}”</small></span>
        <span class="kc"><b>${fmt0(i.kcal)} kcal</b><small>P ${fmt1(i.protein)} · C ${fmt1(i.carbs)} · F ${fmt1(i.fat)}</small></span>
      </button>`).join('')}</div>`;
  }).join('');
  $('#log').innerHTML = html || `<div class="card empty">Nothing logged ${day === isoDay(new Date()) ? 'yet today' : 'for this day'}.<br>Type what you ate above.</div>`;
}

function renderStatus() {
  const st = $('#status');
  if (!lastAdded.length && !pendingUnknown.length) { st.hidden = true; return; }
  st.hidden = false;
  let html = '';
  if (lastAdded.length) html += `Added: ${lastAdded.map(i => `${esc(i.food)} (${esc(i.amount)})`).join(', ')}`;
  if (pendingUnknown.length) {
    html += `<div class="unknown"><span>Didn't recognise:</span>${pendingUnknown.map((u, n) =>
      `<button data-unknown="${n}">${esc(u.text)} — add it</button>`).join('')}
      <button data-unknown="skip" style="border-style:solid;color:var(--muted);border-color:var(--line)">Skip</button></div>`;
  }
  st.innerHTML = html;
}

function renderChips() {
  $('#mealChips').innerHTML = ['Auto', ...MEALS].map(m =>
    `<button class="chip" data-meal="${m}" aria-pressed="${m === mealChoice}">${m === 'Auto' ? 'Auto (by time)' : m}</button>`).join('');
}

// ---- report (in-app view and shareable file share the same markup) ----
const REPORT_CSS = `
.r-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.r-card,.r-sec,.r-panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}
.r-lbl{color:var(--muted);font-size:13px}.r-val{font-size:24px;font-weight:700}.r-val span{font-size:13px;color:var(--muted);font-weight:400}
.r-bar{height:7px;background:var(--line);border-radius:6px;overflow:hidden;margin:7px 0 5px}.r-bar i{display:block;height:100%}
.r-sub{font-size:12px;color:var(--muted)}.r-sub.over{color:#d64545}
.r-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin:10px 0}
.r-panel h3{margin:0 0 10px;font-size:15px}.r-split{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--line)}
.r-legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;font-size:13px}.r-legend b{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px}
.r-top{margin:0;padding-left:18px}.r-top li{padding:2px 0;font-size:14px}.r-top li span{display:flex;justify-content:space-between;gap:8px}.r-top em{color:var(--muted);font-style:normal}
.r-sec{margin-top:10px;overflow-x:auto}.r-sec h2{margin:0 0 6px;font-size:16px;display:flex;justify-content:space-between}.r-sec h2 span{color:var(--muted);font-weight:400;font-size:13px}
.r-sec table{width:100%;min-width:480px;border-collapse:collapse;font-size:13px;table-layout:fixed}
.r-sec th,.r-sec td{text-align:right;padding:6px;border-bottom:1px solid var(--line)}
.r-sec th:first-child{width:38%}.r-sec th:nth-child(2){width:20%}
.r-sec th:first-child,.r-sec td:first-child,.r-sec th:nth-child(2),.r-sec td:nth-child(2){text-align:left}
.r-sec th{color:var(--muted);font-weight:500;font-size:12px}.r-sec tfoot td{font-weight:650;border-bottom:0}
.r-typed{color:var(--muted);font-size:12px}.r-note{color:var(--muted);font-size:12px;margin:16px 0}
.r-head h1{margin:0;font-size:22px}.r-head p{margin:2px 0 12px;color:var(--muted)}`;

function reportMarkup(dayIso, items, targets) {
  const t = totals(items);
  const cal = { protein: t.protein * 4, carbs: t.carbs * 4, fat: t.fat * 9 };
  const sum = cal.protein + cal.carbs + cal.fat || 1;
  const cards = MACROS.map(([key, label, unit]) => {
    const val = t[key], tgt = targets[key] || 0;
    const fill = tgt ? Math.min(val * 100 / tgt, 100) : 0;
    const over = tgt && val > tgt;
    const note = !tgt ? '' : over ? `${fmt0(val - tgt)} ${unit} over target` : `${fmt0(tgt - val)} ${unit} left`;
    return `<div class="r-card"><div class="r-lbl">${label}</div><div class="r-val">${fmt0(val)}<span> / ${fmt0(tgt)} ${unit}</span></div>
      <div class="r-bar"><i style="width:${fill.toFixed(0)}%;background:var(--${key})"></i></div><div class="r-sub${over ? ' over' : ''}">${note}</div></div>`;
  }).join('');
  const split = Object.entries(cal).map(([k, v]) => `<i style="width:${(v * 100 / sum).toFixed(1)}%;background:var(--${k})"></i>`).join('');
  const legend = Object.entries(cal).map(([k, v]) => `<span><b style="background:var(--${k})"></b>${k[0].toUpperCase() + k.slice(1)} ${Math.round(v * 100 / sum)}%</span>`).join('');
  const top = [...items].sort((a, b) => b.kcal - a.kcal).slice(0, 5)
    .map(i => `<li><span><span>${esc(i.food)} <em>(${esc(i.amount)})</em></span><b>${fmt0(i.kcal)} kcal</b></span></li>`).join('');
  const sections = MEALS.map(meal => {
    const rows = items.filter(i => i.meal === meal).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (!rows.length) return '';
    const mt = totals(rows);
    return `<section class="r-sec"><h2>${meal}<span>${fmt0(mt.kcal)} kcal</span></h2><table>
      <thead><tr><th>Food</th><th>Amount</th><th>kcal</th><th>Protein g</th><th>Carbs g</th><th>Fat g</th></tr></thead><tbody>
      ${rows.map(i => `<tr><td>${esc(i.food)}<div class="r-typed">“${esc(i.typed)}”</div></td><td>${esc(i.amount)}</td>
        <td>${fmt0(i.kcal)}</td><td>${fmt1(i.protein)}</td><td>${fmt1(i.carbs)}</td><td>${fmt1(i.fat)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>Subtotal</td><td></td><td>${fmt0(mt.kcal)}</td><td>${fmt1(mt.protein)}</td><td>${fmt1(mt.carbs)}</td><td>${fmt1(mt.fat)}</td></tr></tfoot></table></section>`;
  }).join('');
  const dateLabel = fromIso(dayIso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `<div class="r-head"><h1>Daily macro report</h1><p>${esc(dateLabel)} · ${items.length} item(s) logged</p></div>
    <div class="r-grid">${cards}</div>
    <div class="r-two"><div class="r-panel"><h3>Where calories came from</h3><div class="r-split">${split}</div><div class="r-legend">${legend}</div></div>
    <div class="r-panel"><h3>Biggest calorie sources</h3>${top ? `<ol class="r-top">${top}</ol>` : '<span class="r-sub">Nothing logged.</span>'}</div></div>
    ${sections}
    <p class="r-note">Values are estimates from Macro Tracker's food table (typical Indian home-style recipes); brands and recipes vary.</p>`;
}

function standaloneReport(dayIso, items, targets) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Macro report ${dayIso}</title><style>
:root{--bg:#f5f6fa;--card:#fff;--text:#1d2433;--muted:#6b7385;--line:#e6e8ef;--kcal:#4f6bed;--protein:#e4572e;--carbs:#f0a202;--fat:#22a39f}
@media (prefers-color-scheme:dark){:root{--bg:#14171f;--card:#1d212c;--text:#e8eaf0;--muted:#9aa2b4;--line:#2c3140}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:24px 16px 40px}${REPORT_CSS}
@media print{body{background:#fff}.r-card,.r-sec,.r-panel{break-inside:avoid}}
</style></head><body><main>${reportMarkup(dayIso, items, targets)}</main></body></html>`;
}

function renderReport() {
  $('#report').innerHTML = reportMarkup(day, dayItems(), state.targets);
}

function renderFoods() {
  const q = $('#foodSearch').value.trim().toLowerCase();
  const names = [...db.foods.keys()].sort((a, b) => a.localeCompare(b));
  const rows = names.map(n => db.foods.get(n)).filter(f => !q || (f.name + ' ' + f.aliases.join(' ')).toLowerCase().includes(q));
  $('#foodList').innerHTML = rows.length ? rows.map(f => {
    const custom = db.customNames.has(f.name);
    const units = Object.entries(f.units).filter(([u]) => u !== 'serving' || Object.keys(f.units).length === 1)
      .map(([u, g]) => `${u} ${fmtNum(g)}${f.liquid ? 'ml' : 'g'}`).join(', ');
    return `<div class="food"><div><b>${esc(f.name)}</b>${custom ? '<span class="tag">custom</span>' : ''}
      <small>${fmtNum(f.kcal)} kcal · P ${fmtNum(f.protein)} · C ${fmtNum(f.carbs)} · F ${fmtNum(f.fat)}${units ? ' · ' + esc(units) : ''}</small>
      ${f.aliases.length ? `<small>${esc(f.aliases.join(', '))}</small>` : ''}</div>
      ${custom ? `<button class="del" data-del="${esc(f.name)}">Delete</button>` : ''}</div>`;
  }).join('') : `<div class="empty">No food matches “${esc(q)}”.</div>`;
}

function renderSettings() {
  $('#targetFields').innerHTML = MACROS.map(([key, label, unit]) =>
    `<div><label for="t-${key}">${label} (${unit})</label><input type="number" inputmode="decimal" id="t-${key}" value="${fmtNum(state.targets[key])}"></div>`).join('');
}

function render() {
  renderHeader();
  for (const v of ['today', 'report', 'foods', 'settings']) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
  $('.top').style.visibility = view === 'today' || view === 'report' ? 'visible' : 'hidden';
  if (view === 'today') { renderChips(); renderStatus(); renderToday(); }
  if (view === 'report') renderReport();
  if (view === 'foods') renderFoods();
  if (view === 'settings') renderSettings();
}

// ---------------------------------------------------------------- actions
function addFood() {
  const input = $('#foodInput');
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const meal = mealChoice === 'Auto' ? mealForTime(new Date()) : mealChoice;
  const [items, unknown] = db.parse(text);
  appendItems(items, meal);
  lastAdded = items;
  pendingUnknown = unknown.map(u => ({ text: u, meal }));
  input.value = '';
  if (items.length) toast(`Added ${items.length} item(s) to ${meal}`);
  render();
}

function appendItems(items, meal) {
  if (!items.length) return;
  const now = new Date();
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  for (const i of items) Object.assign(i, { meal, time });
  setDayItems([...dayItems(), ...items]);
}

function openSheet(html, onReady) {
  const dlg = $('#sheet');
  $('#sheetBody').innerHTML = html;
  if (!dlg.open) dlg.showModal();
  onReady && onReady($('#sheetBody'));
}
const closeSheet = () => $('#sheet').open && $('#sheet').close();

function editItem(id) {
  const item = dayItems().find(i => i.id === id);
  if (!item) return;
  const names = [...db.foods.keys()].sort((a, b) => a.localeCompare(b));
  if (!db.foods.has(item.food)) names.unshift(item.food);
  openSheet(`<h3>Edit item</h3><p class="small muted" style="margin:0">You wrote: “${esc(item.typed)}”</p>
    <label for="e-food">Food</label><select id="e-food">${names.map(n => `<option${n === item.food ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
    <div class="grid2"><div><label for="e-grams">Amount (g / ml)</label><input id="e-grams" type="number" inputmode="decimal" value="${fmtNum(item.grams)}"></div>
    <div><label for="e-meal">Meal</label><select id="e-meal">${MEALS.map(m => `<option${m === item.meal ? ' selected' : ''}>${m}</option>`).join('')}</select></div></div>
    <div class="btns"><button class="btn danger" id="e-del">Delete</button><button class="btn" id="e-cancel">Cancel</button><button class="primary" id="e-save">Save</button></div>`,
  el => {
    $('#e-cancel', el).onclick = closeSheet;
    $('#e-del', el).onclick = () => {
      if (!confirm(`Remove ${item.food} from this day?`)) return;
      setDayItems(dayItems().filter(i => i.id !== id));
      closeSheet(); render(); toast('Item removed');
    };
    $('#e-save', el).onclick = () => {
      const grams = parseFloat($('#e-grams', el).value);
      const food = db.foods.get($('#e-food', el).value);
      if (!food) { toast('That food is no longer in the list'); return; }
      if (!(grams >= 0)) { toast('Amount must be a number'); return; }
      const next = makeItem(food, grams, `${fmtNum(grams)} ${food.liquid ? 'ml' : 'g'}`, item.typed, item.id);
      Object.assign(next, { meal: $('#e-meal', el).value, time: item.time });
      setDayItems(dayItems().map(i => (i.id === id ? next : i)));
      closeSheet(); render();
    };
  });
}

function customFoodSheet(prefill, onSaved) {
  const title = prefill ? prefill.replace(/\b\w/g, c => c.toUpperCase()) : '';
  openSheet(`<h3>Add custom food</h3><p class="small muted" style="margin:0">Use the nutrition label, or a search like “pasta calories per 100g”.</p>
    <label for="c-name">Name</label><input id="c-name" type="text" value="${esc(title)}">
    <label for="c-aliases">Other names (comma separated)</label><input id="c-aliases" type="text" placeholder="e.g. white sauce pasta, penne" autocapitalize="none">
    <label>Values are</label><div class="radio">
      <button class="chip" data-basis="100" aria-pressed="true">per 100 g / ml</button>
      <button class="chip" data-basis="piece" aria-pressed="false">per piece / serving</button></div>
    <div class="grid2">
      <div><label for="c-kcal">Calories (kcal)</label><input id="c-kcal" type="number" inputmode="decimal"></div>
      <div><label for="c-protein">Protein (g)</label><input id="c-protein" type="number" inputmode="decimal"></div>
      <div><label for="c-carbs">Carbs (g)</label><input id="c-carbs" type="number" inputmode="decimal"></div>
      <div><label for="c-fat">Fat (g)</label><input id="c-fat" type="number" inputmode="decimal"></div></div>
    <label for="c-piece">Weight of 1 piece / serving in g (needed for “per piece”)</label><input id="c-piece" type="number" inputmode="decimal">
    <label class="check"><input type="checkbox" id="c-liquid"> It's a drink / measured in ml</label>
    <div class="btns"><button class="btn" id="c-cancel">Cancel</button><button class="primary" id="c-save">Save food</button></div>`,
  el => {
    let basis = '100';
    el.querySelectorAll('[data-basis]').forEach(b => b.onclick = () => {
      basis = b.dataset.basis;
      el.querySelectorAll('[data-basis]').forEach(x => x.setAttribute('aria-pressed', x === b));
    });
    $('#c-cancel', el).onclick = closeSheet;
    $('#c-save', el).onclick = () => {
      const name = $('#c-name', el).value.trim();
      if (!name) { toast('Give the food a name'); return; }
      const nums = {};
      for (const k of ['kcal', 'protein', 'carbs', 'fat']) {
        const v = $('#c-' + k, el).value.trim();
        nums[k] = v === '' ? 0 : parseFloat(v);
        if (!(nums[k] >= 0)) { toast('Calories and macros must be numbers'); return; }
      }
      const piece = parseFloat($('#c-piece', el).value) || null;
      if (basis === 'piece') {
        if (!piece) { toast('Enter the weight of one piece/serving'); return; }
        for (const k in nums) nums[k] = nums[k] * 100 / piece;
      }
      const food = F(name, r2(nums.kcal), r2(nums.protein), r2(nums.carbs), r2(nums.fat),
        $('#c-aliases', el).value, piece ? { piece, serving: piece } : {}, piece ? 'piece' : 'serving', $('#c-liquid', el).checked);
      state.custom = state.custom.filter(c => c.name !== food.name).concat(food);
      saveState();
      db.reload(state.custom);
      closeSheet();
      toast(`Saved ${food.name}`);
      onSaved && onSaved(food);
      render();
    };
  });
}

function resolveUnknown(n) {
  const u = pendingUnknown[n];
  if (!u) return;
  customFoodSheet(tokenize(u.text).join(' '), () => {
    pendingUnknown.splice(n, 1);
    const [items, still] = db.parse(u.text);
    appendItems(items, u.meal);
    lastAdded = items;
    pendingUnknown.push(...still.map(t => ({ text: t, meal: u.meal })));
  });
}

function exportCsv() {
  const items = dayItems();
  const order = Object.fromEntries(MEALS.map((m, n) => [m, n]));
  const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const lines = [['date', 'time', 'meal', 'food', 'you_wrote', 'amount', 'grams_or_ml', 'kcal', 'protein_g', 'carbs_g', 'fat_g']];
  for (const i of [...items].sort((a, b) => (order[a.meal] - order[b.meal]) || (a.time || '').localeCompare(b.time || '')))
    lines.push([day, i.time || '', i.meal || '', i.food, i.typed, i.amount, i.grams, Math.round(i.kcal), fmt1(i.protein), fmt1(i.carbs), fmt1(i.fat)]);
  const t = totals(items);
  lines.push([day, '', 'TOTAL', '', '', '', '', Math.round(t.kcal), fmt1(t.protein), fmt1(t.carbs), fmt1(t.fat)]);
  shareOrDownload(`Macros ${day}.csv`, '﻿' + lines.map(l => l.map(q).join(',')).join('\r\n'), 'text/csv');
}

function exportBackup() {
  const data = { app: 'macro-tracker', version: 1, exported: new Date().toISOString(), ...state };
  shareOrDownload(`macro-tracker-backup-${isoDay(new Date())}.json`, JSON.stringify(data, null, 1), 'application/json');
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('That file is not a valid backup'); return; }
  if (!data || typeof data.days !== 'object') { toast('That file is not a Macro Tracker backup'); return; }
  const dayCount = Object.keys(data.days).length;
  if (!confirm(`Merge ${dayCount} day(s) and ${(data.custom || []).length} custom food(s) from this backup into this device? Nothing here will be deleted.`)) return;
  for (const [d, items] of Object.entries(data.days)) {
    if (!Array.isArray(items)) continue;
    const have = new Map((state.days[d] || []).map(i => [i.id, i]));
    for (const i of items) if (i && i.id && !have.has(i.id)) have.set(i.id, i);
    if (have.size) state.days[d] = [...have.values()];
  }
  for (const c of data.custom || []) if (c && c.name && !state.custom.some(x => x.name === c.name)) state.custom.push(c);
  if (data.targets) state.targets = { ...state.targets, ...data.targets };
  saveState();
  db.reload(state.custom);
  render();
  toast('Backup imported');
}

// ---------------------------------------------------------------- events
function shiftDay(n) {
  const d = fromIso(day);
  d.setDate(d.getDate() + n);
  day = isoDay(d);
  lastAdded = []; pendingUnknown = [];
  render();
}

$('#prevDay').onclick = () => shiftDay(-1);
$('#nextDay').onclick = () => shiftDay(1);
$('#dateBtn').onclick = () => { day = isoDay(new Date()); render(); };
$('#addBtn').onclick = addFood;
$('#foodInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); addFood(); }
});
$('#mealChips').onclick = e => {
  const b = e.target.closest('[data-meal]');
  if (b) { mealChoice = b.dataset.meal; renderChips(); }
};
$('#status').onclick = e => {
  const b = e.target.closest('[data-unknown]');
  if (!b) return;
  if (b.dataset.unknown === 'skip') { pendingUnknown = []; renderStatus(); return; }
  resolveUnknown(Number(b.dataset.unknown));
};
$('#log').onclick = e => {
  const b = e.target.closest('[data-id]');
  if (b) editItem(b.dataset.id);
};
$('#shareReport').onclick = () => shareOrDownload(`Macro report ${day}.html`, standaloneReport(day, dayItems(), state.targets), 'text/html');
$('#shareCsv').onclick = exportCsv;
$('#printReport').onclick = () => window.print();
$('#foodSearch').oninput = renderFoods;
$('#addCustom').onclick = () => customFoodSheet($('#foodSearch').value.trim());
$('#foodList').onclick = e => {
  const b = e.target.closest('[data-del]');
  if (!b || !confirm(`Delete custom food “${b.dataset.del}”? Items already logged keep their numbers.`)) return;
  state.custom = state.custom.filter(c => c.name !== b.dataset.del);
  saveState(); db.reload(state.custom); renderFoods();
};
$('#autoTargets').onclick = () => {
  const k = parseFloat($('#t-kcal').value);
  if (!(k > 0)) return;
  $('#t-protein').value = Math.round(k * 0.25 / 4);
  $('#t-carbs').value = Math.round(k * 0.50 / 4);
  $('#t-fat').value = Math.round(k * 0.25 / 9);
};
$('#saveTargets').onclick = () => {
  const next = {};
  for (const [key] of MACROS) {
    const v = parseFloat($('#t-' + key).value);
    if (!(v >= 0)) { toast('Targets must be numbers'); return; }
    next[key] = v;
  }
  state.targets = next; saveState(); toast('Targets saved');
};
$('#exportBackup').onclick = exportBackup;
$('#importBackup').onclick = () => $('#importFile').click();
$('#importFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };
$('#sheet').addEventListener('click', e => { if (e.target === $('#sheet')) closeSheet(); });
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { view = b.dataset.view; render(); window.scrollTo(0, 0); });

// A new day while the app sat open in the background: jump to today when it comes back.
let lastSeenToday = isoDay(new Date());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = isoDay(new Date());
  if (now !== lastSeenToday) { if (day === lastSeenToday) day = now; lastSeenToday = now; render(); }
});

const styleEl = document.createElement('style');
styleEl.textContent = REPORT_CSS;
document.head.appendChild(styleEl);
render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
