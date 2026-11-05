// Usta — marketplace for verified tradespeople and cleaners (MVP).
// Zero dependencies: Node 22+ (node:http + node:sqlite).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'usta.db');
const DEV_OTP = process.env.NODE_ENV !== 'production'; // returns OTP in response for testing
const COMMISSION_FIRST = 0.12;   // first job with a given client
const COMMISSION_REPEAT = 0.05;  // repeat client booked through app (anti-leakage incentive)
const WARRANTY_DAYS = 30;

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT,
  role TEXT NOT NULL DEFAULT 'customer', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS otps(phone TEXT PRIMARY KEY, code TEXT, expires INTEGER, attempts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, slug TEXT UNIQUE, name TEXT, icon TEXT);
CREATE TABLE IF NOT EXISTS services(
  id INTEGER PRIMARY KEY, category_id INTEGER REFERENCES categories(id),
  name TEXT, price INTEGER, unit TEXT, duration_min INTEGER);
CREATE TABLE IF NOT EXISTS pros(
  user_id INTEGER PRIMARY KEY REFERENCES users(id), bio TEXT, district TEXT,
  status TEXT DEFAULT 'pending', id_note TEXT, balance INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS pro_categories(pro_id INTEGER, category_id INTEGER, PRIMARY KEY(pro_id, category_id));
CREATE TABLE IF NOT EXISTS bookings(
  id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES users(id), pro_id INTEGER REFERENCES users(id),
  service_id INTEGER REFERENCES services(id), qty INTEGER DEFAULT 1, address TEXT, district TEXT,
  scheduled_at TEXT, notes TEXT, price INTEGER, commission INTEGER,
  status TEXT DEFAULT 'open', payment TEXT DEFAULT 'held',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, warranty_until TEXT);
CREATE TABLE IF NOT EXISTS reviews(booking_id INTEGER PRIMARY KEY, pro_id INTEGER, rating INTEGER, body TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, booking_id INTEGER, sender_id INTEGER, body TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payouts(id INTEGER PRIMARY KEY, pro_id INTEGER, amount INTEGER, status TEXT DEFAULT 'requested',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

// ---------- seed ----------
if (!db.prepare('SELECT 1 FROM categories LIMIT 1').get()) {
  const cats = [
    ['plumbing', 'Plumbing', '🚰', [['Fix leaking tap', 800, 'per tap', 60], ['Unclog drain', 1200, 'per drain', 60], ['Install toilet', 3000, 'per unit', 120], ['Install water heater', 3500, 'per unit', 150]]],
    ['electrical', 'Electrical', '💡', [['Install / replace socket', 500, 'per socket', 30], ['Install light fixture', 900, 'per fixture', 45], ['Find & fix fault', 1500, 'per visit', 90], ['Wire a room', 9000, 'per room', 480]]],
    ['cleaning', 'Cleaning', '🧽', [['Standard apartment clean', 150, 'per m²', 180], ['Deep / post-renovation clean', 250, 'per m²', 300], ['Window washing', 300, 'per window', 30], ['Carpet cleaning', 200, 'per m²', 60]]],
    ['appliances', 'Appliance repair', '🔧', [['Washing machine diagnosis + repair', 2000, 'per visit', 90], ['Fridge repair', 2500, 'per visit', 90], ['Install washing machine', 1500, 'per unit', 60]]],
    ['handyman', 'Handyman', '🔨', [['Assemble furniture', 1000, 'per item', 60], ['Hang shelf / TV / mirror', 600, 'per item', 30], ['Install door lock', 1200, 'per lock', 60]]],
  ];
  const ic = db.prepare('INSERT INTO categories(slug,name,icon) VALUES(?,?,?)');
  const is = db.prepare('INSERT INTO services(category_id,name,price,unit,duration_min) VALUES(?,?,?,?,?)');
  for (const [slug, name, icon, svcs] of cats) {
    const cid = ic.run(slug, name, icon).lastInsertRowid;
    for (const s of svcs) is.run(cid, ...s);
  }
  // admin + demo pros
  db.prepare("INSERT INTO users(phone,name,role) VALUES('+996700000000','Admin','admin')").run();
  const demo = [
    ['+996700111111', 'Azamat K.', 'Plumber, 9 years. Own tools, works clean.', 'Sverdlovsky', ['plumbing', 'handyman']],
    ['+996700222222', 'Nurlan T.', 'Licensed electrician. Residential & office.', 'Leninsky', ['electrical']],
    ['+996700333333', 'Aigul M.', 'Cleaning team of 3. Eco products available.', 'Oktyabrsky', ['cleaning']],
    ['+996700444444', 'Ruslan B.', 'Repairs Samsung, LG, Bosch appliances.', 'Pervomaisky', ['appliances', 'electrical']],
  ];
  for (const [phone, name, bio, district, cs] of demo) {
    const uid = db.prepare("INSERT INTO users(phone,name,role) VALUES(?,?,'pro')").run(phone, name).lastInsertRowid;
    db.prepare("INSERT INTO pros(user_id,bio,district,status,id_note) VALUES(?,?,?,'verified','Passport checked (demo)')").run(uid, bio, district);
    for (const c of cs) db.prepare('INSERT INTO pro_categories VALUES(?, (SELECT id FROM categories WHERE slug=?))').run(uid, c);
  }
}

// ---------- helpers ----------
const DISTRICTS = ['Leninsky', 'Oktyabrsky', 'Pervomaisky', 'Sverdlovsky'];
const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const fail = (res, code, error) => send(res, code, { error });
const normPhone = p => {
  const d = String(p || '').replace(/\D/g, '');
  if (/^996\d{9}$/.test(d)) return '+' + d;
  if (/^0\d{9}$/.test(d)) return '+996' + d.slice(1);
  if (/^\d{9}$/.test(d)) return '+996' + d;
  return null;
};
// Anti-leakage: mask phone numbers, messenger handles and links in chat.
const maskContacts = s => String(s)
  .replace(/(\+?\d[\d\s\-()]{7,}\d)/g, '[contact hidden]')
  .replace(/@[A-Za-z0-9_]{3,}/g, '[contact hidden]')
  .replace(/\b(t\.me|wa\.me|whatsapp|telegram|instagram)\S*/gi, '[contact hidden]');

function body(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('bad json')); } });
  });
}
function auth(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(t) || null;
}
const proStats = id => db.prepare(`SELECT ROUND(AVG(rating),1) rating, COUNT(*) reviews,
  (SELECT COUNT(*) FROM bookings WHERE pro_id=? AND status='completed') jobs FROM reviews WHERE pro_id=?`).get(id, id);
