// End-to-end API tests: node --test test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usta-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.SMS_PROVIDER = 'console'; process.env.PAYMENT_PROVIDER = 'mock';
const origLog = console.log; console.log = (...a) => { if (!String(a[0]).startsWith('[sms')) origLog(...a); };
const { server, db, maskContacts, normPhone, expireUnpaid, CFG } = require('./server');
CFG.otp.perIpHour = 1000; // every test login comes from one IP
const { createSms } = require('./lib/sms');
const { tr, RU } = require('./lib/i18n');

let base, root;
test.before(() => new Promise(r => server.listen(0, () => { root = `http://localhost:${server.address().port}`; base = root + '/api'; r(); })));
test.after(() => server.close());
const call = async (p, { token, method = 'GET', body, lang } = {}) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(lang ? { 'X-Lang': lang } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let n = 0;
const login = async (phone, role = 'customer', name = 'Test', lang = 'en') => {
  phone ||= '0701' + String(100000 + ++n);
  const { data } = await call('/auth/request', { method: 'POST', body: { phone } });
  return (await call('/auth/verify', { method: 'POST', body: { phone, code: data.dev_code, role, name, lang } })).data.token;
};
const me = async t => (await call('/me', { token: t })).data;
const payId = url => url.match(/\/pay\/mock\/(\d+)/)[1];
const mockPay = (url, result = 'succeed') => fetch(`${base}/payments/mock/${payId(url)}/${result}`, { method: 'POST' }).then(r => r.json());
// create a booking and pay for it
const book = async (token, body) => { const r = await call('/bookings', { token, method: 'POST', body }); assert.equal(r.status, 201, JSON.stringify(r.data)); await mockPay(r.data.pay_url); return (await call('/bookings/' + r.data.id, { token })).data; };
const hoursAhead = h => new Date(Date.now() + h * 3600e3).toISOString();
const bishkekDate = days => { let d = new Date(Date.now() + 6 * 3600e3 + days * 864e5); while (d.getUTCDay() === 0) d = new Date(+d + 864e5); return d.toISOString().slice(0, 10); };
let cat;
const svc = (slug, i = 0) => cat.categories.find(c => c.slug === slug).services[i];
const PRO = { plumber: '0700111111', electrician: '0700222222', cleaner: '0700333333', appliances: '0700444444' };

test('catalog + helpers', async () => {
  cat = (await call('/catalog')).data;
  assert.ok(cat.categories.length >= 6);
  assert.equal(cat.categories.find(c => c.slug === 'plumbing').name_ru, 'Сантехника');
  assert.equal(normPhone('0700 123 456'), '+996700123456');
  assert.equal(normPhone('12'), null);
  assert.equal(maskContacts('call 0555 12 34 56, @aza_plumber, t.me/aza, whatsapp me'), 'call [contact hidden], [contact hidden], [contact hidden] [contact hidden] me');
});

test('i18n: every server message and notification has a Russian translation', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const keys = new Set();
  for (const m of src.matchAll(/\b(?:bad|notify|notifyAdmins)\((?:[^,'"]+,\s*)?(['"])((?:\\.|(?!\1).)+)\1/g)) keys.add(m[2].replace(/\\(['"])/g, '$1'));
  for (const m of src.matchAll(/\?\s*(['"])((?:\\.|(?!\1).)+)\1\s*:\s*(['"])((?:\\.|(?!\3).)+)\3/g)) { if (/[a-z] [a-z]/i.test(m[2]) && /[{]|[a-z] /.test(m[4])) { keys.add(m[2]); keys.add(m[4]); } }
  const missing = [...keys].filter(k => /[a-z]{2}/i.test(k) && !(k in RU));
  assert.deepEqual(missing, []);
  assert.equal(tr('ru', 'New job in {0}: {1}', ['Leninsky', 'Fix leaking tap']), 'Новый заказ (Ленинский р-н): Ремонт протекающего крана');
  assert.equal(tr('en', 'New job in {0}: {1}', ['Leninsky', 'Fix leaking tap']), 'New job in Leninsky: Fix leaking tap');
});

test('auth: hashed codes, wrong code, throttles, translated errors', async () => {
  await call('/auth/request', { method: 'POST', body: { phone: '0701999001' } });
  const row = db.prepare("SELECT * FROM otp_codes WHERE phone='+996701999001'").get();
  assert.ok(row.hash && row.hash.length === 64 && !('code' in row), 'OTP must be stored hashed');
  const again = await call('/auth/request', { method: 'POST', body: { phone: '0701999001' }, lang: 'ru' });
  assert.equal(again.status, 429); assert.match(again.data.error, /Подождите/);
  assert.equal((await call('/auth/verify', { method: 'POST', body: { phone: '0701999001', code: '000000' } })).status, 400);
  // per-phone hourly cap
  db.prepare("UPDATE otp_codes SET sent_at=0 WHERE phone='+996701999001'").run();
  for (let i = 0; i < 4; i++) db.prepare("INSERT INTO otp_log VALUES('+996701999001','x',?)").run(Date.now());
  assert.equal((await call('/auth/request', { method: 'POST', body: { phone: '0701999001' } })).status, 429);
});

test('sms providers: twilio and nikita send the right requests', async () => {
  const calls = []; const fake = (status, body) => async (url, opts) => { calls.push({ url, opts }); return { ok: status < 300, status, text: async () => body }; };
  const tw = createSms({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1555' }, fake(201, '{}'));
  await tw.send('+996700123456', 'Код Usta: 123456');
  assert.match(calls[0].url, /Accounts\/AC1\/Messages\.json$/);
  assert.equal(calls[0].opts.body.get('To'), '+996700123456');
  assert.match(calls[0].opts.headers.Authorization, /^Basic /);
  const nk = createSms({ SMS_PROVIDER: 'nikita', NIKITA_LOGIN: 'l', NIKITA_PASSWORD: 'p&q', NIKITA_SENDER: 'Usta' }, fake(200, '<response><status>0</status></response>'));
  await nk.send('+996700123456', 'Код <1>');
  assert.match(calls[1].opts.body, /<phone>996700123456<\/phone>/); assert.match(calls[1].opts.body, /<pwd>p&amp;q<\/pwd>/); assert.match(calls[1].opts.body, /Код &lt;1&gt;/);
  const nkBad = createSms({ SMS_PROVIDER: 'nikita', NIKITA_LOGIN: 'l', NIKITA_PASSWORD: 'p', NIKITA_SENDER: 'U' }, fake(200, '<response><status>2</status></response>'));
  await assert.rejects(nkBad.send('+996700123456', 'x'), /status 2/);
  assert.throws(() => createSms({ SMS_PROVIDER: 'twilio' }), /TWILIO_ACCOUNT_SID/);
});

test('payments: unpaid bookings are hidden from pros, failed payment, idempotent webhook, expiry frees the slot', async () => {
  const cust = await login(); const pro = await login(PRO.electrician);
  const proId = (await me(pro)).user.id; const s = svc('electrical');
  const date = bishkekDate(6);
  const slot = (await call(`/pros/${proId}/slots?service_id=${s.id}&qty=1&date=${date}`)).data.slots[0];
  const r = await call('/bookings', { token: cust, method: 'POST', body: { service_id: s.id, pro_id: proId, address: 'A', district: 'Leninsky', scheduled_at: slot.at } });
  assert.equal(r.data.status, 'unpaid'); assert.match(r.data.pay_url, /^\/pay\/mock\/\d+$/);
  assert.equal((await call('/bookings/' + r.data.id, { token: pro })).status, 404, 'pro must not see unpaid booking');
  assert.ok(!(await call(`/pros/${proId}/slots?service_id=${s.id}&qty=1&date=${date}`)).data.slots.some(x => x.at === slot.at), 'slot reserved while paying');
  assert.equal((await fetch(root + r.data.pay_url)).status, 200, 'mock checkout page renders');
  await mockPay(r.data.pay_url, 'fail');
  assert.equal((await call('/bookings/' + r.data.id, { token: cust })).data.status, 'unpaid');
  const retry = (await call(`/bookings/${r.data.id}/pay`, { token: cust, method: 'POST' })).data.pay_url;
  assert.notEqual(retry, r.data.pay_url);
  await mockPay(retry); await mockPay(retry); // duplicate delivery
  const paid = (await call('/bookings/' + r.data.id, { token: cust })).data;
  assert.equal(paid.status, 'assigned'); assert.equal(paid.payment, 'held');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payments WHERE booking_id=? AND status='paid'").get(r.data.id).n, 1);
  assert.equal((await call('/bookings/' + r.data.id, { token: pro })).status, 200);

  // expiry: an unpaid booking past its deadline is cancelled and its slot frees up; a late payment is refunded
  const r2 = await call('/bookings', { token: cust, method: 'POST', body: { service_id: s.id, pro_id: proId, address: 'A', district: 'Leninsky', scheduled_at: (await call(`/pros/${proId}/slots?service_id=${s.id}&qty=1&date=${date}`)).data.slots[0].at } });
  db.prepare('UPDATE bookings SET pay_by=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), r2.data.id);
  assert.equal(expireUnpaid(), 1);
  await mockPay(r2.data.pay_url);
  const late = db.prepare("SELECT * FROM payments WHERE booking_id=? AND status='paid'").get(r2.data.id);
  assert.equal(late.refund_status, 'refunded'); assert.equal(late.refunded_amount, late.amount);
  assert.equal((await call('/bookings/' + r2.data.id, { token: cust })).data.status, 'cancelled');
});

test('full lifecycle: open job, escrow, chat masking, tip payment, review, repeat discount, warranty refund', async () => {
  const cust = await login(); const pro = await login(PRO.plumber); const other = await login(PRO.appliances); const admin = await login('0700000000');
  const tap = svc('plumbing');
  const b = await book(cust, { service_id: tap.id, qty: 2, address: 'Chui 100, apt 5', district: 'Leninsky', scheduled_at: hoursAhead(30) });
  assert.equal(b.price, tap.price * 2); assert.equal(b.status, 'open');
  const id = b.id;
  assert.ok(!(await call('/jobs/open', { token: other })).data.some(j => j.id === id));
  const feed = (await call('/jobs/open', { token: pro })).data.find(j => j.id === id);
  assert.ok(feed && feed.address_hidden && !feed.address.includes('Chui'));
  assert.ok((await me(pro)).unread > 0);
  assert.equal((await call(`/bookings/${id}/accept`, { token: pro, method: 'POST' })).status, 200);
  assert.equal((await call(`/bookings/${id}/accept`, { token: other, method: 'POST' })).status, 403);
  assert.ok((await call(`/bookings/${id}`, { token: pro })).data.address.includes('Chui'));
  await call(`/bookings/${id}/messages`, { token: pro, method: 'POST', body: { text: 'Next time call me on 0555 123 456' } });
  assert.ok((await call(`/bookings/${id}/messages`, { token: cust })).data[0].body.includes('[contact hidden]'));
  for (const a of ['start', 'finish']) assert.equal((await call(`/bookings/${id}/${a}`, { token: pro, method: 'POST' })).status, 200);
  const before = (await me(pro)).pro.balance;
  const done = (await call(`/bookings/${id}/confirm`, { token: cust, method: 'POST', body: { tip: 200 } })).data;
  assert.equal(done.status, 'completed'); assert.ok(done.tip_pay_url, 'tip is a separate payment');
  assert.equal((await me(pro)).pro.balance - before, b.price - b.commission);
  await mockPay(done.tip_pay_url);
  assert.equal((await me(pro)).pro.balance - before, b.price - b.commission + 200);
  assert.equal((await call(`/bookings/${id}`, { token: cust })).data.tip, 200);
  assert.equal((await call(`/bookings/${id}/review`, { token: cust, method: 'POST', body: { rating: 5, body: 'Great' } })).status, 200);

  const proId = (await me(pro)).user.id;
  const slots = (await call(`/pros/${proId}/slots?service_id=${tap.id}&qty=1&date=${bishkekDate(3)}`)).data.slots;
  const rep = await book(cust, { service_id: tap.id, pro_id: proId, address: 'Chui 100', district: 'Leninsky', scheduled_at: slots[0].at });
  assert.equal(rep.status, 'assigned'); assert.equal(rep.commission, Math.round(tap.price * 0.05));

  const bal = (await me(pro)).pro.balance;
  assert.equal((await call(`/bookings/${id}/dispute`, { token: cust, method: 'POST', body: { reason: 'Leaking again' } })).data.status, 'disputed');
  assert.equal((await call(`/bookings/${id}/refund`, { token: admin, method: 'POST' })).data.payment, 'refunded');
  assert.equal(bal - (await me(pro)).pro.balance, b.price - b.commission + 200);
  const pays = db.prepare('SELECT * FROM payments WHERE booking_id=? AND status=\'paid\'').all(id);
  assert.ok(pays.every(p => p.refunded_amount === p.amount), 'booking and tip payments refunded');
});

test('scheduling: double-booking rejected, hours respected', async () => {
  const c1 = await login(); const c2 = await login(); const pro = await login(PRO.electrician);
  const proId = (await me(pro)).user.id; const s = svc('electrical');
  const date = bishkekDate(5);
  const slots = (await call(`/pros/${proId}/slots?service_id=${s.id}&qty=1&date=${date}`)).data.slots;
  assert.ok(slots.length > 3 && slots[0].label === '09:00');
  const body = { service_id: s.id, pro_id: proId, address: 'A', district: 'Leninsky', scheduled_at: slots[0].at };
  await book(c1, body);
  assert.equal((await call('/bookings', { token: c2, method: 'POST', body })).status, 409);
  assert.equal((await call('/bookings', { token: c2, method: 'POST', body: { ...body, scheduled_at: `${date}T03:00:00+06:00` } })).status, 409);
  let sun = new Date(Date.now() + 6 * 3600e3 + 2 * 864e5); while (sun.getUTCDay() !== 0) sun = new Date(+sun + 864e5);
  assert.equal((await call(`/pros/${proId}/slots?service_id=${s.id}&qty=1&date=${sun.toISOString().slice(0, 10)}`)).data.slots.length, 0);
});

test('quotes: request, quote, hire, pay', async () => {
  const cust = await login(); const pro = await login(PRO.plumber); const pro2 = await login(PRO.electrician);
  const plumbing = cat.categories.find(c => c.slug === 'plumbing');
  const r = await call('/requests', { token: cust, method: 'POST', body: { category_id: plumbing.id, title: 'Replace all pipes', description: 'Old iron pipes in a 2-room flat, call 0555123456', district: 'Sverdlovsky', address: 'Toktogula 5', preferred_at: hoursAhead(72) } });
  const rid = r.data.id;
  const lead = (await call(`/requests/${rid}`, { token: pro })).data;
  assert.ok(lead.address_hidden && lead.description.includes('[contact hidden]'));
  assert.equal((await call(`/requests/${rid}/quotes`, { token: pro2, method: 'POST', body: { price: 5000 } })).status, 403);
  await call(`/requests/${rid}/quotes`, { token: pro, method: 'POST', body: { price: 15000, message: 'Includes materials' } });
  const view = (await call(`/requests/${rid}`, { token: cust })).data;
  const hire = await call(`/requests/${rid}/hire`, { token: cust, method: 'POST', body: { quote_id: view.quotes[0].id } });
  assert.equal(hire.status, 201); assert.equal(hire.data.status, 'unpaid'); assert.equal(hire.data.price, 15000);
  assert.equal((await call(`/requests/${rid}/hire`, { token: cust, method: 'POST', body: { quote_id: view.quotes[0].id } })).status, 400);
  assert.ok((await call(`/requests/${rid}`, { token: pro })).data.address_hidden, 'address hidden until paid');
  await mockPay(hire.data.pay_url);
  assert.equal((await call(`/bookings/${hire.data.id}`, { token: cust })).data.status, 'accepted');
  assert.ok((await call(`/requests/${rid}`, { token: pro })).data.address.includes('Toktogula'));
  assert.equal((await call(`/requests/${rid}`, { token: cust })).data.status, 'hired');
});

test('recurring cleaning: 10% off, next visit reserved and awaiting payment', async () => {
  const cust = await login(); const pro = await login(PRO.cleaner);
  const s = svc('cleaning');
  const b = await book(cust, { service_id: s.id, qty: 50, recurrence: 'weekly', address: 'A', district: 'Oktyabrsky', scheduled_at: hoursAhead(50) });
  assert.equal(b.price, Math.round(s.price * 50 * 0.9));
  for (const a of ['accept', 'start', 'finish']) assert.equal((await call(`/bookings/${b.id}/${a}`, { token: pro, method: 'POST' })).status, 200);
  const c = (await call(`/bookings/${b.id}/confirm`, { token: cust, method: 'POST' })).data;
  const next = (await call('/bookings/' + c.next_booking_id, { token: cust })).data;
  assert.equal(next.status, 'unpaid'); assert.equal(next.parent_id, b.id);
  assert.equal(Date.parse(next.scheduled_at) - Date.parse(b.scheduled_at), 7 * 864e5);
  const url = (await call(`/bookings/${next.id}/pay`, { token: cust, method: 'POST' })).data.pay_url;
  await mockPay(url);
  assert.equal((await call('/bookings/' + next.id, { token: cust })).data.status, 'assigned');
});

test('late cancellation: partial refund, fee to the pro', async () => {
  const cust = await login(); const pro = await login(PRO.appliances); const s = svc('appliances');
  const b = await book(cust, { service_id: s.id, address: 'A', district: 'Pervomaisky', scheduled_at: hoursAhead(5) });
  await call(`/bookings/${b.id}/accept`, { token: pro, method: 'POST' });
  const bal = (await me(pro)).pro.balance;
  const c = (await call(`/bookings/${b.id}/cancel`, { token: cust, method: 'POST' })).data;
  assert.equal(c.payment, 'partial_refund'); assert.equal(c.cancel_fee, Math.round(s.price * 0.2));
  assert.equal((await me(pro)).pro.balance - bal, c.cancel_fee);
  assert.equal(db.prepare("SELECT refunded_amount FROM payments WHERE booking_id=? AND status='paid'").get(b.id).refunded_amount, s.price - c.cancel_fee);
});

test('uploads: type checking, public vs private ID photos', async () => {
  const pro = await login(null, 'pro', 'Uploader'); const cust = await login(); const admin = await login('0700000000');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal((await call('/uploads', { token: pro, method: 'POST', body: { kind: 'avatar', data: 'data:text/plain;base64,' + Buffer.from('<script>').toString('base64') } })).status, 400);
  assert.equal((await call('/uploads', { token: cust, method: 'POST', body: { kind: 'id', data: png } })).status, 400);
  const av = (await call('/uploads', { token: pro, method: 'POST', body: { kind: 'avatar', data: png } })).data;
  assert.equal((await fetch(root + av.url)).status, 200);
  const idp = (await call('/uploads', { token: pro, method: 'POST', body: { kind: 'id', data: png } })).data;
  const file = fs.readdirSync(process.env.UPLOAD_DIR).find(f => f !== path.basename(av.url));
  assert.equal((await fetch(root + '/media/' + file)).status, 404, 'ID photo must not be public');
  assert.equal((await fetch(root + idp.url, { headers: { Authorization: 'Bearer ' + cust } })).status, 404);
  assert.equal((await fetch(root + idp.url, { headers: { Authorization: 'Bearer ' + admin } })).status, 200);
});

test('verification gate + notifications in the user\'s language', async () => {
  const p = await login(null, 'pro', 'Новый Мастер', 'ru'); const admin = await login('0700000000');
  assert.equal((await me(p)).user.lang, 'ru');
  await call('/pro/profile', { token: p, method: 'PUT', body: { bio: 'x', district: 'Leninsky', categories: [1], hours: { 1: [8, 20], 9: [1, 2] } } });
  assert.deepEqual((await me(p)).pro.hours, { 1: [8, 20] });
  assert.deepEqual((await call('/jobs/open', { token: p })).data, []);
  const uid = (await me(p)).user.id;
  await call(`/admin/pros/${uid}/verified`, { token: admin, method: 'POST' });
  const notes = (await call('/notifications', { token: p })).data;
  assert.ok(notes.some(x => x.body.includes('Вы прошли проверку')));
  await call('/me', { token: p, method: 'PUT', body: { lang: 'en' } });
  assert.equal((await me(p)).user.lang, 'en');
  assert.equal((await call('/admin/stats', { token: p })).status, 403);
  assert.equal((await call('/admin/stats', { token: admin })).data.payment_provider, 'mock');
});

test('CORS: mobile app origins allowed, others not', async () => {
  const pre = await fetch(base + '/catalog', { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  const android = await fetch(base + '/catalog', { headers: { Origin: 'https://localhost' } });
  assert.equal(android.headers.get('access-control-allow-origin'), 'https://localhost');
  const evil = await fetch(base + '/catalog', { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});
