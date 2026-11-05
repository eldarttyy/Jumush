// Usta — marketplace for verified tradespeople and cleaners.
// Zero dependencies: Node 22+ (node:http + node:sqlite).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'usta.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const DEV_OTP = process.env.NODE_ENV !== 'production'; // returns OTP in the response for testing
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const CFG = {
  commissionFirst: 0.12,   // first job with a given client
  commissionRepeat: 0.05,  // client rebooks same pro through the app (anti-leakage incentive)
  warrantyDays: 30,
  recurringDiscount: 0.10, // Handy-style discount for recurring cleaning
  lateCancelFee: 0.20,     // paid to the pro if client cancels < lateCancelHours before start
  lateCancelHours: 24,
  minLeadHours: 2,         // earliest bookable slot
  tzOffsetH: 6,            // Asia/Bishkek, no DST
};
const DISTRICTS = ['Leninsky', 'Oktyabrsky', 'Pervomaisky', 'Sverdlovsky'];
const RECURRENCE_DAYS = { weekly: 7, biweekly: 14, monthly: 28 };
const BUSY = "('assigned','accepted','in_progress')";

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT,
  role TEXT NOT NULL DEFAULT 'customer', avatar TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS otps(phone TEXT PRIMARY KEY, code TEXT, expires INTEGER, attempts INTEGER DEFAULT 0, sent_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), created_at INTEGER);
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, slug TEXT UNIQUE, name TEXT, icon TEXT, recurring INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY, category_id INTEGER REFERENCES categories(id),
  name TEXT, price INTEGER, unit TEXT, base_min INTEGER, per_unit_min INTEGER, default_qty INTEGER DEFAULT 1, popular INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS pros(user_id INTEGER PRIMARY KEY REFERENCES users(id), bio TEXT, district TEXT,
  status TEXT DEFAULT 'pending', id_note TEXT, hours TEXT, balance INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS pro_categories(pro_id INTEGER, category_id INTEGER, PRIMARY KEY(pro_id, category_id));
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES users(id), pro_id INTEGER REFERENCES users(id),
  service_id INTEGER, category_id INTEGER REFERENCES categories(id), title TEXT, unit TEXT, qty INTEGER DEFAULT 1,
  duration_min INTEGER, address TEXT, district TEXT, scheduled_at TEXT, notes TEXT,
  price INTEGER, commission INTEGER, tip INTEGER DEFAULT 0, cancel_fee INTEGER DEFAULT 0,
  recurrence TEXT DEFAULT 'none', parent_id INTEGER, request_id INTEGER,
  status TEXT DEFAULT 'open', payment TEXT DEFAULT 'held',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, warranty_until TEXT);
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES users(id),
  category_id INTEGER REFERENCES categories(id), title TEXT, description TEXT, district TEXT, address TEXT,
  preferred_at TEXT, status TEXT DEFAULT 'open', booking_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS quotes(id INTEGER PRIMARY KEY, request_id INTEGER REFERENCES requests(id), pro_id INTEGER REFERENCES users(id),
  price INTEGER, message TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(request_id, pro_id));
