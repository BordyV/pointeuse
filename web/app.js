import {
  T, LABELS, mergeSettings, uid, dayKey, sortEvents, currentState, allowedActions,
  summarizeDays, computeBalance, todayForecast, fmtDur, fmtTime, fmtDay, balanceText,
  toCSV, geoTick, fmtSlots, planMinutes,
} from '../shared/core.js';
import { readPlanningPhoto, toPlanning, guessMonday } from '../shared/planning.js';

const $ = (s) => document.querySelector(s);
const KEY = 'pointeuse.v1';
const API_KEY = 'pointeuse.apiKey'; // à part, pour ne pas finir dans les sauvegardes
const DAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

// ---------- Stockage ----------

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { events: raw.events || [], settings: mergeSettings(raw.settings), geoState: raw.geoState || {}, planning: raw.planning || {} };
  } catch {
    return { events: [], settings: mergeSettings(), geoState: {}, planning: {} };
  }
}
let db = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { toast('Sauvegarde impossible (stockage bloqué)'); }
  render();
}

// ---------- Actions ----------

function punch(type, source = 'manual', ts = Date.now()) {
  db.events.push({ id: uid(), type, ts, source });
  save();
  toast(`${LABELS[type]} à ${fmtTime(ts)}`);
}

const minutesToHM = (m) => `${Math.floor(Math.abs(m) / 60)}:${String(Math.round(Math.abs(m) % 60)).padStart(2, '0')}`;
function parseHM(str) {
  const s = String(str).trim().replace(',', '.');
  if (!s) return 0;
  const neg = s.startsWith('-');
  const [h, m] = s.replace(/^[-+]/, '').split(/[:h]/);
  const v = m !== undefined ? Number(h) * 60 + Number(m || 0) : Number(h) * 60;
  return Number.isFinite(v) ? (neg ? -v : v) : NaN;
}

// ---------- Rendu ----------

// Pointage en cours de modification : tant qu'il est ouvert, on ne redessine pas
// les listes (sinon le rafraîchissement du chrono, chaque seconde, ferme le champ).
let editingId = null;

function render(force = false) {
  const now = Date.now();
  const { events, settings } = db;
  const state = currentState(events);
  const days = summarizeDays(events, settings, now, db.planning);
  const fc = todayForecast(days, settings, events, now, db.planning);

  // Statut + chrono
  const stateEl = $('#state-label');
  stateEl.className = 'state ' + state;
  stateEl.textContent = { off: 'Hors service', working: 'Au travail', paused: 'En pause' }[state];
  $('#timer').textContent = fmtDur(fc.worked);
  let f = '';
  if (fc.expected > 0) {
    f = fc.remaining > 0
      ? `Reste ${fmtDur(fc.remaining)} sur ${fmtDur(fc.expected)}`
      : `Objectif atteint · <span class="pos">${fmtDur(-fc.remaining, true)}</span>`;
    if (fc.endAt) f += ` · sortie prévue à <strong>${fmtTime(fc.endAt)}</strong>`;
  } else if (fc.worked > 0) f = 'Jour non travaillé : tout compte en heures sup';
  if (fc.pause > 0) f += `<br><span class="muted">Pause : ${fmtDur(fc.pause)}</span>`;
  $('#forecast').innerHTML = f;
  $('#today-plan').textContent = fc.plan ? `Prévu : ${fmtSlots(fc.plan)}` : '';

  // Boutons (on ne recrée que si l'état change, pour ne pas perdre le clic)
  const acts = $('#actions');
  if (acts.dataset.state !== state) {
    acts.dataset.state = state;
    acts.innerHTML = allowedActions(state)
      .map((t) => `<button class="btn ${t}" data-punch="${t}">${LABELS[t]}</button>`).join('');
  }

  // Solde
  const bal = computeBalance(days, settings);
  $('#balance').textContent = fmtDur(bal, true);
  $('#balance').className = 'balance-value ' + (bal >= 0 ? 'pos' : 'neg');
  $('#balance-text').textContent = balanceText(bal);

  // Pointages du jour
  if (!editingId || force) {
    const todayEv = sortEvents(events).filter((e) => dayKey(e.ts) === dayKey(now));
    $('#today-events').innerHTML = todayEv.length
      ? todayEv.map(eventRow).join('')
      : '<li class="muted">Aucun pointage aujourd’hui.</li>';
    renderHistory(days);
  }
  renderPlanning();
  renderGeoBadge();
}

