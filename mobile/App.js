import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, AppState, Modal, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput,
  View, useColorScheme,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import {
  T, LABELS, mergeSettings, uid, dayKey, sortEvents, currentState, allowedActions,
  summarizeDays, computeBalance, todayForecast, fmtDur, fmtTime, fmtDay, balanceText, toCSV, fmtSlots,
} from '../shared/core';
import { load, update } from './src/store';
import { handlePosition, syncGeofence } from './src/geo';
import Planning, { API_KEY } from './src/Planning';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

const DAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const BTN_COLORS = { in: '#16a34a', pause_start: '#d97706', pause_end: '#2563eb', out: '#475569' };
const hm = (m) => `${Math.floor(Math.abs(m) / 60)}:${String(Math.round(Math.abs(m) % 60)).padStart(2, '0')}`;
function parseHM(str) {
  const s = String(str).trim().replace(',', '.');
  if (!s) return 0;
  const neg = s.startsWith('-');
  const [h, m] = s.replace(/^[-+]/, '').split(/[:h]/);
  const v = m !== undefined ? Number(h) * 60 + Number(m || 0) : Number(h) * 60;
  return Number.isFinite(v) ? (neg ? -v : v) : NaN;
}

export default function App() {
  const dark = useColorScheme() === 'dark';
  const c = dark ? darkColors : lightColors;
  const s = useMemo(() => makeStyles(c), [dark]);

  const [db, setDb] = useState(null);
  const [tab, setTab] = useState('pointer');
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState(null); // { event } ou { add: true }
  const [geoInfo, setGeoInfo] = useState(null);

  const reload = useCallback(() => load().then(setDb), []);
  const mutate = useCallback((fn) => update(fn).then(setDb), []);

  useEffect(() => {
    reload();
    const t = setInterval(() => setNow(Date.now()), 1000);
    // La tâche en arrière-plan a pu pointer pendant que l'app était fermée.
    const sub = AppState.addEventListener('change', (st) => st === 'active' && reload());
    return () => { clearInterval(t); sub.remove(); };
  }, []);

  // App ouverte : suivi direct de la position, en plus de la geofence système.
  useEffect(() => {
    if (!db?.settings.geo.enabled || db.settings.geo.lat == null) return;
    let sub;
    (async () => {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 15000, distanceInterval: 0 },
        async (p) => {
          const { punched } = await handlePosition(p.coords);
          const fresh = await load();
          setDb(fresh);
          setGeoInfo({ at: Date.now(), coords: p.coords, insideSince: fresh.geoState.insideSince });
          if (punched) Alert.alert('Arrivée pointée', 'Tu es arrivé·e sur ton lieu de travail.');
        },
      );
    })();
    return () => sub?.remove();
  }, [db?.settings.geo.enabled, db?.settings.geo.lat, db?.settings.geo.lng]);

  if (!db) return <View style={s.root} />;

  const { events, settings } = db;
  const state = currentState(events);
  const days = summarizeDays(events, settings, now, db.planning);
  const fc = todayForecast(days, settings, events, now, db.planning);
  const balance = computeBalance(days, settings);

  const punch = (type) => mutate((d) => { d.events.push({ id: uid(), type, ts: Date.now(), source: 'manual' }); });
  const delEvent = (e) => Alert.alert('Supprimer ?', `${LABELS[e.type]} de ${fmtTime(e.ts)}`, [
    { text: 'Annuler', style: 'cancel' },
    { text: 'Supprimer', style: 'destructive', onPress: () => mutate((d) => { d.events = d.events.filter((x) => x.id !== e.id); }) },
  ]);
  const saveSettings = async (patch, geoChanged) => {
    const next = await update((d) => { d.settings = mergeSettings({ ...d.settings, ...patch }); });
    setDb(next);
    if (geoChanged) {
      const r = await syncGeofence(next.settings);
      if (!r.ok) Alert.alert('Pointage auto', r.reason);
    }
  };

  const EventRow = ({ e }) => (
    <Pressable style={s.evRow} onPress={() => setEditing({ event: e })} onLongPress={() => delEvent(e)}>
      <Text style={s.evTime}>{fmtTime(e.ts)}</Text>
      <Text style={s.text}>{LABELS[e.type]}</Text>
      <Text style={s.muted}>{e.source === 'geo' ? ' 📍 auto' : e.source === 'edit' ? ' ✏️' : ''}</Text>
    </Pressable>
  );

  const geoBadge = () => {
    const g = settings.geo;
    if (!g.enabled) return null;
    const since = db.geoState.insideSince;
    let txt = '📍 Pointage auto actif';
    if (since && state === 'off') {
      const left = Math.max(0, g.delayMin * 60 - (now - since) / 1000);
      txt = left > 0 ? `📍 Sur site · pointage dans ${Math.ceil(left)} s` : '📍 Sur site';
    }
    return <Text style={s.badge}>{txt}</Text>;
  };

  return (
    <View style={s.root}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <ScrollView contentContainerStyle={s.scroll}>
        {tab === 'pointer' && (
          <>
            <View style={s.header}><Text style={s.h1}>Pointeuse</Text>{geoBadge()}</View>
            <View style={[s.card, { alignItems: 'center', paddingVertical: 28 }]}>
              <Text style={[s.state, state === 'working' && { color: c.green }, state === 'paused' && { color: c.amber }]}>
                {{ off: 'HORS SERVICE', working: 'AU TRAVAIL', paused: 'EN PAUSE' }[state]}
              </Text>
              <Text style={s.timer}>{fmtDur(fc.worked)}</Text>
              <Text style={s.muted}>travaillées aujourd’hui</Text>
              {fc.plan && <Text style={{ color: c.accent, fontWeight: '600', marginTop: 8 }}>Prévu : {fmtSlots(fc.plan)}</Text>}
              {fc.expected > 0 && (
                <Text style={[s.text, { marginTop: 10, textAlign: 'center' }]}>
                  {fc.remaining > 0 ? `Reste ${fmtDur(fc.remaining)} sur ${fmtDur(fc.expected)}` : `Objectif atteint · ${fmtDur(-fc.remaining, true)}`}
                  {fc.endAt ? ` · sortie à ${fmtTime(fc.endAt)}` : ''}
                </Text>
              )}
              {fc.pause > 0 && <Text style={s.muted}>Pause : {fmtDur(fc.pause)}</Text>}
            </View>

            <View style={s.actions}>
              {allowedActions(state).map((t) => (
                <Pressable key={t} onPress={() => punch(t)} style={({ pressed }) => [s.btn, { backgroundColor: BTN_COLORS[t], opacity: pressed ? 0.8 : 1 }]}>
                  <Text style={s.btnText}>{LABELS[t]}</Text>
                </Pressable>
              ))}
            </View>

            <View style={[s.card, { alignItems: 'center' }]}>
              <Text style={s.muted}>Solde global</Text>
              <Text style={[s.balance, { color: balance >= 0 ? c.green : c.red }]}>{fmtDur(balance, true)}</Text>
              <Text style={s.text}>{balanceText(balance)}</Text>
            </View>

            <View style={s.card}>
              <Text style={s.h2}>Aujourd’hui</Text>
              {sortEvents(events).filter((e) => dayKey(e.ts) === dayKey(now)).map((e) => <EventRow key={e.id} e={e} />)}
              {!events.some((e) => dayKey(e.ts) === dayKey(now)) && <Text style={s.muted}>Aucun pointage aujourd’hui.</Text>}
              <Text style={[s.muted, s.small, { marginTop: 8 }]}>Appui : modifier · appui long : supprimer</Text>
            </View>
          </>
        )}

        {tab === 'history' && (
          <>
            <View style={s.header}><Text style={s.h1}>Historique</Text></View>
            <Pressable style={[s.btnSmall, { marginBottom: 4 }]} onPress={() => setEditing({ add: true })}>
              <Text style={s.btnText}>+ Ajouter un pointage oublié</Text>
            </Pressable>
            {days.length === 0 && <Text style={s.muted}>Pas encore d’historique.</Text>}
            {days.map((d) => (
              <View key={d.day} style={s.card}>
                <View style={s.rowBetween}>
                  <Text style={[s.text, { fontWeight: '600', textTransform: 'capitalize' }]}>{fmtDay(d.day)}</Text>
                  <Text style={{ color: d.diff >= 0 ? c.green : c.red, fontWeight: '600' }}>{d.live ? 'en cours' : d.missing ? '—' : fmtDur(d.diff, true)}</Text>
                </View>
                <Text style={[s.muted, s.small]}>Travaillé {fmtDur(d.worked)} · Pause {fmtDur(d.pause)} · Prévu {fmtDur(d.expected)}{d.plan ? ` (${fmtSlots(d.plan)})` : ''}</Text>
                {d.warnings.map((w) => <Text key={w} style={[s.small, { color: c.amber }]}>⚠️ {w}</Text>)}
                {sortEvents(d.events).map((e) => <EventRow key={e.id} e={e} />)}
              </View>
            ))}
          </>
        )}

        {tab === 'planning' && <Planning db={db} s={s} c={c} mutate={mutate} goSettings={() => setTab('settings')} />}

        {tab === 'settings' && <Settings db={db} s={s} c={c} save={saveSettings} geoInfo={geoInfo} mutate={mutate} days={days} />}
      </ScrollView>

      <View style={s.tabs}>
        {[['pointer', '⏱️', 'Pointer'], ['planning', '🗓️', 'Planning'], ['history', '📅', 'Historique'], ['settings', '⚙️', 'Réglages']].map(([k, i, l]) => (
          <Pressable key={k} style={s.tabBtn} onPress={() => setTab(k)}>
            <Text style={{ fontSize: 20 }}>{i}</Text>
            <Text style={[s.small, { color: tab === k ? c.accent : c.muted }]}>{l}</Text>
          </Pressable>
        ))}
      </View>

      {editing && <EditModal editing={editing} s={s} c={c} onClose={() => setEditing(null)} mutate={mutate} />}
    </View>
  );
}

