// Cœur de la pointeuse : logique pure, sans dépendance au stockage ni à l'UI.
// Partagé entre la version web (web/) et la version mobile (mobile/).

export const T = {
  IN: 'in',
  PAUSE: 'pause_start',
  RESUME: 'pause_end',
  OUT: 'out',
};

export const LABELS = {
  in: 'Arrivée',
  pause_start: 'Début de pause',
  pause_end: 'Fin de pause',
  out: 'Départ',
};

export const DEFAULT_SETTINGS = {
  // Nom tel qu'il apparaît sur le planning (pour retrouver ta ligne sur la photo).
  person: '',
  // Minutes attendues par jour de la semaine, index 0 = dimanche.
  schedule: [0, 420, 420, 420, 420, 420, 0],
  // Ajustement manuel du solde (heures sup payées, récup posée...), en minutes.
  balanceOffset: 0,
  // Pause minimale légale (Code du travail : 20 min dès 6 h de travail).
  minPauseMin: 20,
  minPauseAfterMin: 360,
  geo: {
    enabled: false,
    lat: null,
    lng: null,
    radius: 150, // mètres
    delayMin: 2, // minutes sur place avant pointage auto
  },
};

export function mergeSettings(s) {
  const d = DEFAULT_SETTINGS;
  return {
    ...d,
    ...(s || {}),
    schedule: s?.schedule?.length === 7 ? s.schedule : d.schedule,
    geo: { ...d.geo, ...(s?.geo || {}) },
  };
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const j = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${j}`;
}

export const sortEvents = (events) => [...events].sort((a, b) => a.ts - b.ts);

// État courant déduit du dernier pointage.
export function currentState(events) {
  const last = sortEvents(events).at(-1);
  if (!last || last.type === T.OUT) return 'off';
  if (last.type === T.PAUSE) return 'paused';
  return 'working';
}

export function allowedActions(state) {
  if (state === 'off') return [T.IN];
  if (state === 'working') return [T.PAUSE, T.OUT];
  return [T.RESUME, T.OUT];
}

// Regroupe les pointages en "services" (arrivée → départ). Un service est rattaché
// au jour de son arrivée, ce qui gère le travail de nuit qui passe minuit.
export function buildShifts(events) {
  const shifts = [];
  let cur = null;
  for (const e of sortEvents(events)) {
    if (e.type === T.IN || !cur) {
      if (cur) cur.incomplete = true; // nouvelle arrivée sans départ
      cur = { day: dayKey(e.ts), events: [], incomplete: false };
      shifts.push(cur);
      if (e.type !== T.IN) cur.incomplete = true; // pointage orphelin
    }
    cur.events.push(e);
    if (e.type === T.OUT) cur = null;
  }
  return shifts;
}

// Temps travaillé et temps de pause d'un service, en minutes.
// Un service encore ouvert est compté jusqu'à `now` uniquement s'il a commencé aujourd'hui.
export function computeShift(shift, now = Date.now()) {
  let worked = 0;
  let pause = 0;
  let state = 'off';
  let since = null;
  for (const e of shift.events) {
    if (state === 'working') worked += e.ts - since;
    if (state === 'paused') pause += e.ts - since;
    if (e.type === T.IN || e.type === T.RESUME) state = 'working';
    else if (e.type === T.PAUSE) state = 'paused';
    else state = 'off';
    since = e.ts;
  }
  const open = state !== 'off';
  const live = open && shift.day === dayKey(now);
  if (live && state === 'working') worked += now - since;
  if (live && state === 'paused') pause += now - since;
  return {
    worked: worked / 60000,
    pause: pause / 60000,
    open,
    live,
    incomplete: shift.incomplete || (open && !live),
  };
}

// ---------- Planning ----------
// planning = { 'YYYY-MM-DD': { status: 'work'|'off'|'holiday', slots: [['13:30','17:30'], ...] } }
// Il remplace les horaires contractuels pour les jours où il est connu.

export const toMin = (hm) => {
  const [h, m] = String(hm).split(/[:h]/).map(Number);
  return h * 60 + (m || 0);
};

export const planMinutes = (p) =>
  p?.status === 'work' ? p.slots.reduce((s, [a, b]) => s + Math.max(0, toMin(b) - toMin(a)), 0) : 0;

export function expectedFor(day, settings, planning = {}) {
  if (planning[day]) return planMinutes(planning[day]);
  return settings.schedule[new Date(day + 'T12:00').getDay()] || 0;
}

export const fmtSlots = (p) =>
  p.status === 'holiday' ? 'Férié' : p.status === 'off' ? 'Repos' : p.slots.map(([a, b]) => `${a}–${b}`).join(' · ');

// Récapitulatif par jour, du plus récent au plus ancien.
export function summarizeDays(events, settings, now = Date.now(), planning = {}) {
  const days = new Map();
  for (const sh of buildShifts(events)) {
    const r = computeShift(sh, now);
    const d = days.get(sh.day) || {
      day: sh.day, worked: 0, pause: 0, live: false, incomplete: false, events: [],
    };
    d.worked += r.worked;
    d.pause += r.pause;
    d.live ||= r.live;
    d.incomplete ||= r.incomplete;
    d.events.push(...sh.events);
    days.set(sh.day, d);
  }
  // Jours planifiés passés sans aucun pointage : affichés pour les repérer,
  // mais pas comptés dans le solde (congé ou oubli, à toi de corriger).
  const today = dayKey(now);
  for (const [day, p] of Object.entries(planning)) {
    if (day < today && !days.has(day) && planMinutes(p) > 0) {
      days.set(day, { day, worked: 0, pause: 0, live: false, incomplete: false, events: [], missing: true });
    }
  }
  return [...days.values()]
    .map((d) => {
      const expected = expectedFor(d.day, settings, planning);
      const plan = planning[d.day] || null;
      if (d.missing) {
        return { ...d, expected, plan, diff: 0, warnings: ['Prévu au planning mais aucun pointage'] };
      }
      const warnings = [];
      if (d.incomplete) warnings.push('Pointage incomplet (départ oublié ?)');
      if (!d.live && d.worked >= settings.minPauseAfterMin && d.pause < settings.minPauseMin) {
        warnings.push(`Pause < ${settings.minPauseMin} min pour plus de ${fmtDur(settings.minPauseAfterMin)} travaillées`);
      }
      return { ...d, expected, plan, diff: d.worked - expected, warnings };
    })
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

// Solde global : positif = l'entreprise te doit, négatif = tu dois à l'entreprise.
// La journée en cours n'est comptée qu'une fois terminée, pour ne pas afficher
// une "dette" chaque matin.
export function computeBalance(days, settings) {
  let total = settings.balanceOffset || 0;
  for (const d of days) if (!d.live && !d.missing) total += d.diff;
  return total;
}

// Prévision pour aujourd'hui : temps restant et heure de sortie estimée.
export function todayForecast(days, settings, events, now = Date.now(), planning = {}) {
  const key = dayKey(now);
  const today = days.find((d) => d.day === key);
  const worked = today?.worked || 0;
  const expected = expectedFor(key, settings, planning);
  const remaining = expected - worked;
  const state = currentState(events);
  const endAt = state === 'working' && remaining > 0 ? now + remaining * 60000 : null;
  return { worked, expected, remaining, endAt, pause: today?.pause || 0, plan: planning[key] || null };
}

// ---------- Formatage ----------

export function fmtDur(min, signed = false) {
  const neg = min < 0;
  const abs = Math.round(Math.abs(min));
  const s = `${Math.floor(abs / 60)}h${String(abs % 60).padStart(2, '0')}`;
  if (!signed) return (neg ? '-' : '') + s;
  return (neg ? '−' : '+') + s;
}

export const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export const fmtDay = (day) =>
  new Date(day + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

export function balanceText(min) {
  if (Math.abs(min) < 1) return 'Tu es à jour avec l’entreprise';
  return min > 0
    ? `L’entreprise te doit ${fmtDur(min)}`
    : `Tu dois ${fmtDur(-min)} à l’entreprise`;
}

// ---------- Export ----------

export function toCSV(days) {
  const rows = [['Jour', 'Pointages', 'Travaillé (min)', 'Pause (min)', 'Prévu (min)', 'Écart (min)']];
  for (const d of [...days].reverse()) {
    const pts = sortEvents(d.events).map((e) => `${LABELS[e.type]} ${fmtTime(e.ts)}`).join(' | ');
    rows.push([d.day, pts, Math.round(d.worked), Math.round(d.pause), d.expected, Math.round(d.diff)]);
  }
  return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
}

// ---------- Géolocalisation ----------

export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Machine à états du pointage automatique. On l'appelle à chaque nouvelle position.
// `geoState` = { insideSince, lastAutoDay } persisté par l'appelant.
// Retourne le nouvel état et `punch: true` quand il faut pointer l'arrivée.
export function geoTick(geoState, pos, settings, events, now = Date.now(), planning = {}) {
  const g = settings.geo;
  const next = { insideSince: null, lastAutoDay: null, ...geoState };
  if (!g.enabled || g.lat == null) return { state: next, punch: false, distance: null, inside: false };

  const distance = distanceM(pos.lat, pos.lng, g.lat, g.lng);
  // On tolère l'imprécision GPS : une position floue à 300 m ne compte pas comme "dedans".
  const inside = distance + Math.min(pos.accuracy || 0, 100) / 2 <= g.radius;

  if (!inside) {
    next.insideSince = null;
    return { state: next, punch: false, distance, inside };
  }
  if (!next.insideSince) next.insideSince = now;

  const today = dayKey(now);
  const elapsed = (now - next.insideSince) / 60000;
  // Un seul pointage auto par jour : si tu sors à midi et reviens, c'est à toi de gérer la pause.
  // Si le planning dit repos ou férié, on ne pointe pas (tu passes juste devant le magasin).
  const plannedOff = planning[today] && planning[today].status !== 'work';
  const punch =
    elapsed >= g.delayMin && currentState(events) === 'off' && next.lastAutoDay !== today && !plannedOff;
  if (punch) next.lastAutoDay = today;
  return { state: next, punch, distance, inside, elapsed };
}
