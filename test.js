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
const { server, maskContacts, normPhone } = require('./server');

let base, root;
test.before(() => new Promise(r => server.listen(0, () => { root = `http://localhost:${server.address().port}`; base = root + '/api'; r(); })));
test.after(() => server.close());
const call = async (p, { token, method = 'GET', body } = {}) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let n = 0;
const login = async (phone, role = 'customer', name = 'Test') => {
  phone ||= '0701' + String(100000 + ++n);
  const { data } = await call('/auth/request', { method: 'POST', body: { phone } });
  return (await call('/auth/verify', { method: 'POST', body: { phone, code: data.dev_code, role, name } })).data.token;
};
const me = async t => (await call('/me', { token: t })).data;
const hoursAhead = h => new Date(Date.now() + h * 3600e3).toISOString();
// a Bishkek-local date N days ahead that is a weekday (demo pros work Mon–Sat)
const bishkekDate = days => { let d = new Date(Date.now() + 6 * 3600e3 + days * 864e5); while (d.getUTCDay() === 0) d = new Date(+d + 864e5); return d.toISOString().slice(0, 10); };
let cat;
const svc = (slug, i = 0) => cat.categories.find(c => c.slug === slug).services[i];
const PRO = { plumber: '0700111111', electrician: '0700222222', cleaner: '0700333333', appliances: '0700444444' };

test('catalog + helpers', async () => {
  cat = (await call('/catalog')).data;
  assert.ok(cat.categories.length >= 6);
  assert.equal(normPhone('0700 123 456'), '+996700123456');
  assert.equal(normPhone('12'), null);
  assert.equal(maskContacts('call 0555 12 34 56, @aza_plumber, t.me/aza, whatsapp me'), 'call [contact hidden], [contact hidden], [contact hidden] [contact hidden] me');
});

test('auth: wrong code, OTP resend throttle', async () => {
  await call('/auth/request', { method: 'POST', body: { phone: '0701999001' } });
  assert.equal((await call('/auth/request', { method: 'POST', body: { phone: '0701999001' } })).status, 429);
  assert.equal((await call('/auth/verify', { method: 'POST', body: { phone: '0701999001', code: '000000' } })).status, 400);
});

test('full lifecycle: open job, escrow, chat masking, tip, review, repeat discount, warranty refund', async () => {
  const cust = await login(); const pro = await login(PRO.plumber); const other = await login(PRO.appliances); const admin = await login('0700000000');
  const tap = svc('plumbing');
  const bk = await call('/bookings', { token: cust, method: 'POST', body: { service_id: tap.id, qty: 2, address: 'Chui 100, apt 5', district: 'Leninsky', scheduled_at: hoursAhead(30) } });
  assert.equal(bk.status, 201);
  assert.equal(bk.data.price, tap.price * 2);
  const id = bk.data.id;

  assert.ok(!(await call('/jobs/open', { token: other })).data.some(j => j.id === id), 'other category must not see job');
  const feed = (await call('/jobs/open', { token: pro })).data.find(j => j.id === id);
  assert.ok(feed && !feed.address.includes('Chui'), 'address hidden before accept');
  assert.ok((await me(pro)).unread > 0, 'pro notified of new job');

  assert.equal((await call(`/bookings/${id}/accept`, { token: pro, method: 'POST' })).status, 200);
  assert.equal((await call(`/bookings/${id}/accept`, { token: other, method: 'POST' })).status, 403);
  assert.ok((await call(`/bookings/${id}`, { token: pro })).data.address.includes('Chui'), 'address visible after accept');
  assert.equal((await call(`/bookings/${id}`, { token: other })).status, 404);
  assert.equal((await call(`/bookings/${id}/confirm`, { token: cust, method: 'POST' })).status, 403);

  await call(`/bookings/${id}/messages`, { token: pro, method: 'POST', body: { text: 'Next time call me on 0555 123 456' } });
  const msgs = (await call(`/bookings/${id}/messages`, { token: cust })).data;
  assert.ok(msgs[0].body.includes('[contact hidden]') && !msgs[0].body.includes('0555'));
  assert.equal((await call(`/bookings/${id}/messages`, { token: other })).status, 403);

  for (const a of ['start', 'finish']) assert.equal((await call(`/bookings/${id}/${a}`, { token: pro, method: 'POST' })).status, 200);
  const before = (await me(pro)).pro.balance;
  const done = await call(`/bookings/${id}/confirm`, { token: cust, method: 'POST', body: { tip: 200 } });
  assert.equal(done.data.status, 'completed'); assert.equal(done.data.tip, 200);
  assert.equal((await me(pro)).pro.balance - before, bk.data.price - bk.data.commission + 200);

  assert.equal((await call(`/bookings/${id}/review`, { token: cust, method: 'POST', body: { rating: 5, body: 'Great' } })).status, 200);

  // repeat booking with same pro -> 5% commission
  const proId = (await me(pro)).user.id;
  const date = bishkekDate(3);
  const slots = (await call(`/pros/${proId}/slots?service_id=${tap.id}&qty=1&date=${date}`)).data.slots;
  const rep = await call('/bookings', { token: cust, method: 'POST', body: { service_id: tap.id, pro_id: proId, address: 'Chui 100', district: 'Leninsky', scheduled_at: slots[0].at } });
  assert.equal(rep.data.status, 'assigned');
  assert.equal(rep.data.commission, Math.round(tap.price * 0.05));

  // warranty claim -> admin refund claws back payout incl. tip
  const bal = (await me(pro)).pro.balance;
  assert.equal((await call(`/bookings/${id}/dispute`, { token: cust, method: 'POST', body: { reason: 'Leaking again' } })).data.status, 'disputed');
  assert.equal((await call(`/bookings/${id}/refund`, { token: admin, method: 'POST' })).data.payment, 'refunded');
  assert.equal(bal - (await me(pro)).pro.balance, bk.data.price - bk.data.commission + 200);
});

