// End-to-end API test: node --test test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usta-')), 'test.db');
const { server, maskContacts, normPhone } = require('./server');

let base;
test.before(() => new Promise(r => server.listen(0, () => { base = `http://localhost:${server.address().port}/api`; r(); })));
test.after(() => server.close());
const call = async (p, { token, method = 'GET', body } = {}) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const login = async (phone, role = 'customer', name = 'Test') => {
  const { data } = await call('/auth/request', { method: 'POST', body: { phone } });
  return (await call('/auth/verify', { method: 'POST', body: { phone, code: data.dev_code, role, name } })).data.token;
};
const future = () => new Date(Date.now() + 864e5).toISOString();

test('helpers', () => {
  assert.equal(normPhone('0700 123 456'), '+996700123456');
  assert.equal(normPhone('12'), null);
  assert.match(maskContacts('call me 0555 12 34 56 or @aza_plumber or t.me/aza'), /^call me \[contact hidden\] or \[contact hidden\] or \[contact hidden\]$/);
});

test('full job lifecycle with escrow, chat masking, review, warranty', async () => {
  const cust = await login('0701000001');
  const pro = await login('0700111111');           // seeded verified plumber (Azamat)
  const pro2 = await login('0700444444');          // seeded, appliances+electrical
  const admin = await login('0700000000');
  const { data: cat } = await call('/catalog');
  const plumbing = cat.categories.find(c => c.slug === 'plumbing');
  const tap = plumbing.services[0];

  // wrong code rejected
  await call('/auth/request', { method: 'POST', body: { phone: '0701000009' } });
  assert.equal((await call('/auth/verify', { method: 'POST', body: { phone: '0701000009', code: '000000' } })).status, 400);

  // open booking; price is computed server-side from catalog
  const bk = await call('/bookings', { token: cust, method: 'POST', body: { service_id: tap.id, qty: 2, address: 'Chui 100, apt 5', district: 'Leninsky', scheduled_at: future(), price: 1 } });
  assert.equal(bk.status, 201);
  assert.equal(bk.data.price, tap.price * 2);
  assert.equal(bk.data.commission, Math.round(tap.price * 2 * 0.12));
  const id = bk.data.id;

  // pro in another category doesn't see it; plumber sees it with address hidden
  assert.ok(!(await call('/jobs/open', { token: pro2 })).data.some(j => j.id === id));
  const feed = (await call('/jobs/open', { token: pro })).data.find(j => j.id === id);
  assert.ok(feed && !feed.address.includes('Chui'));

  // accept; a second accept fails
  assert.equal((await call(`/bookings/${id}/accept`, { token: pro, method: 'POST' })).status, 200);
  assert.equal((await call(`/bookings/${id}/accept`, { token: pro2, method: 'POST' })).status, 409);
  // customer can't confirm before work is done
  assert.equal((await call(`/bookings/${id}/confirm`, { token: cust, method: 'POST' })).status, 403);

  // chat masks phone numbers
  await call(`/bookings/${id}/messages`, { token: pro, method: 'POST', body: { text: 'Next time just call me on 0555 123 456' } });
  const msgs = (await call(`/bookings/${id}/messages`, { token: cust })).data;
  assert.ok(msgs[0].body.includes('[contact hidden]') && !msgs[0].body.includes('0555'));
  // outsider can't read chat
  const stranger = await login('0701000002');
  assert.equal((await call(`/bookings/${id}/messages`, { token: stranger })).status, 403);

  for (const a of ['start', 'finish']) assert.equal((await call(`/bookings/${id}/${a}`, { token: pro, method: 'POST' })).status, 200);
  const done = await call(`/bookings/${id}/confirm`, { token: cust, method: 'POST' });
  assert.equal(done.data.status, 'completed'); assert.equal(done.data.payment, 'released'); assert.ok(done.data.warranty_until);

  const me = (await call('/me', { token: pro })).data;
  assert.equal(me.pro.balance, bk.data.price - bk.data.commission);

  assert.equal((await call(`/bookings/${id}/review`, { token: cust, method: 'POST', body: { rating: 5, body: 'Great, fast' } })).status, 200);
  assert.equal((await call(`/pros/${me.user.id}`)).data.rating, 5);

  // repeat booking with same pro -> 5% commission
  const rep = await call('/bookings', { token: cust, method: 'POST', body: { service_id: tap.id, pro_id: me.user.id, address: 'Chui 100', district: 'Leninsky', scheduled_at: future() } });
  assert.equal(rep.data.status, 'assigned');
  assert.equal(rep.data.commission, Math.round(tap.price * 0.05));

  // warranty claim -> admin refund claws back pro balance
  assert.equal((await call(`/bookings/${id}/dispute`, { token: cust, method: 'POST', body: { reason: 'Leaking again' } })).data.status, 'disputed');
  assert.equal((await call(`/bookings/${id}/refund`, { token: admin, method: 'POST' })).data.payment, 'refunded');
  assert.equal((await call('/me', { token: pro })).data.pro.balance, 0);
});

test('new pro must be verified before seeing jobs', async () => {
  const p = await login('0702000001', 'pro', 'New Pro');
  const admin = await login('0700000000');
  assert.equal((await call('/me', { token: p })).data.pro.status, 'pending');
  await call('/pro/profile', { token: p, method: 'PUT', body: { bio: 'x', district: 'Leninsky', categories: [1], id_note: 'AN1' } });
  assert.deepEqual((await call('/jobs/open', { token: p })).data, []);
  const uid = (await call('/me', { token: p })).data.user.id;
  await call(`/admin/pros/${uid}/verified`, { token: admin, method: 'POST' });
  assert.ok(Array.isArray((await call('/jobs/open', { token: p })).data));
  assert.equal((await call('/admin/pros', { token: p })).status, 403);
});
