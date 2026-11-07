// Pointage automatique en arrière-plan.
//
// 1. Le système surveille une zone (geofence) autour du lieu de travail : très économe en batterie.
// 2. À l'entrée dans la zone, on lance un suivi GPS fin (toutes les ~30 s).
// 3. Si on est toujours dans la zone après le délai (2 min par défaut), on pointe l'arrivée
//    et on coupe le suivi fin. Si on ressort avant, on annule.
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { T, uid, geoTick, fmtTime } from '../../shared/core';
import { update } from './store';

export const GEOFENCE_TASK = 'pointeuse-geofence';
export const TRACK_TASK = 'pointeuse-track';

async function notify(title, body) {
  try {
    await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
  } catch {}
}

async function startTracking() {
  if (await Location.hasStartedLocationUpdatesAsync(TRACK_TASK).catch(() => false)) return;
  await Location.startLocationUpdatesAsync(TRACK_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 30000,
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: false,
    foregroundService: {
      notificationTitle: 'Pointeuse',
      notificationBody: 'Arrivée détectée, pointage en cours…',
    },
  });
}

async function stopTracking() {
  if (await Location.hasStartedLocationUpdatesAsync(TRACK_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(TRACK_TASK);
  }
}

// Traite une position : renvoie true si l'arrivée a été pointée.
export async function handlePosition(coords) {
  let punched = false;
  let stillInside = false;
  await update((db) => {
    const r = geoTick(
      db.geoState,
      { lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy },
      db.settings,
      db.events,
      Date.now(),
      db.planning,
    );
    db.geoState = r.state;
    stillInside = r.inside;
    if (r.punch) {
      db.events.push({ id: uid(), type: T.IN, ts: Date.now(), source: 'geo' });
      punched = true;
    }
    return db;
  });
  if (punched) await notify('Arrivée pointée automatiquement', `Pointé à ${fmtTime(Date.now())}. Bonne journée !`);
  return { punched, stillInside };
}

TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error || !data) return;
  if (data.eventType === Location.GeofencingEventType.Enter) {
    await update((db) => {
      db.geoState = { ...db.geoState, insideSince: db.geoState.insideSince || Date.now() };
      return db;
    });
    await startTracking();
  } else if (data.eventType === Location.GeofencingEventType.Exit) {
    await update((db) => {
      db.geoState = { ...db.geoState, insideSince: null };
      return db;
    });
    await stopTracking();
  }
});

TaskManager.defineTask(TRACK_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const { punched, stillInside } = await handlePosition(data.locations.at(-1).coords);
  // Le suivi fin ne sert qu'à valider le délai : on le coupe dès que c'est réglé.
  if (punched || !stillInside) await stopTracking();
});

// Active ou désactive la surveillance selon les réglages.
export async function syncGeofence(settings) {
  const g = settings.geo;
  const running = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
  if (running) await Location.stopGeofencingAsync(GEOFENCE_TASK);
  await stopTracking();
  if (!g.enabled || g.lat == null) return { ok: true };

  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return { ok: false, reason: 'Autorisation de localisation refusée.' };
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    return { ok: false, reason: 'Choisis « Toujours autoriser » la localisation pour que le pointage marche app fermée.' };
  }
  await Notifications.requestPermissionsAsync().catch(() => {});
  await Location.startGeofencingAsync(GEOFENCE_TASK, [
    { identifier: 'travail', latitude: g.lat, longitude: g.lng, radius: Math.max(100, g.radius), notifyOnEnter: true, notifyOnExit: true },
  ]);
  return { ok: true };
}
