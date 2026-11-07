// Construit une version autonome de la webapp dans dist/ (web/ + shared/),
// prête à être hébergée telle quelle (GitHub Pages, Netlify...).
//   node scripts/build-web.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'shared'), { recursive: true });
cpSync(join(root, 'web'), dist, { recursive: true });
for (const f of readdirSync(join(root, 'shared'))) cpSync(join(root, 'shared', f), join(dist, 'shared', f));

// En dev, web/ importe ../shared/ ; dans dist/, shared/ est à côté.
// Le nom du cache du service worker change à chaque build pour forcer la mise à jour sur le téléphone.
const version = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
for (const f of ['app.js', 'sw.js']) {
  const p = join(dist, f);
  let s = readFileSync(p, 'utf8').replaceAll('../shared/', './shared/');
  if (f === 'sw.js') s = s.replace(/const CACHE = '[^']+';/, `const CACHE = 'pointeuse-${version}';`);
  writeFileSync(p, s);
}
writeFileSync(join(dist, '.nojekyll'), '');
console.log(`dist/ prêt (version ${version})`);