CREATE TABLE IF NOT EXISTS reviews(booking_id INTEGER PRIMARY KEY, pro_id INTEGER, rating INTEGER, body TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, booking_id INTEGER, sender_id INTEGER, body TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payouts(id INTEGER PRIMARY KEY, pro_id INTEGER, amount INTEGER, status TEXT DEFAULT 'requested', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY, owner_id INTEGER, kind TEXT, file TEXT UNIQUE, ref_type TEXT, ref_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER, body TEXT, link TEXT, read INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS favorites(customer_id INTEGER, pro_id INTEGER, PRIMARY KEY(customer_id, pro_id));
CREATE INDEX IF NOT EXISTS ix_b_pro ON bookings(pro_id, status);
CREATE INDEX IF NOT EXISTS ix_b_cust ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS ix_n_user ON notifications(user_id, read);
`);

// ---------- seed ----------
if (!db.prepare('SELECT 1 FROM categories LIMIT 1').get()) {
  // [name, price, unit, base_min, per_unit_min, default_qty, popular]
  const cats = [
    ['cleaning', 'Cleaning', '🧽', 1, [['Standard apartment clean', 150, 'per m²', 60, 2, 50, 1], ['Deep / post-renovation clean', 250, 'per m²', 90, 4, 50, 0], ['Window washing', 300, 'per window', 30, 15, 4, 0], ['Carpet cleaning', 200, 'per m²', 30, 2, 10, 0]]],
    ['plumbing', 'Plumbing', '🚰', 0, [['Fix leaking tap', 800, 'per tap', 60, 30, 1, 1], ['Unclog drain', 1200, 'per drain', 60, 30, 1, 1], ['Install toilet', 3000, 'per unit', 120, 90, 1, 0], ['Install water heater', 3500, 'per unit', 150, 120, 1, 0]]],
    ['electrical', 'Electrical', '💡', 0, [['Install / replace socket', 500, 'per socket', 30, 15, 1, 1], ['Install light fixture', 900, 'per fixture', 45, 30, 1, 0], ['Find & fix fault', 1500, 'per visit', 90, 0, 1, 0], ['Wire a room', 9000, 'per room', 480, 240, 1, 0]]],
    ['appliances', 'Appliance repair', '🔧', 0, [['Washing machine repair', 2000, 'per visit', 90, 0, 1, 0], ['Fridge repair', 2500, 'per visit', 90, 0, 1, 0], ['Install washing machine', 1500, 'per unit', 60, 45, 1, 0]]],
    ['handyman', 'Handyman', '🔨', 0, [['Assemble furniture', 1000, 'per item', 60, 45, 1, 1], ['Hang shelf / TV / mirror', 600, 'per item', 30, 20, 1, 1], ['Install door lock', 1200, 'per lock', 60, 40, 1, 0]]],
    ['moving', 'Moving help', '📦', 0, [['Movers (2 people)', 1500, 'per hour', 60, 60, 2, 0], ['Furniture disposal', 2000, 'per load', 90, 60, 1, 0]]],
  ];
  const ic = db.prepare('INSERT INTO categories(slug,name,icon,recurring) VALUES(?,?,?,?)');
  const is = db.prepare('INSERT INTO services(category_id,name,price,unit,base_min,per_unit_min,default_qty,popular) VALUES(?,?,?,?,?,?,?,?)');
  for (const [slug, name, icon, rec, svcs] of cats) { const cid = ic.run(slug, name, icon, rec).lastInsertRowid; for (const s of svcs) is.run(cid, ...s); }
  db.prepare("INSERT INTO users(phone,name,role) VALUES('+996700000000','Admin','admin')").run();
  const demo = [
    ['+996700111111', 'Azamat K.', 'Plumber with 9 years of experience. Brings his own tools, cleans up after himself, and fixes it right the first time.', 'Sverdlovsky', ['plumbing', 'handyman']],
    ['+996700222222', 'Nurlan T.', 'Licensed electrician. Apartments and offices, from a single socket to full rewiring.', 'Leninsky', ['electrical', 'handyman']],
    ['+996700333333', 'Aigul M.', 'Cleaning team of 3. Eco-friendly products on request. Regular clients get the same team every time.', 'Oktyabrsky', ['cleaning']],
    ['+996700444444', 'Ruslan B.', 'Repairs Samsung, LG and Bosch appliances. Original spare parts.', 'Pervomaisky', ['appliances', 'electrical']],
    ['+996700555555', 'Bakyt & Co', 'Moving crew with a van. Careful with furniture.', 'Leninsky', ['moving', 'handyman']],
  ];
  const cust = db.prepare("INSERT INTO users(phone,name,role) VALUES('+996709999999','Demo Customer','customer')").run().lastInsertRowid;
  const texts = ['Arrived on time and did a very tidy job.', 'Fast, polite, fair price. Will book again.', 'Solved the problem other masters could not.', 'Good work, a bit late but called ahead.'];
  for (const [phone, name, bio, district, cs] of demo) {
    const uid = db.prepare("INSERT INTO users(phone,name,role) VALUES(?,?,'pro')").run(phone, name).lastInsertRowid;
    db.prepare("INSERT INTO pros(user_id,bio,district,status,id_note) VALUES(?,?,?,'verified','Passport checked (demo)')").run(uid, bio, district);
    for (const c of cs) db.prepare('INSERT INTO pro_categories VALUES(?, (SELECT id FROM categories WHERE slug=?))').run(uid, c);
    const svc = db.prepare('SELECT s.* FROM services s JOIN categories c ON c.id=s.category_id WHERE c.slug=? LIMIT 1').get(cs[0]);
    for (let i = 0; i < 3 + (uid % 3); i++) {
      const when = new Date(Date.now() - (i + 2) * 6 * 864e5).toISOString();
      const bid = db.prepare(`INSERT INTO bookings(customer_id,pro_id,service_id,category_id,title,unit,qty,duration_min,address,district,scheduled_at,price,commission,status,payment,completed_at,warranty_until)
        VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,'completed','released',?,?)`).run(cust, uid, svc.id, svc.category_id, svc.name, svc.unit, svc.base_min, 'Demo', district, when, svc.price, Math.round(svc.price * 0.12), when, when.slice(0, 10)).lastInsertRowid;
      db.prepare('INSERT INTO reviews(booking_id,pro_id,rating,body,created_at) VALUES(?,?,?,?,?)').run(bid, uid, i === 3 ? 4 : 5, texts[(uid + i) % 4], when);
    }
  }
}

// ---------- helpers ----------
const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const fail = (res, code, error) => send(res, code, { error });
const normPhone = p => {
  const d = String(p || '').replace(/\D/g, '');
  if (/^996\d{9}$/.test(d)) return '+' + d;
  if (/^0\d{9}$/.test(d)) return '+996' + d.slice(1);
  if (/^\d{9}$/.test(d)) return '+996' + d;
  return null;
};
// Anti-leakage: mask phone numbers, messenger handles and links.
const maskContacts = s => String(s)
  .replace(/(\+?\d[\d\s\-()]{7,}\d)/g, '[contact hidden]')
  .replace(/@[A-Za-z0-9_]{3,}/g, '[contact hidden]')
  .replace(/\b(t\.me|wa\.me|whatsapp|telegram|instagram|viber)\S*/gi, '[contact hidden]');
const clip = (s, n) => String(s ?? '').slice(0, n);

function readBody(req, limit = 1e5) {
  return new Promise((resolve, reject) => {
    let d = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); } else d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); } });
  });
}
function auth(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  return t ? db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(t) || null : null;
}
const notify = (userId, body, link) => userId && db.prepare('INSERT INTO notifications(user_id,body,link) VALUES(?,?,?)').run(userId, body, link || null);
const notifyAdmins = (body, link) => db.prepare("SELECT id FROM users WHERE role='admin'").all().forEach(a => notify(a.id, body, link));
const prosInCategory = cid => db.prepare("SELECT pc.pro_id id FROM pro_categories pc JOIN pros p ON p.user_id=pc.pro_id WHERE pc.category_id=? AND p.status='verified'").all(cid);
const proDoesCategory = (pid, cid) => !!db.prepare("SELECT 1 FROM pros p JOIN pro_categories pc ON pc.pro_id=p.user_id WHERE p.user_id=? AND p.status='verified' AND pc.category_id=?").get(pid, cid);
const proStats = id => db.prepare(`SELECT ROUND(AVG(rating),1) rating, COUNT(*) reviews,
  (SELECT COUNT(*) FROM bookings WHERE pro_id=? AND status='completed') jobs FROM reviews WHERE pro_id=?`).get(id, id);
const photosFor = (type, id) => db.prepare("SELECT id, '/media/'||file url FROM photos WHERE ref_type=? AND ref_id=? ORDER BY id").all(type, id);
const commissionFor = (customerId, proId, price) => {
  const repeat = proId && db.prepare("SELECT 1 FROM bookings WHERE customer_id=? AND pro_id=? AND status='completed'").get(customerId, proId);
  return Math.round(price * (repeat ? CFG.commissionRepeat : CFG.commissionFirst));
};
const attachPhotos = (ids, ownerId, type, refId) => {
  for (const pid of (Array.isArray(ids) ? ids : []).slice(0, 8))
    db.prepare("UPDATE photos SET ref_type=?, ref_id=? WHERE id=? AND owner_id=? AND kind='job' AND ref_id IS NULL").run(type, refId, pid, ownerId);
};

// --- scheduling (all wall-clock maths in Bishkek time) ---
const TZ_MS = CFG.tzOffsetH * 3600e3;
const DEFAULT_HOURS = { 1: [9, 19], 2: [9, 19], 3: [9, 19], 4: [9, 19], 5: [9, 19], 6: [10, 16] }; // 0=Sun
const localParts = ms => { const d = new Date(ms + TZ_MS); return { dow: d.getUTCDay(), h: d.getUTCHours() + d.getUTCMinutes() / 60 }; };
const proHours = p => { try { return (p.hours && JSON.parse(p.hours)) || DEFAULT_HOURS; } catch { return DEFAULT_HOURS; } };
const durationFor = (svc, qty) => Math.min(600, svc.base_min + svc.per_unit_min * (qty - 1));
function isFree(proId, startMs, durMin, excludeId = 0) {
  const end = startMs + durMin * 6e4;
  return !db.prepare(`SELECT scheduled_at, duration_min FROM bookings WHERE pro_id=? AND id<>? AND status IN ${BUSY}`).all(proId, excludeId)
    .some(r => { const s = Date.parse(r.scheduled_at); return s < end && startMs < s + r.duration_min * 6e4; });
}
function withinHours(pro, startMs, durMin) {
  const { dow, h } = localParts(startMs); const w = proHours(pro)[dow];
  return !!w && h >= w[0] && h + durMin / 60 <= w[1];
}
function slotsFor(pro, date, durMin) {
  const day0 = Date.parse(date + 'T00:00:00+0' + CFG.tzOffsetH + ':00'); if (isNaN(day0)) return [];
  const w = proHours(pro)[localParts(day0).dow]; if (!w) return [];
  const out = [];
  for (let h = w[0]; h + durMin / 60 <= w[1]; h++) {
    const s = day0 + h * 3600e3;
    if (s >= Date.now() + CFG.minLeadHours * 3600e3 && isFree(pro.user_id, s, durMin)) out.push({ at: new Date(s).toISOString(), label: String(h).padStart(2, '0') + ':00' });
  }
  return out;
}

function bookingView(id) {
  const b = db.prepare(`SELECT b.*, c.name category, c.icon, c.slug category_slug, cu.name customer_name, pu.name pro_name, pu.avatar pro_avatar,
    (SELECT rating FROM reviews WHERE booking_id=b.id) my_rating
    FROM bookings b JOIN categories c ON c.id=b.category_id JOIN users cu ON cu.id=b.customer_id LEFT JOIN users pu ON pu.id=b.pro_id WHERE b.id=?`).get(id);
  if (b) { b.photos = photosFor('booking', b.id); b.payout = b.price - b.commission + b.tip; }
  return b;
}
// What can user u see of booking b? Returns null if nothing.
function visibleBooking(b, u) {
  if (!b || !u) return null;
  if (u.role === 'admin' || b.customer_id === u.id) return b;
  if (u.role === 'pro') {
    const preAccept = b.status === 'open' || (b.status === 'assigned' && b.pro_id === u.id);
    if (b.pro_id === u.id && !preAccept) return b;
    if (preAccept && proDoesCategory(u.id, b.category_id)) return { ...b, address: b.district + ' (full address after accepting)', customer_name: b.customer_name.split(' ')[0] };
  }
  return null;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });
const need = (u, ...roles) => { if (!u) throw Object.assign(new Error('Please sign in'), { status: 401 }); if (roles.length && !roles.includes(u.role)) throw Object.assign(new Error('Not allowed'), { status: 403 }); };
const bad = (msg, status = 400) => { throw Object.assign(new Error(msg), { status }); };

// --- auth ---
route('POST', '/api/auth/request', async (req, res) => {
  const p = normPhone((await readBody(req)).phone); if (!p) bad('Enter a Kyrgyz number, e.g. 0700 123 456');
  const prev = db.prepare('SELECT sent_at FROM otps WHERE phone=?').get(p);
  if (prev && Date.now() - prev.sent_at < 30e3) bad('Please wait 30 seconds before requesting a new code', 429);
  const code = String(crypto.randomInt(100000, 999999));
  db.prepare('INSERT OR REPLACE INTO otps(phone,code,expires,attempts,sent_at) VALUES(?,?,?,0,?)').run(p, code, Date.now() + 5 * 60e3, Date.now());
  // TODO production: send via SMS gateway (e.g. Nikita.kg). Never return the code.
  send(res, 200, { ok: true, phone: p, exists: !!db.prepare('SELECT 1 FROM users WHERE phone=?').get(p), ...(DEV_OTP ? { dev_code: code } : {}) });
});
route('POST', '/api/auth/verify', async (req, res) => {
  const { phone, code, name, role } = await readBody(req);
  const p = normPhone(phone); const o = p && db.prepare('SELECT * FROM otps WHERE phone=?').get(p);
  if (!o || o.expires < Date.now() || o.attempts >= 5) bad('Code expired, request a new one');
  if (o.code !== String(code)) { db.prepare('UPDATE otps SET attempts=attempts+1 WHERE phone=?').run(p); bad('Wrong code'); }
  db.prepare('DELETE FROM otps WHERE phone=?').run(p);
  let u = db.prepare('SELECT * FROM users WHERE phone=?').get(p);
  if (!u) {
    const r = role === 'pro' ? 'pro' : 'customer';
    const id = db.prepare('INSERT INTO users(phone,name,role) VALUES(?,?,?)').run(p, clip(name, 60).trim() || 'User', r).lastInsertRowid;
    if (r === 'pro') { db.prepare('INSERT INTO pros(user_id) VALUES(?)').run(id); notifyAdmins('New pro signed up and needs verification', '#/admin/verify'); }
    u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, u.id, Date.now());
  send(res, 200, { token, user: u });
});
route('POST', '/api/auth/logout', (req, res, _, u) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run((req.headers.authorization || '').replace('Bearer ', ''));
  send(res, 200, { ok: true });
});
route('GET', '/api/me', (req, res, _, u) => {
  need(u);
  let pro = null;
  if (u.role === 'pro') {
    pro = db.prepare('SELECT * FROM pros WHERE user_id=?').get(u.id);
    pro.categories = db.prepare('SELECT category_id FROM pro_categories WHERE pro_id=?').all(u.id).map(r => r.category_id);
    pro.hours = proHours(pro);
    pro.portfolio = db.prepare("SELECT id, '/media/'||file url FROM photos WHERE owner_id=? AND kind='portfolio' ORDER BY id DESC").all(u.id);
    pro.has_id_photo = !!db.prepare("SELECT 1 FROM photos WHERE owner_id=? AND kind='id'").get(u.id);
    pro.has_selfie = !!db.prepare("SELECT 1 FROM photos WHERE owner_id=? AND kind='selfie'").get(u.id);
  }
  const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0').get(u.id).n;
  send(res, 200, { user: u, pro, stats: pro ? proStats(u.id) : null, unread });
});
route('PUT', '/api/me', async (req, res, _, u) => {
  need(u); const { name } = await readBody(req);
  if (name && String(name).trim()) db.prepare('UPDATE users SET name=? WHERE id=?').run(clip(name, 60).trim(), u.id);
  send(res, 200, { ok: true });
});

// --- uploads (JSON data URL; images only, magic-byte checked) ---
const MAGIC = [['jpg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff], ['png', b => b.slice(0, 4).toString('hex') === '89504e47'], ['webp', b => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP']];
const PRIVATE_KINDS = ['id', 'selfie'];
route('POST', '/api/uploads', async (req, res, _, u) => {
  need(u);
  const { kind, data } = await readBody(req, 6e6);
  const allowed = { avatar: ['customer', 'pro'], job: ['customer'], portfolio: ['pro'], id: ['pro'], selfie: ['pro'] }[kind];
  if (!allowed || !allowed.includes(u.role)) bad('Upload type not allowed');
  const buf = Buffer.from(String(data || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length || buf.length > 4e6) bad('Image must be under 4 MB');
  const ext = (MAGIC.find(([, t]) => t(buf)) || [])[0]; if (!ext) bad('Only JPEG, PNG or WebP images');
  if (kind === 'portfolio' && db.prepare("SELECT COUNT(*) n FROM photos WHERE owner_id=? AND kind='portfolio'").get(u.id).n >= 12) bad('Portfolio is limited to 12 photos');
  const file = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  const id = db.prepare('INSERT INTO photos(owner_id,kind,file) VALUES(?,?,?)').run(u.id, kind, file).lastInsertRowid;
  if (kind === 'avatar') db.prepare('UPDATE users SET avatar=? WHERE id=?').run('/media/' + file, u.id);
  if (PRIVATE_KINDS.includes(kind)) {
    db.prepare("UPDATE pros SET status='pending' WHERE user_id=? AND status='rejected'").run(u.id);
  }
  send(res, 201, { id, url: PRIVATE_KINDS.includes(kind) ? `/api/photos/${id}` : '/media/' + file });
});
route('DELETE', '/api/photos/:id', (req, res, { id }, u) => {
  need(u); const p = db.prepare('SELECT * FROM photos WHERE id=? AND owner_id=?').get(id, u.id); if (!p) bad('Not found', 404);
  db.prepare('DELETE FROM photos WHERE id=?').run(id); fs.rm(path.join(UPLOAD_DIR, p.file), () => {});
  send(res, 200, { ok: true });
});
// Private ID documents: only the owner or an admin, never via /media.
route('GET', '/api/photos/:id', (req, res, { id }, u) => {
  need(u); const p = db.prepare('SELECT * FROM photos WHERE id=?').get(id);
  if (!p || !(p.owner_id === u.id || u.role === 'admin')) bad('Not found', 404);
  res.writeHead(200, { 'Content-Type': 'image/' + (p.file.endsWith('png') ? 'png' : p.file.endsWith('webp') ? 'webp' : 'jpeg'), 'Cache-Control': 'private, no-store' });
  fs.createReadStream(path.join(UPLOAD_DIR, p.file)).pipe(res);
});

// --- catalog & pros ---
route('GET', '/api/catalog', (req, res) => {
  const cats = db.prepare('SELECT * FROM categories').all();
  for (const c of cats) {
    c.services = db.prepare('SELECT * FROM services WHERE category_id=?').all(c.id);
    c.pro_count = prosInCategory(c.id).length;
  }
  send(res, 200, { categories: cats, districts: DISTRICTS, config: CFG });
});
const proCard = id => {
  const p = db.prepare('SELECT u.id, u.name, u.avatar, p.bio, p.district FROM pros p JOIN users u ON u.id=p.user_id WHERE u.id=?').get(id);
  return Object.assign(p, proStats(id), { categories: db.prepare('SELECT category_id FROM pro_categories WHERE pro_id=?').all(id).map(r => r.category_id) });
};
route('GET', '/api/pros', (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams; const cat = q.get('category'); const district = q.get('district');
  const ids = db.prepare(`SELECT p.user_id id FROM pros p WHERE p.status='verified'
    ${cat ? 'AND p.user_id IN (SELECT pro_id FROM pro_categories WHERE category_id=?)' : ''}`).all(...(cat ? [cat] : []));
  const rows = ids.map(r => proCard(r.id));
  rows.sort((a, b) => (district ? (b.district === district) - (a.district === district) : 0) || (b.rating || 0) - (a.rating || 0) || b.jobs - a.jobs);
  send(res, 200, rows);
});
route('GET', '/api/pros/:id', (req, res, { id }, u) => {
  const pro = db.prepare("SELECT * FROM pros WHERE user_id=? AND status='verified'").get(id); if (!pro) bad('Not found', 404);
  const p = proCard(id);
  p.hours = proHours(pro);
  p.portfolio = db.prepare("SELECT id, '/media/'||file url FROM photos WHERE owner_id=? AND kind='portfolio' ORDER BY id DESC").all(id);
  p.is_favorite = !!(u && db.prepare('SELECT 1 FROM favorites WHERE customer_id=? AND pro_id=?').get(u.id, id));
  p.member_since = db.prepare('SELECT created_at FROM users WHERE id=?').get(id).created_at;
  p.reviews_list = db.prepare(`SELECT r.rating, r.body, r.created_at, u.name, b.title service FROM reviews r
    JOIN bookings b ON b.id=r.booking_id JOIN users u ON u.id=b.customer_id WHERE r.pro_id=? ORDER BY r.created_at DESC LIMIT 30`).all(id);
  send(res, 200, p);
});
route('GET', '/api/pros/:id/slots', (req, res, { id }) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const pro = db.prepare("SELECT * FROM pros WHERE user_id=? AND status='verified'").get(id); if (!pro) bad('Not found', 404);
  const svc = db.prepare('SELECT * FROM services WHERE id=?').get(q.get('service_id')); if (!svc) bad('Unknown service');
  const qty = Math.max(1, Math.min(500, parseInt(q.get('qty')) || 1));
  send(res, 200, { duration_min: durationFor(svc, qty), slots: slotsFor(pro, q.get('date'), durationFor(svc, qty)) });
});
route('POST', '/api/favorites/:id', (req, res, { id }, u) => {
  need(u, 'customer');
  const had = db.prepare('DELETE FROM favorites WHERE customer_id=? AND pro_id=?').run(u.id, id).changes;
  if (!had) db.prepare('INSERT OR IGNORE INTO favorites VALUES(?,?)').run(u.id, id);
  send(res, 200, { favorite: !had });
});
route('GET', '/api/favorites', (req, res, _, u) => {
  need(u, 'customer');
  // Favorites plus pros this customer completed a job with ("Your pros", like TaskRabbit).
  const ids = db.prepare(`SELECT pro_id id FROM favorites WHERE customer_id=? UNION
    SELECT DISTINCT pro_id FROM bookings WHERE customer_id=? AND status='completed'`).all(u.id, u.id);
  const fav = new Set(db.prepare('SELECT pro_id FROM favorites WHERE customer_id=?').all(u.id).map(r => r.pro_id));
  send(res, 200, ids.filter(r => db.prepare("SELECT 1 FROM pros WHERE user_id=? AND status='verified'").get(r.id)).map(r => ({ ...proCard(r.id), is_favorite: fav.has(r.id) })));
});

// --- bookings (fixed-price, Handy/TaskRabbit style) ---
route('POST', '/api/bookings', async (req, res, _, u) => {
  need(u, 'customer');
  const b = await readBody(req);
  const s = db.prepare('SELECT s.*, c.recurring FROM services s JOIN categories c ON c.id=s.category_id WHERE s.id=?').get(b.service_id); if (!s) bad('Unknown service');
  const qty = Math.max(1, Math.min(500, parseInt(b.qty) || 1));
  if (!String(b.address || '').trim() || !DISTRICTS.includes(b.district)) bad('Address and district are required');
  const start = Date.parse(b.scheduled_at); if (isNaN(start)) bad('Pick a time');
  if (start < Date.now() + (CFG.minLeadHours - 0.1) * 3600e3) bad(`Book at least ${CFG.minLeadHours} hours ahead`);
  const recurrence = RECURRENCE_DAYS[b.recurrence] && s.recurring ? b.recurrence : 'none';
  const duration = durationFor(s, qty);
  let proId = null;
  if (b.pro_id) {
    proId = Number(b.pro_id);
    if (!proDoesCategory(proId, s.category_id)) bad('This pro does not offer that service');
    const pro = db.prepare('SELECT * FROM pros WHERE user_id=?').get(proId);
    if (!withinHours(pro, start, duration) || !isFree(proId, start, duration)) bad('That time is no longer available. Please pick another slot.', 409);
  }
  const price = Math.round(s.price * qty * (recurrence !== 'none' ? 1 - CFG.recurringDiscount : 1));
  // payment='held': in production this is a card / Mbank / O!Dengi authorization hold, captured on completion.
  const id = db.prepare(`INSERT INTO bookings(customer_id,pro_id,service_id,category_id,title,unit,qty,duration_min,address,district,scheduled_at,notes,price,commission,recurrence,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(u.id, proId, s.id, s.category_id, s.name, s.unit, qty, duration, clip(b.address, 200), b.district,
    new Date(start).toISOString(), maskContacts(clip(b.notes, 500)), price, commissionFor(u.id, proId, price), recurrence, proId ? 'assigned' : 'open').lastInsertRowid;
  attachPhotos(b.photo_ids, u.id, 'booking', id);
  if (proId) notify(proId, `New booking request: ${s.name}`, '#/b/' + id);
  else prosInCategory(s.category_id).forEach(p => notify(p.id, `New job in ${b.district}: ${s.name}`, '#/b/' + id));
  send(res, 201, bookingView(id));
});
route('GET', '/api/bookings', (req, res, _, u) => {
  need(u);
  const sql = { customer: 'SELECT id FROM bookings WHERE customer_id=? ORDER BY scheduled_at DESC', pro: 'SELECT id FROM bookings WHERE pro_id=? ORDER BY scheduled_at DESC', admin: 'SELECT id FROM bookings WHERE ?>0 ORDER BY id DESC LIMIT 300' }[u.role];
  send(res, 200, db.prepare(sql).all(u.id).map(r => bookingView(r.id)));
});
route('GET', '/api/bookings/:id', (req, res, { id }, u) => {
  need(u); const v = visibleBooking(bookingView(id), u); if (!v) bad('Not found', 404); send(res, 200, v);
});
route('GET', '/api/jobs/open', (req, res, _, u) => {
  need(u, 'pro');
  if (db.prepare('SELECT status FROM pros WHERE user_id=?').get(u.id).status !== 'verified') return send(res, 200, []);
  const rows = db.prepare(`SELECT id FROM bookings WHERE (status='open' OR (status='assigned' AND pro_id=?))
    AND category_id IN (SELECT category_id FROM pro_categories WHERE pro_id=?) ORDER BY scheduled_at`).all(u.id, u.id);
  send(res, 200, rows.map(r => visibleBooking(bookingView(r.id), u)).filter(Boolean));
});