test('scheduling: slots respect hours and existing bookings; double-booking rejected', async () => {
  const c1 = await login(); const c2 = await login(); const pro = await login(PRO.electrician);
  const proId = (await me(pro)).user.id; const s = svc('electrical');
  const date = bishkekDate(5);
  const slots = (await call(`/pros/${proId}/slots?service_id=${s.id}&qty=1&date=${date}`)).data.slots;
  assert.ok(slots.length > 3 && slots[0].label === '09:00');
  const body = { service_id: s.id, pro_id: proId, address: 'A', district: 'Leninsky', scheduled_at: slots[0].at };
  assert.equal((await call('/bookings', { token: c1, method: 'POST', body })).status, 201);
  assert.equal((await call('/bookings', { token: c2, method: 'POST', body })).status, 409);
  const after = (await call(`/pros/${proId}/slots?service_id=${s.id}&qty=1&date=${date}`)).data.slots;
  assert.ok(!after.some(x => x.at === slots[0].at));
  // outside working hours (03:00 local) rejected
  assert.equal((await call('/bookings', { token: c2, method: 'POST', body: { ...body, scheduled_at: `${date}T03:00:00+06:00` } })).status, 409);
  // sunday is a day off for demo pros
  let sun = new Date(Date.now() + 6 * 3600e3 + 2 * 864e5); while (sun.getUTCDay() !== 0) sun = new Date(+sun + 864e5);
  assert.equal((await call(`/pros/${proId}/slots?service_id=${s.id}&qty=1&date=${sun.toISOString().slice(0, 10)}`)).data.slots.length, 0);
});

test('quotes: request, quote, hire', async () => {
  const cust = await login(); const pro = await login(PRO.plumber); const pro2 = await login(PRO.electrician);
  const plumbing = cat.categories.find(c => c.slug === 'plumbing');
  const r = await call('/requests', { token: cust, method: 'POST', body: { category_id: plumbing.id, title: 'Replace all pipes', description: 'Old iron pipes in a 2-room flat, call 0555123456', district: 'Sverdlovsky', address: 'Toktogula 5', preferred_at: hoursAhead(72) } });
  assert.equal(r.status, 201); const rid = r.data.id;
  const lead = (await call(`/requests/${rid}`, { token: pro })).data;
  assert.ok(!lead.address.includes('Toktogula') && lead.description.includes('[contact hidden]'));
  assert.equal((await call(`/requests/${rid}/quotes`, { token: pro2, method: 'POST', body: { price: 5000 } })).status, 403);
  assert.equal((await call(`/requests/${rid}/quotes`, { token: pro, method: 'POST', body: { price: 15000, message: 'Includes materials' } })).status, 201);
  const view = (await call(`/requests/${rid}`, { token: cust })).data;
  assert.equal(view.quotes.length, 1);
  const hire = await call(`/requests/${rid}/hire`, { token: cust, method: 'POST', body: { quote_id: view.quotes[0].id } });
  assert.equal(hire.status, 201); assert.equal(hire.data.price, 15000); assert.equal(hire.data.status, 'accepted');
  assert.ok((await call(`/requests/${rid}`, { token: pro })).data.address.includes('Toktogula'));
  assert.equal((await call(`/requests/${rid}/hire`, { token: cust, method: 'POST', body: { quote_id: view.quotes[0].id } })).status, 400);
});