function EditModal({ editing, s, c, onClose, mutate }) {
  const e = editing.event;
  const [date, setDate] = useState(dayKey(e?.ts || Date.now()));
  const [time, setTime] = useState(e ? fmtTime(e.ts) : '');
  const [type, setType] = useState(e?.type || T.IN);
  const ok = () => {
    const ts = new Date(`${date}T${time.padStart(5, '0')}`).getTime();
    if (!Number.isFinite(ts)) return Alert.alert('Format attendu', 'Date AAAA-MM-JJ et heure HH:MM');
    mutate((d) => {
      if (e) Object.assign(d.events.find((x) => x.id === e.id) || {}, { ts, type, source: 'edit' });
      else d.events.push({ id: uid(), ts, type, source: 'edit' });
    });
    onClose();
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.modalBg}>
        <View style={s.modal}>
          <Text style={s.h2}>{e ? 'Modifier le pointage' : 'Ajouter un pointage'}</Text>
          <TextInput style={s.input} value={date} onChangeText={setDate} placeholder="AAAA-MM-JJ" placeholderTextColor={c.muted} />
          <TextInput style={s.input} value={time} onChangeText={setTime} placeholder="HH:MM" placeholderTextColor={c.muted} keyboardType="numbers-and-punctuation" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {Object.values(T).map((t) => (
              <Pressable key={t} onPress={() => setType(t)} style={[s.chip, type === t && { backgroundColor: BTN_COLORS[t] }]}>
                <Text style={[s.small, { color: type === t ? '#fff' : c.text }]}>{LABELS[t]}</Text>
              </Pressable>
            ))}
          </View>
          <View style={[s.rowBetween, { marginTop: 16 }]}>
            <Pressable onPress={onClose}><Text style={s.muted}>Annuler</Text></Pressable>
            <Pressable style={s.btnSmall} onPress={ok}><Text style={s.btnText}>Enregistrer</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Settings({ db, s, c, save, geoInfo, mutate, days }) {
  const { settings } = db;
  const g = settings.geo;
  const [offset, setOffset] = useState((settings.balanceOffset < 0 ? '-' : '') + hm(settings.balanceOffset));
  const [apiKey, setApiKey] = useState('');
  useEffect(() => { SecureStore.getItemAsync(API_KEY).then((k) => setApiKey(k || '')).catch(() => {}); }, []);

  const setHere = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Localisation', 'Autorisation refusée.');
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
    await save({ geo: { ...g, lat: p.coords.latitude, lng: p.coords.longitude } }, true);
    Alert.alert('Lieu enregistré', `Précision ${Math.round(p.coords.accuracy)} m`);
  };

  return (
    <>
      <View style={s.header}><Text style={s.h1}>Réglages</Text></View>

      <View style={s.card}>
        <Text style={s.h2}>Lecture du planning</Text>
        <Text style={[s.muted, s.small]}>Ton nom tel qu’écrit sur le planning</Text>
        <TextInput style={s.input} defaultValue={settings.person} placeholder="PAROLA Hugo" placeholderTextColor={c.muted}
          autoCapitalize="characters" onEndEditing={(ev) => save({ person: ev.nativeEvent.text.trim() })} />
        <Text style={[s.muted, s.small, { marginTop: 6 }]}>Clé API Anthropic</Text>
        <TextInput style={s.input} value={apiKey} onChangeText={setApiKey} placeholder="sk-ant-…" placeholderTextColor={c.muted}
          secureTextEntry autoCapitalize="none" autoCorrect={false}
          onEndEditing={() => SecureStore.setItemAsync(API_KEY, apiKey.trim())} />
        <Text style={[s.muted, s.small]}>La clé est gardée dans le coffre sécurisé du téléphone. La photo est envoyée à Claude pour être lue : elle contient aussi les horaires de tes collègues.</Text>
      </View>

      <View style={s.card}>
        <Text style={s.h2}>Horaires contractuels</Text>
        <Text style={[s.muted, s.small]}>Total : {fmtDur(settings.schedule.reduce((a, b) => a + b, 0))} / semaine</Text>
        <View style={{ flexDirection: 'row', gap: 4, marginTop: 8 }}>
          {[1, 2, 3, 4, 5, 6, 0].map((i) => (
            <View key={i} style={{ flex: 1, alignItems: 'center' }}>
              <Text style={[s.muted, s.small]}>{DAYS[i]}</Text>
              <TextInput
                style={[s.input, { textAlign: 'center', paddingHorizontal: 2, width: '100%' }]}
                defaultValue={hm(settings.schedule[i])}
                keyboardType="numbers-and-punctuation"
                onEndEditing={(ev) => {
                  const v = parseHM(ev.nativeEvent.text);
                  if (Number.isNaN(v) || v < 0) return Alert.alert('Format attendu', '7:00 ou 7.5');
                  const sch = [...settings.schedule];
                  sch[i] = Math.round(v);
                  save({ schedule: sch });
                }}
              />
            </View>
          ))}
        </View>
      </View>

      <View style={s.card}>
        <Text style={s.h2}>Ajustement du solde</Text>
        <Text style={[s.muted, s.small]}>Heures sup payées, récup posée… Ex : -3:30</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <TextInput style={[s.input, { flex: 1 }]} value={offset} onChangeText={setOffset} keyboardType="numbers-and-punctuation" />
          <Pressable style={s.btnSmall} onPress={() => {
            const v = parseHM(offset);
            if (Number.isNaN(v)) return Alert.alert('Format attendu', '-3:30');
            save({ balanceOffset: Math.round(v) });
          }}><Text style={s.btnText}>OK</Text></Pressable>
        </View>
      </View>

      <View style={s.card}>
        <Text style={s.h2}>Pointage automatique (GPS)</Text>
        <View style={s.rowBetween}>
          <Text style={s.text}>Pointer l’arrivée automatiquement</Text>
          <Switch value={g.enabled} onValueChange={(v) => save({ geo: { ...g, enabled: v } }, true)} />
        </View>
        <Text style={[s.muted, s.small, { marginVertical: 6 }]}>
          {g.lat != null ? `Lieu : ${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}` : 'Aucun lieu de travail défini.'}
        </Text>
        <Pressable style={s.btnSmall} onPress={setHere}><Text style={s.btnText}>📍 Ma position actuelle = lieu de travail</Text></Pressable>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={[s.muted, s.small]}>Rayon (m, min 100)</Text>
            <TextInput style={s.input} defaultValue={String(g.radius)} keyboardType="number-pad"
              onEndEditing={(ev) => save({ geo: { ...g, radius: Number(ev.nativeEvent.text) || 150 } }, true)} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.muted, s.small]}>Délai (min)</Text>
            <TextInput style={s.input} defaultValue={String(g.delayMin)} keyboardType="decimal-pad"
              onEndEditing={(ev) => save({ geo: { ...g, delayMin: Math.max(0, Number(ev.nativeEvent.text.replace(',', '.')) || 0) } })} />
          </View>
        </View>
        {geoInfo && (
          <Text style={[s.muted, s.small, { marginTop: 6 }]}>
            Dernière position {fmtTime(geoInfo.at)} · précision {Math.round(geoInfo.coords.accuracy)} m · {geoInfo.insideSince ? 'sur site' : 'hors site'}
          </Text>
        )}
      </View>

      <View style={s.card}>
        <Text style={s.h2}>Données</Text>
        <Pressable style={s.btnSmall} onPress={() => Share.share({ title: 'Pointages', message: toCSV(days) })}>
          <Text style={s.btnText}>Partager l’export CSV</Text>
        </Pressable>
        <Pressable style={[s.btnSmall, { marginTop: 8 }]} onPress={() => Share.share({ title: 'Sauvegarde pointeuse', message: JSON.stringify(db) })}>
          <Text style={s.btnText}>Partager une sauvegarde (JSON)</Text>
        </Pressable>
        <Pressable style={[s.btnSmall, { marginTop: 8, backgroundColor: 'transparent', borderWidth: 1, borderColor: c.red }]}
          onPress={() => Alert.alert('Tout effacer ?', 'Pointages et réglages seront supprimés.', [
            { text: 'Annuler', style: 'cancel' },
            { text: 'Effacer', style: 'destructive', onPress: async () => {
              await syncGeofence(mergeSettings());
              mutate(() => ({ events: [], settings: mergeSettings(), geoState: {}, planning: {} }));
            } },
          ])}>
          <Text style={[s.btnText, { color: c.red }]}>Tout effacer</Text>
        </Pressable>
      </View>
    </>
  );
}