function eventRow(e) {
  if (e.id === editingId) {
    return `<li data-id="${e.id}" class="editing">
    <input type="time" class="edit-time" value="${fmtTime(e.ts)}" />
    <span class="l">${LABELS[e.type]}</span>
    <button class="icon-btn ok" data-save="${e.id}" title="Enregistrer">✓</button>
    <button class="icon-btn" data-cancel="1" title="Annuler">✕</button>
  </li>`;
  }
  const src = e.source === 'geo' ? '📍 auto' : e.source === 'edit' ? '✏️ modifié' : '';
  return `<li data-id="${e.id}">
    <span class="t">${fmtTime(e.ts)}</span>
    <span class="l">${LABELS[e.type]} <span class="src">${src}</span></span>
    <button class="icon-btn" data-edit="${e.id}" title="Modifier l’heure">✏️</button>
    <button class="icon-btn" data-del="${e.id}" title="Supprimer">🗑️</button>
  </li>`;
}

function renderHistory(days) {
  // Résumé de la semaine en cours (lundi → aujourd'hui)
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const mondayKey = dayKey(monday);
  const week = days.filter((d) => d.day >= mondayKey);
  const wWorked = week.reduce((s, d) => s + d.worked, 0);
  const wExpected = db.settings.schedule.slice(1).concat(db.settings.schedule[0]).reduce((a, b) => a + b, 0);
  const wDiff = week.filter((d) => !d.live).reduce((s, d) => s + d.diff, 0);
  $('#week-summary').innerHTML = `
    <div><div class="muted small">Semaine</div><div class="v">${fmtDur(wWorked)}</div></div>
    <div><div class="muted small">Contrat</div><div class="v">${fmtDur(wExpected)}</div></div>
    <div><div class="muted small">Écart</div><div class="v ${wDiff >= 0 ? 'pos' : 'neg'}">${fmtDur(wDiff, true)}</div></div>`;

  $('#history').innerHTML = days.length ? days.map((d) => `
    <div class="card">
      <div class="day-head">
        <span class="name">${fmtDay(d.day)}</span>
        <span class="${d.diff >= 0 ? 'pos' : 'neg'}">${d.live ? 'en cours' : d.missing ? '—' : fmtDur(d.diff, true)}</span>
      </div>
      <div class="day-stats">Travaillé ${fmtDur(d.worked)} · Pause ${fmtDur(d.pause)} · Prévu ${fmtDur(d.expected)}${d.plan ? ` (${fmtSlots(d.plan)})` : ''}</div>
      ${d.warnings.map((w) => `<div class="warn">⚠️ ${w}</div>`).join('')}
      <ul class="events">${sortEvents(d.events).map(eventRow).join('')}</ul>
    </div>`).join('') : '<p class="muted">Pas encore d’historique.</p>';
}

function renderSettings() {
  const s = db.settings;
  $('#schedule').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((i) =>
    `<label>${DAYS[i]}<input data-day="${i}" value="${minutesToHM(s.schedule[i])}" inputmode="decimal" /></label>`).join('');
  $('#week-total').textContent = fmtDur(s.schedule.reduce((a, b) => a + b, 0));
  $('#offset').value = (s.balanceOffset < 0 ? '-' : '') + minutesToHM(s.balanceOffset);
  $('#person').value = s.person;
  try { $('#api-key').value = localStorage.getItem(API_KEY) || ''; } catch {}
  $('#geo-enabled').checked = s.geo.enabled;
  $('#geo-radius').value = s.geo.radius;
  $('#geo-delay').value = s.geo.delayMin;
  $('#geo-place').textContent = s.geo.lat != null
    ? `Lieu : ${s.geo.lat.toFixed(5)}, ${s.geo.lng.toFixed(5)}`
    : 'Aucun lieu de travail défini.';
}