route('POST', '/api/bookings/:id/(?<action>(?!messages$)[^/]+)', async (req, res, { id, action }, u) => {
  need(u);
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id); if (!b) bad('Not found', 404);
  const isCust = b.customer_id === u.id, isMyJob = u.role === 'pro' && b.pro_id === u.id, isAdmin = u.role === 'admin';
  const set = f => { const k = Object.keys(f); db.prepare(`UPDATE bookings SET ${k.map(x => x + '=?').join(',')} WHERE id=?`).run(...k.map(x => f[x]), id); };
  const data = await readBody(req).catch(() => ({}));
  const link = '#/b/' + id;
  const requireState = (ok, ...states) => { if (!ok || !states.includes(b.status)) bad('This action is not available right now', 403); };
  switch (action) {
    case 'accept': {
      need(u, 'pro');
      if (!proDoesCategory(u.id, b.category_id)) bad('You are not verified for this category', 403);
      if (!isFree(u.id, Date.parse(b.scheduled_at), b.duration_min, b.id)) bad('You already have a job at this time', 409);
      // Atomic claim so two pros cannot accept the same job.
      const r = db.prepare("UPDATE bookings SET status='accepted', pro_id=? WHERE id=? AND (status='open' OR (status='assigned' AND pro_id=?))").run(u.id, id, u.id);
      if (!r.changes) bad('Job already taken', 409);
      const c = commissionFor(b.customer_id, u.id, b.price); if (!b.request_id) set({ commission: c });
      notify(b.customer_id, `${u.name} accepted your booking: ${b.title}`, link);
      break;
    }
    case 'decline':
      requireState(isMyJob, 'assigned');
      set({ status: 'open', pro_id: null });
      notify(b.customer_id, `${u.name} can't make it, so we're finding you another verified pro`, link);
      prosInCategory(b.category_id).filter(p => p.id !== u.id).forEach(p => notify(p.id, `New job in ${b.district}: ${b.title}`, link));
      break;
    case 'release': // pro backs out of an accepted job; it goes back to the marketplace
      requireState(isMyJob, 'accepted');
      set({ status: 'open', pro_id: null });
      notify(b.customer_id, `Your pro cancelled, so we're finding you another verified pro for ${b.title}`, link);
      prosInCategory(b.category_id).filter(p => p.id !== u.id).forEach(p => notify(p.id, `New job in ${b.district}: ${b.title}`, link));
      break;
    case 'start':
      requireState(isMyJob, 'accepted'); set({ status: 'in_progress' });
      notify(b.customer_id, `${u.name} has arrived and started the job`, link); break;
    case 'finish':
      requireState(isMyJob, 'in_progress'); set({ status: 'awaiting_confirmation' });
      notify(b.customer_id, `${u.name} marked the job as done. Please confirm and release payment.`, link); break;
    case 'confirm': { // customer confirms (or admin resolves a dispute) -> money released, warranty starts
      requireState(isCust || isAdmin, 'awaiting_confirmation', 'disputed');
      const tip = isCust ? Math.max(0, Math.min(b.price, parseInt(data.tip) || 0)) : b.tip;
      const w = new Date(Date.now() + CFG.warrantyDays * 864e5).toISOString().slice(0, 10);
      set({ status: 'completed', payment: 'released', tip, completed_at: new Date().toISOString(), warranty_until: w });
      db.prepare('UPDATE pros SET balance=balance+? WHERE user_id=?').run(b.price - b.commission + tip, b.pro_id);
      notify(b.pro_id, `Payment released: ${b.price - b.commission + tip} som${tip ? ` (includes a ${tip} som tip)` : ''}`, '#/earnings');
      if (b.recurrence !== 'none' && b.status === 'awaiting_confirmation') {
        const next = new Date(Date.parse(b.scheduled_at) + RECURRENCE_DAYS[b.recurrence] * 864e5).toISOString();
        const nid = db.prepare(`INSERT INTO bookings(customer_id,pro_id,service_id,category_id,title,unit,qty,duration_min,address,district,scheduled_at,notes,price,commission,recurrence,parent_id,status)
          SELECT customer_id,pro_id,service_id,category_id,title,unit,qty,duration_min,address,district,?,notes,price,?,recurrence,id,'assigned' FROM bookings WHERE id=?`)
          .run(next, Math.round(b.price * CFG.commissionRepeat), id).lastInsertRowid;
        notify(b.pro_id, `Next recurring visit booked: ${b.title}`, '#/b/' + nid);
        notify(b.customer_id, `Your next ${b.recurrence} visit is scheduled`, '#/b/' + nid);
      }
      break;
    }
    case 'dispute': {
      requireState(isCust, 'awaiting_confirmation', 'completed');
      if (b.status === 'completed' && b.warranty_until < new Date().toISOString().slice(0, 10)) bad('The warranty has expired');
      set({ status: 'disputed' });
      db.prepare('INSERT INTO messages(booking_id,sender_id,body) VALUES(?,?,?)').run(id, u.id, 'PROBLEM REPORTED: ' + maskContacts(clip(data.reason || 'No reason given', 500)));
      notify(b.pro_id, `The client reported a problem with ${b.title}`, link);
      notifyAdmins(`Dispute opened on booking #${id}`, link);
      break;
    }
    case 'cancel': {
      requireState(isCust || isAdmin, 'open', 'assigned', 'accepted');
      const late = b.status === 'accepted' && Date.parse(b.scheduled_at) - Date.now() < CFG.lateCancelHours * 3600e3 && !isAdmin;
      const fee = late ? Math.round(b.price * CFG.lateCancelFee) : 0;
      set({ status: 'cancelled', payment: fee ? 'partial_refund' : 'refunded', cancel_fee: fee });
      if (fee) db.prepare('UPDATE pros SET balance=balance+? WHERE user_id=?').run(fee, b.pro_id);
      if (b.pro_id) notify(b.pro_id, `Booking cancelled: ${b.title}${fee ? `. You receive a ${fee} som late-cancellation fee.` : ''}`, link);
      break;
    }
    case 'refund': // admin resolves dispute in the customer's favour
      requireState(isAdmin, 'disputed');
      if (b.payment === 'released') db.prepare('UPDATE pros SET balance=balance-? WHERE user_id=?').run(b.price - b.commission + b.tip, b.pro_id);
      set({ status: 'refunded', payment: 'refunded' });
      notify(b.customer_id, `You've been refunded for ${b.title}`, link); notify(b.pro_id, `Dispute resolved in the client's favour: ${b.title}`, link);
      break;
    case 'review': {
      requireState(isCust, 'completed');
      const rating = parseInt(data.rating); if (!(rating >= 1 && rating <= 5)) bad('Rating must be 1–5');
      db.prepare('INSERT OR REPLACE INTO reviews(booking_id,pro_id,rating,body) VALUES(?,?,?,?)').run(id, b.pro_id, rating, maskContacts(clip(data.body, 1000)));
      notify(b.pro_id, `New ${rating}★ review from ${u.name}`, '#/profile');
      break;
    }
    case 'stop-recurring':
      requireState(isCust, 'assigned', 'accepted', 'completed', 'open');
      db.prepare("UPDATE bookings SET recurrence='none' WHERE id=? OR parent_id=?").run(id, id); break;
    default: bad('Unknown action', 404);
  }
  send(res, 200, visibleBooking(bookingView(id), u) || { ok: true });
});
route('GET', '/api/bookings/:id/messages', (req, res, { id }, u) => {
  need(u); const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!b || !(b.customer_id === u.id || (b.pro_id === u.id && u.role === 'pro') || u.role === 'admin')) bad('Not allowed', 403);
  send(res, 200, db.prepare('SELECT m.*, u.name FROM messages m JOIN users u ON u.id=m.sender_id WHERE booking_id=? ORDER BY m.id').all(id));
});
route('POST', '/api/bookings/:id/messages', async (req, res, { id }, u) => {
  need(u); const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!b || !(b.customer_id === u.id || (b.pro_id === u.id && u.role === 'pro'))) bad('Not allowed', 403);
  const { text } = await readBody(req); if (!String(text || '').trim()) bad('Empty message');
  db.prepare('INSERT INTO messages(booking_id,sender_id,body) VALUES(?,?,?)').run(id, u.id, maskContacts(clip(text, 1000)));
  const other = b.customer_id === u.id ? b.pro_id : b.customer_id;
  const recent = db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND link=? AND read=0 AND body LIKE 'New message%'").get(other, '#/b/' + id);
  if (!recent) notify(other, `New message from ${u.name}`, '#/b/' + id);
  send(res, 201, { ok: true });
});