const lightColors = { bg: '#f1f5f9', card: '#fff', text: '#0f172a', muted: '#64748b', border: '#e2e8f0', accent: '#2563eb', green: '#16a34a', amber: '#d97706', red: '#dc2626' };
const darkColors = { bg: '#0b1120', card: '#131c2e', text: '#e2e8f0', muted: '#94a3b8', border: '#1e293b', accent: '#3b82f6', green: '#22c55e', amber: '#f59e0b', red: '#ef4444' };

const makeStyles = (c) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 16, paddingTop: 56, paddingBottom: 100 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  h1: { fontSize: 26, fontWeight: '700', color: c.text },
  h2: { fontSize: 16, fontWeight: '600', color: c.text, marginBottom: 8 },
  text: { color: c.text, fontSize: 15 },
  muted: { color: c.muted, fontSize: 14 },
  small: { fontSize: 12 },
  card: { backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 16, padding: 16, marginVertical: 6 },
  state: { fontSize: 13, fontWeight: '600', letterSpacing: 1, color: c.muted },
  timer: { fontSize: 56, fontWeight: '700', color: c.text, fontVariant: ['tabular-nums'] },
  balance: { fontSize: 32, fontWeight: '700', fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: 10, marginVertical: 6 },
  btn: { flex: 1, borderRadius: 14, paddingVertical: 20, alignItems: 'center' },
  btnSmall: { backgroundColor: c.accent, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  evRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border, gap: 10 },
  evTime: { color: c.text, fontWeight: '600', width: 50, fontVariant: ['tabular-nums'] },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  badge: { fontSize: 12, color: c.green, backgroundColor: c.card, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4, overflow: 'hidden' },
  tabs: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border, paddingBottom: 24, paddingTop: 8 },
  tabBtn: { flex: 1, alignItems: 'center' },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 10, color: c.text, backgroundColor: c.bg, marginVertical: 4 },
  modalBg: { flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: c.card, borderRadius: 16, padding: 20 },
  chip: { borderWidth: 1, borderColor: c.border, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 6 },
});