const bookingView = id => db.prepare(`
  SELECT b.*, s.name service, s.unit, c.name category, c.icon,
    cu.name customer_name, pu.name pro_name,
    (SELECT rating FROM reviews WHERE booking_id=b.id) my_rating
  FROM bookings b JOIN services s ON s.id=b.service_id JOIN categories c ON c.id=s.category_id
  JOIN users cu ON cu.id=b.customer_id LEFT JOIN users pu ON pu.id=b.pro_id WHERE b.id=?`).get(id);

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('POST', '/api/auth/request', async (req, res) => {
  const { phone } = await body(req);
  const p = normPhone(phone); if (!p) return fail(res, 400, 'Enter a Kyrgyz number, e.g. 0700 123 456');
  const code = String(crypto.randomInt(100000, 999999));
  db.prepare('INSERT OR REPLACE INTO otps(phone,code,expires,attempts) VALUES(?,?,?,0)').run(p, code, Date.now() + 5 * 60e3);
  // TODO production: send via SMS gateway (e.g. Nikita.kg / Twilio). Never return the code.
  send(res, 200, { ok: true, phone: p, ...(DEV_OTP ? { dev_code: code } : {}) });
});
route('POST', '/api/auth/verify', async (req, res) => {
  const { phone, code, name, role } = await body(req);
  const p = normPhone(phone); const o = p && db.prepare('SELECT * FROM otps WHERE phone=?').get(p);
  if (!o || o.expires < Date.now() || o.attempts >= 5) return fail(res, 400, 'Code expired, request a new one');
  if (o.code !== String(code)) { db.prepare('UPDATE otps SET attempts=attempts+1 WHERE phone=?').run(p); return fail(res, 400, 'Wrong code'); }
  db.prepare('DELETE FROM otps WHERE phone=?').run(p);
  let u = db.prepare('SELECT * FROM users WHERE phone=?').get(p);
  if (!u) {
    const r = role === 'pro' ? 'pro' : 'customer';
    const id = db.prepare('INSERT INTO users(phone,name,role) VALUES(?,?,?)').run(p, String(name || '').slice(0, 60) || 'User', r).lastInsertRowid;
    if (r === 'pro') db.prepare('INSERT INTO pros(user_id) VALUES(?)').run(id);
    u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?)').run(token, u.id);
  send(res, 200, { token, user: u });
});
route('GET', '/api/me', (req, res, _, u) => {
  if (!u) return fail(res, 401, 'Not signed in');
  const pro = u.role === 'pro' ? db.prepare('SELECT * FROM pros WHERE user_id=?').get(u.id) : null;
  if (pro) pro.categories = db.prepare('SELECT category_id FROM pro_categories WHERE pro_id=?').all(u.id).map(r => r.category_id);
  send(res, 200, { user: u, pro, stats: pro ? proStats(u.id) : null });
});
route('GET', '/api/catalog', (req, res) => {
  const cats = db.prepare('SELECT * FROM categories').all();
  for (const c of cats) c.services = db.prepare('SELECT * FROM services WHERE category_id=?').all(c.id);
  send(res, 200, { categories: cats, districts: DISTRICTS });
});
route('GET', '/api/pros', (req, res) => {
  const cat = new URL(req.url, 'http://x').searchParams.get('category');
  const rows = db.prepare(`SELECT u.id, u.name, p.bio, p.district FROM pros p JOIN users u ON u.id=p.user_id
    WHERE p.status='verified' ${cat ? 'AND p.user_id IN (SELECT pro_id FROM pro_categories WHERE category_id=?)' : ''}`).all(...(cat ? [cat] : []));
  for (const r of rows) Object.assign(r, proStats(r.id));
  rows.sort((a, b) => (b.rating || 0) - (a.rating || 0) || b.jobs - a.jobs);
  send(res, 200, rows);
});
route('GET', '/api/pros/:id', (req, res, { id }) => {
  const p = db.prepare(`SELECT u.id,u.name,p.bio,p.district,p.status FROM pros p JOIN users u ON u.id=p.user_id WHERE u.id=?`).get(id);
  if (!p || p.status !== 'verified') return fail(res, 404, 'Not found');
  Object.assign(p, proStats(id));
  p.reviews_list = db.prepare(`SELECT r.rating, r.body, r.created_at, u.name, s.name service FROM reviews r
    JOIN bookings b ON b.id=r.booking_id JOIN users u ON u.id=b.customer_id JOIN services s ON s.id=b.service_id
    WHERE r.pro_id=? ORDER BY r.created_at DESC LIMIT 20`).all(id);
  send(res, 200, p);
});