test('recurring cleaning: 10% off and next visit auto-scheduled', async () => {
  const cust = await login(); const pro = await login(PRO.cleaner);
  const s = svc('cleaning');
  const b = (await call('/bookings', { token: cust, method: 'POST', body: { service_id: s.id, qty: 50, recurrence: 'weekly', address: 'A', district: 'Oktyabrsky', scheduled_at: hoursAhead(50) } })).data;
  assert.equal(b.price, Math.round(s.price * 50 * 0.9)); assert.equal(b.recurrence, 'weekly');
  for (const a of ['accept', 'start', 'finish']) assert.equal((await call(`/bookings/${b.id}/${a}`, { token: pro, method: 'POST' })).status, 200);
  await call(`/bookings/${b.id}/confirm`, { token: cust, method: 'POST' });
  const next = (await call('/bookings', { token: cust })).data.find(x => x.parent_id === b.id);
  assert.ok(next); assert.equal(next.status, 'assigned');
  assert.equal(Date.parse(next.scheduled_at) - Date.parse(b.scheduled_at), 7 * 864e5);
  // a non-recurring category ignores recurrence
  const p = (await call('/bookings', { token: cust, method: 'POST', body: { service_id: svc('plumbing').id, recurrence: 'weekly', address: 'A', district: 'Oktyabrsky', scheduled_at: hoursAhead(80) } })).data;
  assert.equal(p.recurrence, 'none');
});

test('late cancellation pays the pro a fee', async () => {
  const cust = await login(); const pro = await login(PRO.appliances); const s = svc('appliances');
  const b = (await call('/bookings', { token: cust, method: 'POST', body: { service_id: s.id, address: 'A', district: 'Pervomaisky', scheduled_at: hoursAhead(5) } })).data;
  await call(`/bookings/${b.id}/accept`, { token: pro, method: 'POST' });
  const bal = (await me(pro)).pro.balance;
  const c = (await call(`/bookings/${b.id}/cancel`, { token: cust, method: 'POST' })).data;
  assert.equal(c.payment, 'partial_refund'); assert.equal(c.cancel_fee, Math.round(s.price * 0.2));
  assert.equal((await me(pro)).pro.balance - bal, c.cancel_fee);
});

test('uploads: type checking, public vs private ID photos', async () => {
  const pro = await login(null, 'pro', 'Uploader'); const cust = await login(); const admin = await login('0700000000');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal((await call('/uploads', { token: pro, method: 'POST', body: { kind: 'avatar', data: 'data:text/plain;base64,' + Buffer.from('<script>').toString('base64') } })).status, 400);
  assert.equal((await call('/uploads', { token: cust, method: 'POST', body: { kind: 'id', data: png } })).status, 400);
  const av = (await call('/uploads', { token: pro, method: 'POST', body: { kind: 'avatar', data: png } })).data;
  assert.equal((await fetch(root + av.url)).status, 200);
  const idp = (await call('/uploads', { token: pro, method: 'POST', body: { kind: 'id', data: png } })).data;
  assert.match(idp.url, /^\/api\/photos\//);
  const file = fs.readdirSync(process.env.UPLOAD_DIR).find(f => f !== path.basename(av.url));
  assert.equal((await fetch(root + '/media/' + file)).status, 404, 'ID photo must not be public');
  assert.equal((await fetch(root + idp.url, { headers: { Authorization: 'Bearer ' + cust } })).status, 404);
  assert.equal((await fetch(root + idp.url, { headers: { Authorization: 'Bearer ' + admin } })).status, 200);
  assert.ok((await me(pro)).pro.has_id_photo);
});

test('verification gate + notifications', async () => {
  const p = await login(null, 'pro', 'New Pro'); const admin = await login('0700000000');
  assert.equal((await me(p)).pro.status, 'pending');
  await call('/pro/profile', { token: p, method: 'PUT', body: { bio: 'x', district: 'Leninsky', categories: [1], hours: { 1: [8, 20], 9: [1, 2] } } });
  assert.deepEqual((await me(p)).pro.hours, { 1: [8, 20] });
  assert.deepEqual((await call('/jobs/open', { token: p })).data, []);
  const uid = (await me(p)).user.id;
  await call(`/admin/pros/${uid}/verified`, { token: admin, method: 'POST' });
  const notes = (await call('/notifications', { token: p })).data;
  assert.ok(notes.some(x => x.body.includes('verified')));
  await call('/notifications/read', { token: p, method: 'POST' });
  assert.equal((await me(p)).unread, 0);
  assert.equal((await call('/admin/stats', { token: p })).status, 403);
  assert.ok((await call('/admin/stats', { token: admin })).data.bookings.total > 0);
});