// --- quote requests (Thumbtack style) for jobs without a fixed price ---
route('POST', '/api/requests', async (req, res, _, u) => {
  need(u, 'customer'); const d = await readBody(req);
  const cat = db.prepare('SELECT * FROM categories WHERE id=?').get(d.category_id); if (!cat) bad('Pick a category');
  if (String(d.title || '').trim().length < 3 || String(d.description || '').trim().length < 10) bad('Add a title and describe the job (at least 10 characters)');
  if (!DISTRICTS.includes(d.district) || !String(d.address || '').trim()) bad('Address and district are required');
  const pref = Date.parse(d.preferred_at); if (isNaN(pref) || pref < Date.now()) bad('Pick a preferred date in the future');
  const id = db.prepare('INSERT INTO requests(customer_id,category_id,title,description,district,address,preferred_at) VALUES(?,?,?,?,?,?,?)')
    .run(u.id, cat.id, maskContacts(clip(d.title, 100)), maskContacts(clip(d.description, 2000)), d.district, clip(d.address, 200), new Date(pref).toISOString()).lastInsertRowid;
  attachPhotos(d.photo_ids, u.id, 'request', id);
  prosInCategory(cat.id).forEach(p => notify(p.id, `New lead in ${d.district}: ${clip(d.title, 60)}`, '#/r/' + id));
  send(res, 201, { id });
});
const requestView = (id, u) => {
  const r = db.prepare('SELECT r.*, c.name category, c.icon, u.name customer_name FROM requests r JOIN categories c ON c.id=r.category_id JOIN users u ON u.id=r.customer_id WHERE r.id=?').get(id);
  if (!r) return null;
  r.photos = photosFor('request', id);
  r.quote_count = db.prepare('SELECT COUNT(*) n FROM quotes WHERE request_id=?').get(id).n;
  if (u.role === 'admin' || r.customer_id === u.id) {
    r.quotes = db.prepare('SELECT q.* FROM quotes q WHERE request_id=? ORDER BY price').all(id).map(q => ({ ...q, pro: proCard(q.pro_id) }));
    return r;
  }
  if (u.role === 'pro' && proDoesCategory(u.id, r.category_id)) {
    r.my_quote = db.prepare('SELECT * FROM quotes WHERE request_id=? AND pro_id=?').get(id, u.id) || null;
    const won = r.my_quote && r.my_quote.status === 'accepted';
    if (!won) r.address = r.district + ' (full address after you are hired)';
    r.customer_name = r.customer_name.split(' ')[0];
    if (r.status !== 'open' && !r.my_quote) return null;
    return r;
  }
  return null;
};
route('GET', '/api/requests', (req, res, _, u) => {
  need(u);
  let ids;
  if (u.role === 'customer') ids = db.prepare('SELECT id FROM requests WHERE customer_id=? ORDER BY id DESC').all(u.id);
  else if (u.role === 'pro') ids = db.prepare(`SELECT id FROM requests WHERE category_id IN (SELECT category_id FROM pro_categories WHERE pro_id=?)
      AND (status='open' OR id IN (SELECT request_id FROM quotes WHERE pro_id=?)) ORDER BY id DESC LIMIT 100`).all(u.id, u.id);
  else ids = db.prepare('SELECT id FROM requests ORDER BY id DESC LIMIT 200').all();
  if (u.role === 'pro' && db.prepare('SELECT status FROM pros WHERE user_id=?').get(u.id).status !== 'verified') ids = [];
  send(res, 200, ids.map(r => requestView(r.id, u)).filter(Boolean));
});
route('GET', '/api/requests/:id', (req, res, { id }, u) => {
  need(u); const r = requestView(id, u); if (!r) bad('Not found', 404); send(res, 200, r);
});
route('POST', '/api/requests/:id/quotes', async (req, res, { id }, u) => {
  need(u, 'pro'); const d = await readBody(req);
  const r = db.prepare('SELECT * FROM requests WHERE id=?').get(id); if (!r || r.status !== 'open') bad('This request is no longer open');
  if (!proDoesCategory(u.id, r.category_id)) bad('You are not verified for this category', 403);
  const price = parseInt(d.price); if (!(price >= 100 && price <= 1e7)) bad('Enter a price in som');
  const existing = db.prepare('SELECT * FROM quotes WHERE request_id=? AND pro_id=?').get(id, u.id);
  if (existing && existing.status !== 'pending') bad('Quote can no longer be changed');
  db.prepare(`INSERT INTO quotes(request_id,pro_id,price,message) VALUES(?,?,?,?)
    ON CONFLICT(request_id,pro_id) DO UPDATE SET price=excluded.price, message=excluded.message`).run(id, u.id, price, maskContacts(clip(d.message, 1000)));
  notify(r.customer_id, `${existing ? 'Updated quote' : 'New quote'} from ${u.name}: ${price} som`, '#/r/' + id);
  send(res, 201, requestView(id, u));
});
route('POST', '/api/requests/:id/hire', async (req, res, { id }, u) => {
  need(u, 'customer'); const { quote_id } = await readBody(req);
  const r = db.prepare('SELECT * FROM requests WHERE id=? AND customer_id=?').get(id, u.id); if (!r) bad('Not found', 404);
  if (r.status !== 'open') bad('You already hired someone for this request');
  const q = db.prepare("SELECT * FROM quotes WHERE id=? AND request_id=? AND status='pending'").get(quote_id, id); if (!q) bad('Quote not found');
  const bid = db.prepare(`INSERT INTO bookings(customer_id,pro_id,category_id,title,unit,qty,duration_min,address,district,scheduled_at,notes,price,commission,request_id,status)
    VALUES(?,?,?,?,'quoted job',1,120,?,?,?,?,?,?,?,'accepted')`).run(u.id, q.pro_id, r.category_id, r.title, r.address, r.district, r.preferred_at, r.description, q.price, commissionFor(u.id, q.pro_id, q.price), id).lastInsertRowid;
  db.prepare("UPDATE photos SET ref_type='booking', ref_id=? WHERE ref_type='request' AND ref_id=?").run(bid, id);
  db.prepare("UPDATE requests SET status='hired', booking_id=? WHERE id=?").run(bid, id);
  db.prepare("UPDATE quotes SET status=CASE WHEN id=? THEN 'accepted' ELSE 'declined' END WHERE request_id=?").run(q.id, id);
  notify(q.pro_id, `You're hired! ${r.title}: ${q.price} som. The payment is held.`, '#/b/' + bid);
  db.prepare("SELECT pro_id FROM quotes WHERE request_id=? AND status='declined'").all(id).forEach(x => notify(x.pro_id, `The client hired someone else for "${r.title}"`, '#/r/' + id));
  send(res, 201, bookingView(bid));
});
route('POST', '/api/requests/:id/close', (req, res, { id }, u) => {
  need(u, 'customer');
  if (!db.prepare("UPDATE requests SET status='closed' WHERE id=? AND customer_id=? AND status='open'").run(id, u.id).changes) bad('Cannot close');
  db.prepare("UPDATE quotes SET status='declined' WHERE request_id=?").run(id);
  send(res, 200, { ok: true });
});