function renderGeoBadge() {
  const b = $('#geo-badge');
  const g = db.settings.geo;
  b.hidden = !g.enabled;
  if (!g.enabled) return;
  if (lastGeo?.inside) {
    const left = Math.max(0, g.delayMin - (lastGeo.elapsed || 0));
    b.textContent = currentState(db.events) === 'off' && left > 0
      ? `📍 Sur site · pointage dans ${Math.ceil(left * 60)} s`
      : '📍 Sur site';
    b.className = 'badge on';
  } else {
    b.textContent = lastGeo ? `📍 À ${Math.round(lastGeo.distance)} m` : '📍 En attente GPS';
    b.className = 'badge';
  }
}

// ---------- Géolocalisation ----------

let watchId = null;
let simTimer = null;
let lastGeo = null;

function onPosition(pos) {
  const r = geoTick(db.geoState, pos, db.settings, db.events, Date.now(), db.planning);
  db.geoState = r.state;
  // On garde la position pour relancer le calcul du délai sans nouveau fix GPS.
  lastGeo = { ...r, pos };
  $('#geo-debug').textContent = r.distance != null
    ? `distance ${Math.round(r.distance)} m · précision ${Math.round(pos.accuracy || 0)} m · ${r.inside ? 'dedans' : 'dehors'}`
    : '';
  if (r.punch) {
    punch(T.IN, 'geo');
    notify('Arrivée pointée automatiquement', `Bonne journée ! Pointé à ${fmtTime(Date.now())}.`);
  } else {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {}
    renderGeoBadge();
  }
}

function startGeo() {
  stopGeo();
  const g = db.settings.geo;
  if (!g.enabled || g.lat == null) return;
  if ($('#geo-sim').checked) {
    const tick = () => onPosition({ lat: g.lat, lng: g.lng, accuracy: 10 });
    tick();
    simTimer = setInterval(tick, 3000);
    return;
  }
  if (!('geolocation' in navigator)) return toast('Géolocalisation non disponible');
  watchId = navigator.geolocation.watchPosition(
    (p) => onPosition({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
    (err) => toast('GPS : ' + err.message),
    { enableHighAccuracy: true, maximumAge: 30000 },
  );
  // watchPosition ne rappelle que si on bouge : on relance le calcul du délai régulièrement.
  simTimer = setInterval(() => {
    if (lastGeo?.inside && lastGeo.pos) onPosition(lastGeo.pos);
  }, 15000);
}
function stopGeo() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  clearInterval(simTimer);
  watchId = simTimer = null;
}

function notify(title, body) {
  toast(title);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // Sur téléphone, seules les notifications passées par le service worker s'affichent.
  const opts = { body, icon: 'icon-192.png', badge: 'icon-192.png' };
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts)).catch(() => {});
  } else {
    try { new Notification(title, opts); } catch {}
  }
}

// ---------- Événements UI ----------

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('button, [data-tab]');
  if (!t) return;
  if (t.dataset.punch) return punch(t.dataset.punch);
  if (t.dataset.tab) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === t));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + t.dataset.tab));
    if (t.dataset.tab === 'settings') renderSettings();
    return;
  }
  if (t.dataset.del) {
    const e = db.events.find((x) => x.id === t.dataset.del);
    if (e && confirm(`Supprimer « ${LABELS[e.type]} » de ${fmtTime(e.ts)} ?`)) {
      db.events = db.events.filter((x) => x.id !== e.id);
      editingId = null;
      save();
    }
    return;
  }
  if (t.dataset.edit) {
    editingId = t.dataset.edit;
    render(true);
    t.closest('section').querySelector(`li[data-id="${editingId}"] .edit-time`)?.focus();
    return;
  }
  if (t.dataset.save) return saveEdit(t.closest('li'));
  if (t.dataset.cancel) {
    editingId = null;
    render(true);
  }
});