// Booking: price is fixed by the catalog — the client never negotiates.
route('POST', '/api/bookings', async (req, res, _, u) => {
  if (!u || u.role !== 'customer') return fail(res, 403, 'Sign in as a customer');
  const b = await body(req);
  const s = db.prepare('SELECT * FROM services WHERE id=?').get(b.service_id); if (!s) return fail(res, 400, 'Unknown service');
  const qty = Math.max(1, Math.min(500, parseInt(b.qty) || 1));
  if (!b.address || !DISTRICTS.includes(b.district) || !b.scheduled_at) return fail(res, 400, 'Address, district and time are required');
  if (new Date(b.scheduled_at) < new Date()) return fail(res, 400, 'Pick a time in the future');
  let proId = null;
  if (b.pro_id) {
    const ok = db.prepare(`SELECT 1 FROM pros WHERE user_id=? AND status='verified' AND user_id IN
      (SELECT pro_id FROM pro_categories WHERE category_id=?)`).get(b.pro_id, s.category_id);
    if (!ok) return fail(res, 400, 'This pro does not do that service');
    proId = Number(b.pro_id);
  }
  const price = s.price * qty;
  const repeat = proId && db.prepare("SELECT 1 FROM bookings WHERE customer_id=? AND pro_id=? AND status='completed'").get(u.id, proId);
  const commission = Math.round(price * (repeat ? COMMISSION_REPEAT : COMMISSION_FIRST));
  // payment='held': in production this is a card/Mbank/Elsom authorization hold, captured on completion.
  const id = db.prepare(`INSERT INTO bookings(customer_id,pro_id,service_id,qty,address,district,scheduled_at,notes,price,commission,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(u.id, proId, s.id, qty, String(b.address).slice(0, 200), b.district, b.scheduled_at,
    String(b.notes || '').slice(0, 500), price, commission, proId ? 'assigned' : 'open').lastInsertRowid;
  send(res, 201, bookingView(id));
});
route('GET', '/api/bookings', (req, res, _, u) => {
  if (!u) return fail(res, 401, 'Not signed in');
  let ids;
  if (u.role === 'customer') ids = db.prepare('SELECT id FROM bookings WHERE customer_id=? ORDER BY id DESC').all(u.id);
  else if (u.role === 'pro') ids = db.prepare('SELECT id FROM bookings WHERE pro_id=? ORDER BY id DESC').all(u.id);
  else ids = db.prepare('SELECT id FROM bookings ORDER BY id DESC LIMIT 200').all();
  send(res, 200, ids.map(r => bookingView(r.id)));
});
// Open jobs feed for verified pros in their categories (address hidden until accepted).
route('GET', '/api/jobs/open', (req, res, _, u) => {
  if (!u || u.role !== 'pro') return fail(res, 403, 'Pros only');
  const p = db.prepare('SELECT status FROM pros WHERE user_id=?').get(u.id);
  if (p.status !== 'verified') return send(res, 200, []);
  const rows = db.prepare(`SELECT b.id FROM bookings b JOIN services s ON s.id=b.service_id
    WHERE (b.status='open' OR (b.status='assigned' AND b.pro_id=?))
    AND s.category_id IN (SELECT category_id FROM pro_categories WHERE pro_id=?) ORDER BY b.scheduled_at`).all(u.id, u.id);
  send(res, 200, rows.map(r => { const v = bookingView(r.id); v.address = v.district + ' (full address after accepting)'; v.payout = v.price - v.commission; return v; }));
});
route('POST', '/api/bookings/:id/(?<action>(?!messages$)[^/]+)', async (req, res, { id, action }, u) => {
  if (!u) return fail(res, 401, 'Not signed in');
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id); if (!b) return fail(res, 404, 'Not found');
  const isCust = b.customer_id === u.id, isPro = u.role === 'pro', isAdmin = u.role === 'admin';
  const set = (fields) => { const k = Object.keys(fields); db.prepare(`UPDATE bookings SET ${k.map(x => x + '=?').join(',')} WHERE id=?`).run(...k.map(x => fields[x]), id); };
  const data = await body(req).catch(() => ({}));
  switch (action) {
    case 'accept': {
      if (!isPro) return fail(res, 403, 'Pros only');
      const p = db.prepare('SELECT status FROM pros WHERE user_id=?').get(u.id);
      if (p.status !== 'verified') return fail(res, 403, 'Your profile is not verified yet');
      if (!(b.status === 'open' || (b.status === 'assigned' && b.pro_id === u.id))) return fail(res, 409, 'Job already taken');
      // Atomic claim so two pros cannot accept the same open job.
      const r = db.prepare(`UPDATE bookings SET status='accepted', pro_id=? WHERE id=? AND (status='open' OR (status='assigned' AND pro_id=?))`).run(u.id, id, u.id);
      if (!r.changes) return fail(res, 409, 'Job already taken');
      break;
    }
    case 'decline':
      if (!isPro || b.pro_id !== u.id || b.status !== 'assigned') return fail(res, 403, 'Not allowed');
      set({ status: 'open', pro_id: null }); break; // falls back to open marketplace
    case 'start':
      if (!isPro || b.pro_id !== u.id || b.status !== 'accepted') return fail(res, 403, 'Not allowed');
      set({ status: 'in_progress' }); break;
    case 'finish':
      if (!isPro || b.pro_id !== u.id || b.status !== 'in_progress') return fail(res, 403, 'Not allowed');
      set({ status: 'awaiting_confirmation' }); break;
    case 'confirm': { // customer confirms -> money released to pro, warranty starts
      if (!(isCust || isAdmin) || !['awaiting_confirmation', 'disputed'].includes(b.status)) return fail(res, 403, 'Not allowed');
      const w = new Date(Date.now() + WARRANTY_DAYS * 864e5).toISOString().slice(0, 10);
      set({ status: 'completed', payment: 'released', completed_at: new Date().toISOString(), warranty_until: w });
      db.prepare('UPDATE pros SET balance=balance+? WHERE user_id=?').run(b.price - b.commission, b.pro_id);
      break;
    }
    case 'dispute':
      if (!isCust || !['awaiting_confirmation', 'completed'].includes(b.status)) return fail(res, 403, 'Not allowed');
      if (b.status === 'completed' && b.warranty_until < new Date().toISOString().slice(0, 10)) return fail(res, 400, 'Warranty expired');
      set({ status: 'disputed' });
      db.prepare('INSERT INTO messages(booking_id,sender_id,body) VALUES(?,?,?)').run(id, u.id, 'DISPUTE: ' + maskContacts(String(data.reason || 'No reason given').slice(0, 500)));
      break;
    case 'cancel':
      if (!(isCust || isAdmin) || !['open', 'assigned', 'accepted'].includes(b.status)) return fail(res, 403, 'Cannot cancel at this stage');
      set({ status: 'cancelled', payment: 'refunded' }); break;
    case 'refund': // admin resolves dispute in customer's favour
      if (!isAdmin || b.status !== 'disputed') return fail(res, 403, 'Not allowed');
      if (b.payment === 'released') db.prepare('UPDATE pros SET balance=balance-? WHERE user_id=?').run(b.price - b.commission, b.pro_id);
      set({ status: 'refunded', payment: 'refunded' }); break;
    case 'review': {
      if (!isCust || b.status !== 'completed') return fail(res, 403, 'You can review after the job is completed');
      const rating = parseInt(data.rating); if (!(rating >= 1 && rating <= 5)) return fail(res, 400, 'Rating 1–5');
      db.prepare('INSERT OR REPLACE INTO reviews(booking_id,pro_id,rating,body) VALUES(?,?,?,?)').run(id, b.pro_id, rating, maskContacts(String(data.body || '').slice(0, 1000)));
      break;
    }
    default: return fail(res, 404, 'Unknown action');
  }
  send(res, 200, bookingView(id));
});
// In-app chat with contact masking.
route('GET', '/api/bookings/:id/messages', (req, res, { id }, u) => {
  const b = u && db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!b || !(b.customer_id === u.id || b.pro_id === u.id || u.role === 'admin')) return fail(res, 403, 'Not allowed');
  send(res, 200, db.prepare('SELECT m.*, u.name FROM messages m JOIN users u ON u.id=m.sender_id WHERE booking_id=? ORDER BY m.id').all(id));
});
route('POST', '/api/bookings/:id/messages', async (req, res, { id }, u) => {
  const b = u && db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!b || !(b.customer_id === u.id || b.pro_id === u.id)) return fail(res, 403, 'Not allowed');
  const { text } = await body(req); if (!text || !String(text).trim()) return fail(res, 400, 'Empty message');
  db.prepare('INSERT INTO messages(booking_id,sender_id,body) VALUES(?,?,?)').run(id, u.id, maskContacts(String(text).slice(0, 1000)));
  send(res, 201, { ok: true });
});

// Pro profile + payouts
route('PUT', '/api/pro/profile', async (req, res, _, u) => {
  if (!u || u.role !== 'pro') return fail(res, 403, 'Pros only');
  const d = await body(req);
  if (d.name) db.prepare('UPDATE users SET name=? WHERE id=?').run(String(d.name).slice(0, 60), u.id);
  const district = DISTRICTS.includes(d.district) ? d.district : null;
  db.prepare(`UPDATE pros SET bio=?, district=?, id_note=?, status=CASE WHEN status='rejected' THEN 'pending' ELSE status END WHERE user_id=?`)
    .run(String(d.bio || '').slice(0, 500), district, String(d.id_note || '').slice(0, 200), u.id);
  db.prepare('DELETE FROM pro_categories WHERE pro_id=?').run(u.id);
  for (const c of (d.categories || []).slice(0, 10)) db.prepare('INSERT OR IGNORE INTO pro_categories SELECT ?, id FROM categories WHERE id=?').run(u.id, c);
  send(res, 200, { ok: true });
});
route('POST', '/api/pro/payout', (req, res, _, u) => {
  if (!u || u.role !== 'pro') return fail(res, 403, 'Pros only');
  const p = db.prepare('SELECT balance FROM pros WHERE user_id=?').get(u.id);
  if (p.balance <= 0) return fail(res, 400, 'Nothing to pay out');
  db.prepare('INSERT INTO payouts(pro_id,amount) VALUES(?,?)').run(u.id, p.balance);
  db.prepare('UPDATE pros SET balance=0 WHERE user_id=?').run(u.id);
  send(res, 200, { ok: true, amount: p.balance });
});

// Admin: verification queue
route('GET', '/api/admin/pros', (req, res, _, u) => {
  if (!u || u.role !== 'admin') return fail(res, 403, 'Admin only');
  send(res, 200, db.prepare(`SELECT u.id,u.name,u.phone,p.* ,(SELECT GROUP_CONCAT(c.name, ', ') FROM pro_categories pc JOIN categories c ON c.id=pc.category_id WHERE pc.pro_id=u.id) cats
    FROM pros p JOIN users u ON u.id=p.user_id ORDER BY p.status='pending' DESC, u.id DESC`).all());
});
route('POST', '/api/admin/pros/:id/:decision', (req, res, { id, decision }, u) => {
  if (!u || u.role !== 'admin') return fail(res, 403, 'Admin only');
  if (!['verified', 'rejected'].includes(decision)) return fail(res, 400, 'Bad decision');
  db.prepare('UPDATE pros SET status=? WHERE user_id=?').run(decision, id);
  send(res, 200, { ok: true });
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const PUB = path.join(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (m) {
        try { return await r.handler(req, res, m.groups || {}, auth(req)); }
        catch (e) { console.error(e); return fail(res, 500, 'Server error'); }
      }
    }
    return fail(res, 404, 'Not found');
  }
  let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
if (require.main === module) server.listen(PORT, () => console.log(`Usta running on http://localhost:${PORT}`));
module.exports = { server, db, maskContacts, normPhone };