// --- pro profile, availability, earnings ---
route('PUT', '/api/pro/profile', async (req, res, _, u) => {
  need(u, 'pro'); const d = await readBody(req);
  if (d.name && String(d.name).trim()) db.prepare('UPDATE users SET name=? WHERE id=?').run(clip(d.name, 60).trim(), u.id);
  let hours = null;
  if (d.hours && typeof d.hours === 'object') {
    hours = {};
    for (const [k, v] of Object.entries(d.hours)) if (/^[0-6]$/.test(k) && Array.isArray(v) && v[0] >= 0 && v[1] <= 24 && v[0] < v[1]) hours[k] = [Number(v[0]), Number(v[1])];
  }
  db.prepare(`UPDATE pros SET bio=?, district=?, id_note=?, hours=COALESCE(?,hours),
    status=CASE WHEN status='rejected' THEN 'pending' ELSE status END WHERE user_id=?`)
    .run(maskContacts(clip(d.bio, 600)), DISTRICTS.includes(d.district) ? d.district : null, clip(d.id_note, 60), hours && JSON.stringify(hours), u.id);
  if (Array.isArray(d.categories)) {
    db.prepare('DELETE FROM pro_categories WHERE pro_id=?').run(u.id);
    for (const c of d.categories.slice(0, 10)) db.prepare('INSERT OR IGNORE INTO pro_categories SELECT ?, id FROM categories WHERE id=?').run(u.id, c);
  }
  send(res, 200, { ok: true });
});
route('GET', '/api/pro/earnings', (req, res, _, u) => {
  need(u, 'pro');
  const jobs = db.prepare(`SELECT id, title, completed_at, price, commission, tip, price-commission+tip payout FROM bookings
    WHERE pro_id=? AND status='completed' ORDER BY completed_at DESC LIMIT 100`).all(u.id);
  const fees = db.prepare("SELECT id, title, scheduled_at, cancel_fee FROM bookings WHERE pro_id=? AND cancel_fee>0").all(u.id);
  const payouts = db.prepare('SELECT * FROM payouts WHERE pro_id=? ORDER BY id DESC').all(u.id);
  const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);
  const week = jobs.filter(j => Date.parse(j.completed_at) > Date.now() - 7 * 864e5);
  send(res, 200, {
    balance: db.prepare('SELECT balance FROM pros WHERE user_id=?').get(u.id).balance,
    total: sum(jobs, 'payout') + sum(fees, 'cancel_fee'), week: sum(week, 'payout'), tips: sum(jobs, 'tip'), commission: sum(jobs, 'commission'),
    jobs, fees, payouts,
    upcoming: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(price-commission),0) amount FROM bookings WHERE pro_id=? AND status IN ('accepted','in_progress','awaiting_confirmation')`).get(u.id),
  });
});
route('POST', '/api/pro/payout', (req, res, _, u) => {
  need(u, 'pro');
  const p = db.prepare('SELECT balance FROM pros WHERE user_id=?').get(u.id);
  if (p.balance <= 0) bad('Nothing to withdraw');
  db.prepare('INSERT INTO payouts(pro_id,amount) VALUES(?,?)').run(u.id, p.balance);
  db.prepare('UPDATE pros SET balance=0 WHERE user_id=?').run(u.id);
  send(res, 200, { ok: true, amount: p.balance });
});

// --- notifications ---
route('GET', '/api/notifications', (req, res, _, u) => {
  need(u);
  send(res, 200, db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(u.id));
});
route('POST', '/api/notifications/read', (req, res, _, u) => {
  need(u); db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(u.id); send(res, 200, { ok: true });
});

// --- admin ---
route('GET', '/api/admin/stats', (req, res, _, u) => {
  need(u, 'admin');
  const b = db.prepare(`SELECT COUNT(*) total, SUM(status='completed') completed,
    COALESCE(SUM(CASE WHEN status='completed' THEN price END),0) gmv, COALESCE(SUM(CASE WHEN status='completed' THEN commission END),0) revenue,
    SUM(status='disputed') disputes, SUM(status IN ('open','assigned')) unassigned, SUM(status IN ('accepted','in_progress','awaiting_confirmation')) active,
    SUM(status='cancelled') cancelled FROM bookings`).get();
  const repeat = db.prepare(`SELECT COUNT(*) n FROM (SELECT customer_id, pro_id FROM bookings WHERE status='completed' GROUP BY customer_id, pro_id HAVING COUNT(*)>1)`).get().n;
  const byCat = db.prepare(`SELECT c.icon, c.name, COUNT(b.id) bookings, COALESCE(SUM(CASE WHEN b.status='completed' THEN b.price END),0) gmv
    FROM categories c LEFT JOIN bookings b ON b.category_id=c.id GROUP BY c.id ORDER BY gmv DESC`).all();
  send(res, 200, {
    bookings: b, repeat_pairs: repeat, by_category: byCat,
    pros: db.prepare("SELECT SUM(status='verified') verified, SUM(status='pending') pending FROM pros").get(),
    customers: db.prepare("SELECT COUNT(*) n FROM users WHERE role='customer'").get().n,
    open_requests: db.prepare("SELECT COUNT(*) n FROM requests WHERE status='open'").get().n,
    payouts_pending: db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payouts WHERE status='requested'").get().n,
  });
});
route('GET', '/api/admin/pros', (req, res, _, u) => {
  need(u, 'admin');
  const rows = db.prepare(`SELECT u.id, u.name, u.phone, u.avatar, p.*, (SELECT GROUP_CONCAT(c.name, ', ') FROM pro_categories pc JOIN categories c ON c.id=pc.category_id WHERE pc.pro_id=u.id) cats
    FROM pros p JOIN users u ON u.id=p.user_id ORDER BY p.status='pending' DESC, u.id DESC`).all();
  for (const r of rows) {
    r.id_photo = db.prepare("SELECT id FROM photos WHERE owner_id=? AND kind='id' ORDER BY id DESC").get(r.id)?.id || null;
    r.selfie = db.prepare("SELECT id FROM photos WHERE owner_id=? AND kind='selfie' ORDER BY id DESC").get(r.id)?.id || null;
    Object.assign(r, proStats(r.id));
  }
  send(res, 200, rows);
});
route('POST', '/api/admin/pros/:id/:decision', (req, res, { id, decision }, u) => {
  need(u, 'admin');
  if (!['verified', 'rejected'].includes(decision)) bad('Bad decision');
  db.prepare('UPDATE pros SET status=? WHERE user_id=?').run(decision, id);
  notify(Number(id), decision === 'verified' ? '🎉 You are verified! You can now accept jobs.' : 'Verification was rejected. Please check your ID photos and try again.', decision === 'verified' ? '#/jobs' : '#/profile');
  send(res, 200, { ok: true });
});
route('POST', '/api/admin/payouts/:id/paid', (req, res, { id }, u) => {
  need(u, 'admin'); db.prepare("UPDATE payouts SET status='paid' WHERE id=?").run(id); send(res, 200, { ok: true });
});
route('GET', '/api/admin/payouts', (req, res, _, u) => {
  need(u, 'admin');
  send(res, 200, db.prepare('SELECT p.*, u.name, u.phone FROM payouts p JOIN users u ON u.id=p.pro_id ORDER BY p.status, p.id DESC').all());
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const PUB = path.join(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (url.pathname.startsWith('/api/')) {
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (m) {
        try { return await r.handler(req, res, m.groups || {}, auth(req)); }
        catch (e) { if (!e.status) console.error(e); return fail(res, e.status || 500, e.status ? e.message : 'Server error'); }
      }
    }
    return fail(res, 404, 'Not found');
  }
  if (url.pathname.startsWith('/media/')) {
    const file = path.basename(url.pathname);
    const p = db.prepare('SELECT kind FROM photos WHERE file=?').get(file);
    if (!p || PRIVATE_KINDS.includes(p.kind)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
    return fs.createReadStream(path.join(UPLOAD_DIR, file)).on('error', () => res.end()).pipe(res);
  }
  let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});
if (require.main === module) server.listen(PORT, () => console.log(`Usta running on http://localhost:${PORT}`));
module.exports = { server, db, maskContacts, normPhone, CFG };