function saveEdit(li) {
  const e = db.events.find((x) => x.id === li.dataset.id);
  const [h, m] = li.querySelector('.edit-time').value.split(':').map(Number);
  editingId = null;
  if (e && Number.isFinite(h) && Number.isFinite(m)) {
    const d = new Date(e.ts);
    d.setHours(h, m, 0, 0);
    if (d.getTime() !== e.ts) {
      e.ts = d.getTime();
      e.source = 'edit';
      toast(`${LABELS[e.type]} corrigé à ${fmtTime(e.ts)}`);
    }
  }
  save();
}

// Entrée valide, Échap annule.
document.addEventListener('keydown', (ev) => {
  if (!ev.target.classList?.contains('edit-time')) return;
  if (ev.key === 'Enter') saveEdit(ev.target.closest('li'));
  if (ev.key === 'Escape') { editingId = null; render(true); }
});

$('#add-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const ts = new Date(`${f.get('date')}T${f.get('time')}`).getTime();
  db.events.push({ id: uid(), type: f.get('type'), ts, source: 'edit' });
  save();
  toast('Pointage ajouté');
});

$('#schedule').addEventListener('change', (ev) => {
  const v = parseHM(ev.target.value);
  if (Number.isNaN(v) || v < 0) return toast('Format attendu : 7:00 ou 7.5');
  db.settings.schedule[Number(ev.target.dataset.day)] = Math.round(v);
  save();
  renderSettings();
});

$('#offset-save').addEventListener('click', () => {
  const v = parseHM($('#offset').value);
  if (Number.isNaN(v)) return toast('Format attendu : -3:30');
  db.settings.balanceOffset = Math.round(v);
  save();
  renderSettings();
  toast('Ajustement enregistré');
});

$('#geo-enabled').addEventListener('change', async (ev) => {
  db.settings.geo.enabled = ev.target.checked;
  if (ev.target.checked && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  save();
  startGeo();
});
$('#geo-radius').addEventListener('change', (ev) => { db.settings.geo.radius = Number(ev.target.value) || 150; save(); });
$('#geo-delay').addEventListener('change', (ev) => { db.settings.geo.delayMin = Math.max(0, Number(ev.target.value)); save(); });
$('#geo-sim').addEventListener('change', startGeo);

$('#geo-set').addEventListener('click', () => {
  if (!('geolocation' in navigator)) return toast('Géolocalisation non disponible');
  toast('Recherche de ta position…');
  navigator.geolocation.getCurrentPosition(
    (p) => {
      Object.assign(db.settings.geo, { lat: p.coords.latitude, lng: p.coords.longitude });
      save();
      renderSettings();
      startGeo();
      toast(`Lieu enregistré (précision ${Math.round(p.coords.accuracy)} m)`);
    },
    (err) => toast('GPS : ' + err.message),
    { enableHighAccuracy: true, timeout: 20000 },
  );
});

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#export-csv').addEventListener('click', () =>
  download(`pointeuse-${dayKey(Date.now())}.csv`, '﻿' + toCSV(summarizeDays(db.events, db.settings, Date.now(), db.planning)), 'text/csv'));
$('#export-json').addEventListener('click', () =>
  download(`pointeuse-sauvegarde-${dayKey(Date.now())}.json`, JSON.stringify(db, null, 2), 'application/json'));
