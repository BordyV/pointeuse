import AsyncStorage from '@react-native-async-storage/async-storage';
import { mergeSettings } from '../../shared/core';

const KEY = 'pointeuse.v1';

export async function load() {
  try {
    const raw = JSON.parse((await AsyncStorage.getItem(KEY)) || '{}');
    return { events: raw.events || [], settings: mergeSettings(raw.settings), geoState: raw.geoState || {}, planning: raw.planning || {} };
  } catch {
    return { events: [], settings: mergeSettings(), geoState: {}, planning: {} };
  }
}

export async function save(db) {
  await AsyncStorage.setItem(KEY, JSON.stringify(db));
}

// L'app et la tâche GPS en arrière-plan écrivent toutes les deux : on relit
// toujours la dernière version avant de modifier, pour ne rien écraser.
let queue = Promise.resolve();
export function update(fn) {
  const run = queue.then(async () => {
    const db = await load();
    const next = (await fn(db)) || db;
    await save(next);
    return next;
  });
  queue = run.catch(() => {});
  return run;
}
