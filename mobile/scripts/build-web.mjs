// Copies ../public into www/ and points the app at the API server.
//   USTA_API_URL=https://api.usta.kg npm run build
import { cpSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../public');
const out = path.resolve(here, '../www');
const api = (process.env.USTA_API_URL || '').replace(/\/$/, '');
if (!/^https:\/\//.test(api) && !process.env.ALLOW_INSECURE_API) {
  console.error('Set USTA_API_URL to your deployed server, e.g. USTA_API_URL=https://usta.onrender.com npm run build');
  console.error('(For a local emulator test: ALLOW_INSECURE_API=1 USTA_API_URL=http://10.0.2.2:3000 npm run build)');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true, filter: f => !f.endsWith('sw.js') && !f.endsWith('manifest.webmanifest') });
writeFileSync(path.join(out, 'config.js'), `window.USTA_CONFIG = ${JSON.stringify({ apiBase: api, native: true })};\n`);
console.log(`Built www/ → API ${api}`);