$('#import-json').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    if (!Array.isArray(raw.events)) throw new Error();
    db = { events: raw.events, settings: mergeSettings(raw.settings), geoState: raw.geoState || {}, planning: raw.planning || {} };
    save();
    renderSettings();
    toast(`${db.events.length} pointages restaurés`);
  } catch {
    toast('Fichier de sauvegarde invalide');
  }
});
$('#reset').addEventListener('click', () => {
  if (!confirm('Effacer tous les pointages et réglages ?')) return;
  db = { events: [], settings: mergeSettings(), geoState: {}, planning: {} };
  save();
  renderSettings();
});
$('#demo').addEventListener('click', () => {
  if (db.events.length && !confirm('Ajouter des données de démo aux pointages existants ?')) return;
  const at = (daysAgo, h, m) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.getTime(); };
  const plan = [[1, 8, 52, 12, 5, 12, 50, 17, 41], [2, 9, 10, 12, 30, 13, 0, 16, 45], [3, 8, 30, 12, 0, 12, 15, 18, 20], [4, 8, 45, 12, 10, 13, 5, 17, 0]];
  for (const [d, a, b, c, e, f, g, h, i] of plan) {
    if (new Date(at(d, 12, 0)).getDay() % 6 === 0) continue; // pas le week-end
    db.events.push(
      { id: uid(), type: T.IN, ts: at(d, a, b), source: 'manual' },
      { id: uid(), type: T.PAUSE, ts: at(d, c, e), source: 'manual' },
      { id: uid(), type: T.RESUME, ts: at(d, f, g), source: 'manual' },
      { id: uid(), type: T.OUT, ts: at(d, h, i), source: 'manual' },
    );
  }
  save();
  toast('Données de démo ajoutées');
});

// ---------- Planning ----------

