// Lecture d'une photo de planning par Claude, partagée entre web et mobile.
// L'appelant fournit un client Anthropic déjà construit (avec la clé API de l'utilisateur).
import { dayKey, planMinutes, toMin } from './core.js';

export const MODEL = 'claude-opus-5-5';

const WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const HM = { type: 'string', description: 'Heure au format HH:MM sur 24 h, ex. "07:00" ou "13:30"' };

const SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'true si la ligne de la personne a été trouvée' },
    week_number: { type: ['integer', 'null'], description: 'Numéro de semaine visible (onglet "Semaine 46", titre...), sinon null' },
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          weekday: { type: 'string', enum: WEEKDAYS },
          status: { type: 'string', enum: ['work', 'off', 'holiday'] },
          slots: {
            type: 'array',
            items: {
              type: 'object',
              properties: { start: HM, end: HM },
              required: ['start', 'end'],
              additionalProperties: false,
            },
          },
          printed_total: { type: 'string', description: 'Total du jour tel qu’écrit sous la ligne, ex. "5h30", ou ""' },
        },
        required: ['weekday', 'status', 'slots', 'printed_total'],
        additionalProperties: false,
      },
    },
    printed_week_total: { type: 'string', description: 'Total hebdo écrit en bout de ligne, ex. "35h00", ou ""' },
    notes: { type: 'string', description: 'Doutes de lecture, en français, en une ou deux phrases. "" si rien.' },
  },
  required: ['found', 'week_number', 'days', 'printed_week_total', 'notes'],
  additionalProperties: false,
};

const SYSTEM = `Tu lis des photos de plannings d'équipe (tableurs de magasin, en français) et tu en extrais les horaires d'une seule personne.

Comment ces plannings sont généralement organisés :
- Une ligne par personne (NOM puis Prénom), souvent sur deux sous-lignes « AM » (matin) et « PM » (après-midi).
- Les colonnes sont les jours consécutifs à partir du lundi ; chaque jour occupe deux colonnes : heure de début puis heure de fin.
- Une cellule grisée ou vide signifie que la personne ne travaille pas sur cette demi-journée.
- Une colonne entièrement surlignée (souvent en jaune) est en général un jour férié : réponds status "holiday" avec slots vides, même si des heures pâles y sont écrites.
- Sous la ligne de la personne, une ligne donne le total travaillé par jour ; en bout de ligne figure le total de la semaine.
- Les heures sont écrites « 7h00 », « 13h30 » : convertis-les en "07:00", "13:30".

Règles :
- Rends tous les jours visibles sur la photo, dans l'ordre, même les jours de repos (status "off", slots vides).
- Un jour travaillé matin et après-midi donne deux créneaux ; un jour où la fin du matin et le début de l'après-midi sont identiques peut rester en deux créneaux.
- Les totaux imprimés te servent à vérifier ta lecture : la somme des créneaux d'un jour doit égaler son total. Si ce n'est pas le cas, relis la ligne, puis signale le doute dans "notes".
- Attention à ne pas confondre la personne avec une voisine qui a le même nom de famille ou le même prénom.
- Si tu ne trouves pas la personne, réponds found=false avec days vide.`;

// image : { base64, mediaType }   person : "PAROLA Hugo"
export async function readPlanningPhoto(client, image, person) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: `Extrais les horaires de : ${person}` },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude n’a pas pu lire cette image.');
  if (response.stop_reason === 'max_tokens') throw new Error('Réponse incomplète, réessaie.');
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Réponse vide.');
  const result = JSON.parse(text);
  if (!result.found) throw new Error(`« ${person} » introuvable sur la photo. Vérifie le nom dans Réglages.`);
  return result;
}

// Lundi de la semaine ISO `week` de l'année `year`.
export function mondayOfIsoWeek(week, year) {
  const jan4 = new Date(year, 0, 4, 12);
  const monday1 = new Date(jan4);
  monday1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const d = new Date(monday1);
  d.setDate(monday1.getDate() + (week - 1) * 7);
  return d;
}

export function isoWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(d.getFullYear(), 0, 4, 12);
  return 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

// Lundi proposé par défaut : celui de la semaine lue sur la photo (la plus proche
// d'aujourd'hui), sinon le lundi qui vient à partir du vendredi, sinon ce lundi.
export function guessMonday(weekNumber, now = new Date()) {
  if (weekNumber) {
    const candidates = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]
      .map((y) => mondayOfIsoWeek(weekNumber, y));
    return dayKey(candidates.sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0]);
  }
  const d = new Date(now);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow + (dow >= 4 ? 7 : 0));
  return dayKey(d);
}

const parsePrinted = (s) => {
  const m = /^(\d{1,2})h(\d{2})?$/.exec(String(s).trim());
  return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null;
};

// Transforme la lecture de Claude en entrées de planning datées, avec contrôles.
export function toPlanning(result, mondayKey) {
  const monday = new Date(mondayKey + 'T12:00');
  const entries = {};
  const warnings = [];
  let total = 0;
  for (const d of result.days) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + WEEKDAYS.indexOf(d.weekday));
    const key = dayKey(date);
    const slots = d.slots
      .map((s) => [normHM(s.start), normHM(s.end)])
      .filter(([a, b]) => a && b && toMin(b) > toMin(a));
    const entry = { status: d.status === 'work' && !slots.length ? 'off' : d.status, slots: d.status === 'work' ? slots : [] };
    entries[key] = entry;
    const mins = planMinutes(entry);
    total += mins;
    const printed = parsePrinted(d.printed_total);
    if (entry.status === 'work' && printed != null && printed !== mins) {
      warnings.push(`${d.weekday} : créneaux = ${fmt(mins)} mais total écrit ${d.printed_total}`);
    }
  }
  const printedWeek = parsePrinted(result.printed_week_total);
  // Le total hebdo imprimé inclut souvent les fériés payés : on ne compare que s'il n'y en a pas.
  const hasHoliday = result.days.some((d) => d.status === 'holiday');
  if (printedWeek != null && !hasHoliday && printedWeek !== total) {
    warnings.push(`Total lu ${fmt(total)} ≠ total écrit ${result.printed_week_total}`);
  }
  if (result.notes) warnings.push(result.notes);
  return { entries, total, warnings };
}

function normHM(s) {
  const m = /^(\d{1,2})[:h](\d{2})$/.exec(String(s).trim());
  return m && Number(m[1]) < 24 ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}
const fmt = (m) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
