import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as SecureStore from 'expo-secure-store';
import Anthropic from '@anthropic-ai/sdk';
import { dayKey, fmtDur, fmtSlots, planMinutes } from '../../shared/core';
import { readPlanningPhoto, toPlanning, guessMonday } from '../../shared/planning';

export const API_KEY = 'anthropic-api-key';

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

function WeekRows({ entries, monday, today, s, c }) {
  return [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const key = addDays(monday, i);
    const p = entries[key];
    if (!p && i === 6) return null;
    const label = new Date(key + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric' });
    const isToday = key === today;
    return (
      <View key={key} style={s.evRow}>
        <Text style={[s.text, { flex: 1, textTransform: 'capitalize' }, isToday && { color: c.accent, fontWeight: '600' }]}>{label}</Text>
        <Text style={[p?.status === 'work' ? s.text : s.muted, isToday && { color: c.accent, fontWeight: '600' }]}>
          {p ? fmtSlots(p) : '—'}{p?.status === 'work' ? `  (${fmtDur(planMinutes(p))})` : ''}
        </Text>
      </View>
    );
  });
}

// Prend la photo, la réduit (les photos de téléphone font plusieurs Mo) et la renvoie en base64.
async function pickPhoto(fromCamera) {
  const perm = fromCamera
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Autorisation refusée.');
  const opts = { mediaTypes: ['images'], quality: 1 };
  const res = fromCamera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (res.canceled) return null;
  const asset = res.assets[0];
  const ctx = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > 2400) {
    ctx.resize(asset.width >= asset.height ? { width: 2400 } : { height: 2400 });
  }
  const img = await (await ctx.renderAsync()).saveAsync({ base64: true, compress: 0.88, format: SaveFormat.JPEG });
  return { base64: img.base64, mediaType: 'image/jpeg' };
}

export default function Planning({ db, s, c, mutate, goSettings }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null); // { result, monday }
  const today = dayKey(Date.now());
  const person = db.settings.person;

  const read = async (fromCamera) => {
    const apiKey = await SecureStore.getItemAsync(API_KEY).catch(() => null);
    if (!person || !apiKey) {
      Alert.alert('Réglages', 'Renseigne ton nom et ta clé API Anthropic dans Réglages.');
      return goSettings();
    }
    setError('');
    let image;
    try {
      image = await pickPhoto(fromCamera);
    } catch (e) {
      return setError(e.message);
    }
    if (!image) return;
    setBusy(true);
    try {
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      const result = await readPlanningPhoto(client, image, person);
      setPending({ result, monday: guessMonday(result.week_number) });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) setError('Clé API refusée. Vérifie-la dans Réglages.');
      else if (e instanceof Anthropic.RateLimitError) setError('Trop de demandes, réessaie dans une minute.');
      else if (e instanceof Anthropic.APIConnectionError) setError('Pas de connexion internet.');
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const preview = pending && toPlanning(pending.result, pending.monday);
  const thisMonday = mondayOf(today);
  const mondays = [...new Set(Object.keys(db.planning).filter((k) => k >= thisMonday).map(mondayOf))].sort();

  return (
    <>
      <View style={s.header}><Text style={s.h1}>Planning</Text></View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable disabled={busy} style={[s.btn, { backgroundColor: c.accent, opacity: busy ? 0.5 : 1 }]} onPress={() => read(true)}>
          <Text style={s.btnText}>📷 Photo</Text>
        </Pressable>
        <Pressable disabled={busy} style={[s.btn, { backgroundColor: c.accent, opacity: busy ? 0.5 : 1 }]} onPress={() => read(false)}>
          <Text style={s.btnText}>🖼️ Galerie</Text>
        </Pressable>
      </View>
      <Text style={[s.muted, s.small, { marginVertical: 6 }]}>
        {person ? `Je cherche la ligne « ${person} ».` : 'Indique d’abord ton nom dans Réglages.'}
      </Text>
      {busy && (
        <View style={[s.card, { flexDirection: 'row', gap: 10, alignItems: 'center' }]}>
          <ActivityIndicator color={c.accent} />
          <Text style={s.text}>Claude lit ton planning… (30 s à 1 min)</Text>
        </View>
      )}
      {!!error && <Text style={{ color: c.red, marginVertical: 6 }}>❌ {error}</Text>}

      {preview && (
        <View style={[s.card, { borderColor: c.accent }]}>
          <Text style={s.h2}>Vérifie avant d’enregistrer</Text>
          <Text style={[s.muted, s.small]}>Lundi de cette semaine (AAAA-MM-JJ)</Text>
          <TextInput
            style={s.input}
            defaultValue={pending.monday}
            onEndEditing={(ev) => {
              const v = ev.nativeEvent.text.trim();
              if (/^\d{4}-\d{2}-\d{2}$/.test(v)) setPending({ ...pending, monday: mondayOf(v) });
            }}
          />
          <WeekRows entries={preview.entries} monday={pending.monday} today={null} s={s} c={c} />
          <View style={[s.rowBetween, { marginTop: 6 }]}>
            <Text style={[s.text, { fontWeight: '600' }]}>Total travaillé</Text>
            <Text style={[s.text, { fontWeight: '600' }]}>{fmtDur(preview.total)}</Text>
          </View>
          {preview.warnings.map((w) => <Text key={w} style={[s.small, { color: c.amber, marginTop: 4 }]}>⚠️ {w}</Text>)}
          {Object.keys(preview.entries).some((k) => db.planning[k]) && (
            <Text style={[s.small, { color: c.amber, marginTop: 4 }]}>Cette semaine avait déjà un planning : il sera remplacé.</Text>
          )}
          <View style={[s.rowBetween, { marginTop: 14 }]}>
            <Pressable onPress={() => setPending(null)}><Text style={s.muted}>Annuler</Text></Pressable>
            <Pressable style={s.btnSmall} onPress={() => {
              mutate((d) => { Object.assign(d.planning, preview.entries); });
              setPending(null);
            }}><Text style={s.btnText}>Enregistrer</Text></Pressable>
          </View>
        </View>
      )}

      {mondays.length === 0 && !preview && (
        <Text style={s.muted}>Aucun planning à venir. Prends en photo le planning affiché au magasin.</Text>
      )}
      {mondays.map((m) => {
        const total = [0, 1, 2, 3, 4, 5, 6].reduce((t, i) => t + planMinutes(db.planning[addDays(m, i)]), 0);
        return (
          <View key={m} style={s.card}>
            <View style={s.rowBetween}>
              <Text style={s.h2}>Semaine du {new Date(m + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</Text>
              <Text style={s.muted}>{fmtDur(total)}</Text>
            </View>
            <WeekRows entries={db.planning} monday={m} today={today} s={s} c={c} />
          </View>
        );
      })}
    </>
  );
}