const mondayOf = (key) => {
  const d = new Date(key + 'T12:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dayKey(d);
};
const addDays = (key, n) => {
  const d = new Date(key + 'T12:00');
  d.setDate(d.getDate() + n);
  return dayKey(d);
};
const weekLabel = (monday) =>
  `Semaine du ${new Date(monday + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;

function planRows(entries, monday, today) {
  let html = '';
  for (let i = 0; i < 7; i++) {
    const key = addDays(monday, i);
    const p = entries[key];
    if (!p && i === 6) continue; // dimanche non planifié : on n'encombre pas
    const label = new Date(key + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric' });
    const txt = p ? fmtSlots(p) : '—';
    const off = !p || p.status !== 'work';
    html += `<div class="plan-row ${key === today ? 'today' : ''}"><span class="d">${label}</span>
      <span class="h ${off ? 'off' : ''}">${txt}${p?.status === 'work' ? ` <span class="muted">(${fmtDur(planMinutes(p))})</span>` : ''}</span></div>`;
  }
  return html;
}

function renderPlanning() {
  const today = dayKey(Date.now());
  const thisMonday = mondayOf(today);
  const mondays = [...new Set(Object.keys(db.planning).filter((k) => k >= thisMonday).map(mondayOf))].sort();
  const html = mondays.map((m) => {
    const total = [0, 1, 2, 3, 4, 5, 6].reduce((s, i) => s + planMinutes(db.planning[addDays(m, i)]), 0);
    return `<div class="card"><div class="day-head"><h2>${weekLabel(m)}</h2><span class="muted">${fmtDur(total)}</span></div>
      ${planRows(db.planning, m, today)}</div>`;
  }).join('');
  const el = $('#plan-weeks');
  const next = html || '<p class="muted">Aucun planning à venir. Prends en photo le planning affiché au magasin.</p>';
  if (el.innerHTML !== next) el.innerHTML = next;
  if (!$('#plan-hint').dataset.busy) {
    $('#plan-hint').textContent = db.settings.person ? `Je cherche la ligne « ${db.settings.person} ».` : 'Indique d’abord ton nom dans Réglages.';
  }
}

// Réduit la photo (un smartphone fait 4000 px et plusieurs Mo) avant l'envoi.
async function photoToJpeg(file, maxSide = 2400) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.88);
  return { base64: url.split(',')[1], mediaType: 'image/jpeg' };
}

let pendingPlan = null;

function showPreview() {
  const { result, monday } = pendingPlan;
  const { entries, total, warnings } = toPlanning(result, monday);
  pendingPlan.entries = entries;
  const overwrite = Object.keys(entries).some((k) => db.planning[k]);
  $('#plan-preview').hidden = false;
  $('#plan-preview').innerHTML = `
    <h2>Vérifie avant d’enregistrer</h2>
    <label>Lundi de cette semaine<input id="plan-monday" type="date" value="${monday}" /></label>
    <div style="margin-top:10px">${planRows(entries, monday, null)}</div>
    <div class="plan-row"><strong>Total travaillé</strong><strong>${fmtDur(total)}</strong></div>
    ${warnings.map((w) => `<div class="warn">⚠️ ${w}</div>`).join('')}
    ${overwrite ? '<div class="warn">Cette semaine avait déjà un planning : il sera remplacé.</div>' : ''}
    <div class="row" style="margin-top:12px">
      <button id="plan-cancel" class="btn small ghost" style="flex:1">Annuler</button>
      <button id="plan-save" class="btn small" style="flex:2">Enregistrer</button>
    </div>`;
  $('#plan-monday').addEventListener('change', (ev) => {
    if (!ev.target.value) return;
    pendingPlan.monday = mondayOf(ev.target.value);
    showPreview();
  });
  $('#plan-cancel').addEventListener('click', () => { pendingPlan = null; $('#plan-preview').hidden = true; });
  $('#plan-save').addEventListener('click', () => {
    Object.assign(db.planning, pendingPlan.entries);
    pendingPlan = null;
    $('#plan-preview').hidden = true;
    save();
    toast('Planning enregistré');
  });
}

$('#plan-photo').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  let apiKey = '';
  try { apiKey = localStorage.getItem(API_KEY) || ''; } catch {}
  if (!db.settings.person || !apiKey) {
    toast('Renseigne ton nom et ta clé API dans Réglages');
    return document.querySelector('[data-tab="settings"]').click();
  }
  const hint = $('#plan-hint');
  hint.dataset.busy = '1';
  hint.innerHTML = '<span class="spinner"></span>Claude lit ton planning… (30 s à 1 min)';
  $('#plan-preview').hidden = true;
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.1.0/+esm'));
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const result = await readPlanningPhoto(client, await photoToJpeg(file), db.settings.person);
    pendingPlan = { result, monday: guessMonday(result.week_number) };
    showPreview();
    hint.textContent = '';
  } catch (err) {
    let msg = err.message;
    if (Anthropic && err instanceof Anthropic.AuthenticationError) msg = 'Clé API refusée. Vérifie-la dans Réglages.';
    else if (Anthropic && err instanceof Anthropic.RateLimitError) msg = 'Trop de demandes, réessaie dans une minute.';
    else if (Anthropic && err instanceof Anthropic.APIConnectionError) msg = 'Pas de connexion internet.';
    else if (!Anthropic) msg = 'Impossible de charger le module Claude (connexion ?).';
    hint.textContent = '❌ ' + msg;
  } finally {
    delete hint.dataset.busy;
  }
});

$('#person').addEventListener('change', (ev) => {
  db.settings.person = ev.target.value.trim();
  save();
});
$('#api-key').addEventListener('change', (ev) => {
  try { localStorage.setItem(API_KEY, ev.target.value.trim()); toast('Clé enregistrée'); } catch { toast('Stockage bloqué'); }
});

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2500);
}

// ---------- Démarrage ----------

render();
startGeo();
setInterval(render, 1000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && render());

// Aide à l'installation sur l'écran d'accueil (pas besoin de store).
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
let tipClosed = false;
try { tipClosed = localStorage.getItem('pointeuse.installTip') === 'off'; } catch {}
if (!standalone && isMobile && !tipClosed) {
  $('#install-tip').hidden = false;
  $('#install-text').textContent = isIOS
    ? 'Dans Safari : bouton Partager ⬆️ puis « Sur l’écran d’accueil ». Elle s’ouvrira en plein écran, comme une vraie app.'
    : 'Menu ⋮ du navigateur puis « Installer l’application » (ou « Ajouter à l’écran d’accueil »).';
}
let installEvent = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('#install-btn').hidden = false;
});
$('#install-btn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('#install-tip').hidden = true;
});
$('#install-close').addEventListener('click', () => {
  $('#install-tip').hidden = true;
  try { localStorage.setItem('pointeuse.installTip', 'off'); } catch {}
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
