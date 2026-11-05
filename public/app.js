'use strict';
// ---------- utils ----------
const TZ = 'Asia/Bishkek'; // all times shown in Bishkek time regardless of device setting
const $ = s => document.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const som = n => Number(n || 0).toLocaleString('ru-RU') + ' сом';
const stars = (r, n) => r ? `<span class="stars">★</span> <b>${r}</b>${n != null ? ` <span class="muted">(${n})</span>` : ''}` : '<span class="badge brand">New</span>';
const when = s => new Date(s).toLocaleString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dateOnly = s => new Date(s).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const ago = s => { const m = (Date.now() - Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')) / 6e4; return m < 1 ? 'just now' : m < 60 ? `${m | 0} min ago` : m < 1440 ? `${(m / 60) | 0} h ago` : `${(m / 1440) | 0} d ago`; };
const localISO = d => new Date(d - d.getTimezoneOffset() * 6e4).toISOString();
const initials = n => String(n || '?').split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
const avatar = (name, url, size = '') => `<span class="avatar ${size}" ${url ? `style="background-image:url('${esc(url)}')"` : ''}>${url ? '' : esc(initials(name))}</span>`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const empty = (icon, text, cta = '') => `<div class="empty"><div class="big">${icon}</div><p>${text}</p>${cta}</div>`;

let state = { token: localStorage.getItem('usta_token'), me: null, catalog: null, timers: [] };
const role = () => state.me?.user.role;

function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600); }
async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && state.token) { clearSession(); }
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
}
function clearSession() { state.token = null; state.me = null; localStorage.removeItem('usta_token'); renderChrome(); }
async function logout() { await api('/auth/logout', { method: 'POST' }).catch(() => {}); clearSession(); location.hash = '#/'; }
async function loadMe() { if (!state.token) return (state.me = null); try { state.me = await api('/me'); } catch { state.me = null; } renderChrome(); }
async function catalog() { return state.catalog ||= await api('/catalog'); }
const findService = (c, id) => { for (const k of c.categories) for (const s of k.services) if (s.id == id) return { svc: s, cat: k }; return {}; };
const every = (ms, fn) => state.timers.push(setInterval(fn, ms));

// image upload: downscale on device (saves mobile data), then send as data URL
async function shrink(file, max = 1600) {
  const img = await createImageBitmap(file).catch(() => null); if (!img) throw new Error('Could not read that image');
  const s = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas');
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
const pickFiles = (multiple = false, capture = false) => new Promise(res => {
  const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.multiple = multiple; if (capture) i.capture = 'user';
  i.onchange = () => res([...i.files]); i.click();
});
async function upload(kind, multiple = false, capture = false) {
  const files = await pickFiles(multiple, capture); const out = [];
  for (const f of files.slice(0, 8)) { try { out.push(await api('/uploads', { method: 'POST', body: { kind, data: await shrink(f) } })); } catch (e) { toast(e.message); } }
  return out;
}
async function privateImg(el, id) {
  const r = await fetch('/api/photos/' + id, { headers: { Authorization: 'Bearer ' + state.token } });
  if (r.ok) el.style.backgroundImage = `url(${URL.createObjectURL(await r.blob())})`;
}

const STATUS = {
  unpaid: ['Awaiting payment', 'warn'], open: ['Finding a pro', 'warn'], assigned: ['Waiting for pro', 'warn'], accepted: ['Confirmed', 'ok'],
  in_progress: ['In progress', 'brand'], awaiting_confirmation: ['Confirm work', 'warn'], completed: ['Completed', 'ok'],
  disputed: ['Problem reported', 'bad'], cancelled: ['Cancelled', ''], refunded: ['Refunded', ''],
};
const FLOW = ['open', 'accepted', 'in_progress', 'awaiting_confirmation', 'completed'];
const badge = s => `<span class="badge ${STATUS[s]?.[1] || ''}">${STATUS[s]?.[0] || esc(s)}</span>`;
const UPCOMING = ['unpaid', 'open', 'assigned', 'accepted', 'in_progress', 'awaiting_confirmation', 'disputed'];

// ---------- chrome ----------
const TABS = {
  guest: [['#/', '🏠', 'Home'], ['#/login?role=pro', '🧰', 'Become a pro'], ['#/login', '👤', 'Sign in']],
  customer: [['#/', '🏠', 'Home'], ['#/bookings', '📅', 'Bookings'], ['#/requests', '💬', 'Quotes'], ['#/account', '👤', 'Account']],
  pro: [['#/jobs', '🧰', 'Jobs'], ['#/leads', '💬', 'Leads'], ['#/bookings', '📅', 'Schedule'], ['#/earnings', '💰', 'Earnings'], ['#/profile', '👤', 'Profile']],
  admin: [['#/admin', '📊', 'Dashboard'], ['#/admin/verify', '🪪', 'Verify'], ['#/bookings', '📅', 'Bookings'], ['#/admin/payouts', '💸', 'Payouts']],
};
function renderChrome() {
  const r = role() || 'guest'; const cur = location.hash.split('?')[0] || '#/';
  $('#tabs').innerHTML = TABS[r].map(([h, i, t]) => `<a href="${h}" class="${(cur === h.split('?')[0] || (h !== '#/' && cur.startsWith(h.split('?')[0] + '/') && h !== '#/admin')) ? 'on' : ''}"><i>${i}</i>${t}</a>`).join('');
  $('#bell').hidden = !state.me; const n = state.me?.unread || 0; $('#unread').hidden = !n; $('#unread').textContent = n > 9 ? '9+' : n;
  $('#acct').innerHTML = state.me ? avatar(state.me.user.name, state.me.user.avatar, 'sm') : '';
  $('#acct').href = r === 'pro' ? '#/profile' : '#/account'; $('#acct').hidden = !state.me;
}
const proRow = (p, extra = '') => `<div class="pro">${avatar(p.name, p.avatar)}<div class="grow"><div class="row"><b class="ell">${esc(p.name)}</b>${extra}</div>
  <div class="muted small">${stars(p.rating, p.reviews)} · ${p.jobs} jobs · ${esc(p.district || '')}</div></div></div>`;

// ---------- views ----------
const views = {
  async home() {
    if (role() === 'pro') return go('#/jobs'); if (role() === 'admin') return go('#/admin');
    const [c, favs] = await Promise.all([catalog(), role() === 'customer' ? api('/favorites') : []]);
    const popular = c.categories.flatMap(k => k.services.filter(s => s.popular).map(s => ({ ...s, icon: k.icon })));
    app.innerHTML = `
      <div class="hero"><h1>Get it done today</h1><p>ID-verified pros in Bishkek at fixed prices. You pay only after the job is done.</p>
        <form class="search" id="sf"><input name="q" placeholder="What do you need help with?" autocomplete="off"></form></div>
      <h2>Services</h2>
      <div class="grid">${c.categories.map(x => `<a class="card cat" href="#/c/${x.id}"><span class="ic">${x.icon}</span>${esc(x.name)}</a>`).join('')}</div>
      ${favs.length ? `<h2>Your pros</h2><div class="hscroll">${favs.map(p => `<a class="card" style="min-width:230px;margin:0" href="#/pro/${p.id}">${proRow(p, p.is_favorite ? '❤️' : '')}</a>`).join('')}</div>` : ''}
      <h2>Popular right now</h2>
      ${popular.map(s => `<a class="card row" href="#/book/${s.id}"><div><b>${s.icon} ${esc(s.name)}</b><div class="muted small">${esc(s.unit)}</div></div><span class="price">from ${som(s.price)}</span></a>`).join('')}
      <a class="card row" href="#/quote/new" style="border-color:var(--brand)"><div><b>💬 Not on the list?</b><div class="muted small">Describe your job and get quotes from verified pros, usually within an hour</div></div><span>›</span></a>
      <h2>The Usta guarantee</h2>
      <div class="trust">
        <div>🪪 <b>ID-verified</b><br><span class="muted">Passport and selfie checked</span></div>
        <div>💰 <b>Fixed prices</b><br><span class="muted">No haggling on the spot</span></div>
        <div>🔒 <b>Pay after the job</b><br><span class="muted">We hold the money until you confirm</span></div>
        <div>🛡️ <b>30-day warranty</b><br><span class="muted">Free redo or a refund</span></div>
      </div>`;
    $('#sf').onsubmit = e => { e.preventDefault(); go('#/search?q=' + encodeURIComponent(e.target.q.value)); };
  },
  async search(_, q) {
    const c = await catalog(); const term = (q.get('q') || '').toLowerCase().trim();
    const hits = c.categories.flatMap(k => k.services.filter(s => !term || s.name.toLowerCase().includes(term) || k.name.toLowerCase().includes(term)).map(s => ({ ...s, cat: k })));
    app.innerHTML = `<form class="search card" id="sf" style="padding:0"><input name="q" value="${esc(q.get('q') || '')}" placeholder="Search services" autofocus></form>
      ${hits.map(s => `<a class="card row" href="#/book/${s.id}"><div><b>${s.cat.icon} ${esc(s.name)}</b><div class="muted small">${esc(s.cat.name)} · ${esc(s.unit)}</div></div><span class="price">${som(s.price)}</span></a>`).join('')
        || empty('🔍', `No fixed-price service matches “${esc(term)}”.`, '<a class="btn" href="#/quote/new">Get quotes instead</a>')}`;
    $('#sf').onsubmit = e => { e.preventDefault(); go('#/search?q=' + encodeURIComponent(e.target.q.value)); };
  },
  async category(id) {
    const c = await catalog(); const cat = c.categories.find(x => x.id == id); if (!cat) return views.notfound();
    const pros = await api('/pros?category=' + id);
    app.innerHTML = `<a href="#/">‹ Home</a><h1>${cat.icon} ${esc(cat.name)}</h1>
      <p class="muted">${cat.pro_count} verified pros · fixed prices${cat.recurring ? ' · save 10% with a regular cleaning plan' : ''}</p>
      ${cat.services.map(s => `<a class="card row" href="#/book/${s.id}"><div><b>${esc(s.name)}</b><div class="muted small">${esc(s.unit)}</div></div>
        <div style="text-align:right"><div class="price">${som(s.price)}</div><span class="muted small">Book ›</span></div></a>`).join('')}
      <a class="card row" href="#/quote/new?cat=${cat.id}"><div><b>💬 Something else?</b><div class="muted small">Get custom quotes from ${esc(cat.name.toLowerCase())} pros</div></div><span>›</span></a>
      <h2>Top-rated pros</h2>
      ${pros.map(p => `<a class="card" href="#/pro/${p.id}">${proRow(p, '<span class="badge ok">✓ Verified</span>')}${p.bio ? `<p class="muted small" style="margin:8px 0 0">${esc(p.bio.slice(0, 110))}${p.bio.length > 110 ? '…' : ''}</p>` : ''}</a>`).join('') || '<p class="muted">No pros yet. Book anyway and we will find you one.</p>'}`;
  },
  async pro(id) {
    const [p, c] = await Promise.all([api('/pros/' + id), catalog()]);
    const svcs = c.categories.filter(k => p.categories.includes(k.id)).flatMap(k => k.services.map(s => ({ ...s, icon: k.icon })));
    const hours = Object.entries(p.hours).sort(([a], [b]) => ((+a + 6) % 7) - ((+b + 6) % 7)).map(([d, [s, e]]) => `${DAYS[d]} ${s}–${e}`).join(' · ');
    app.innerHTML = `<a href="javascript:history.back()">‹ Back</a>
      <div class="card" style="text-align:center">
        <div style="display:flex;justify-content:center">${avatar(p.name, p.avatar, 'lg')}</div>
        <h1 style="margin-top:10px">${esc(p.name)}</h1>
        <div><span class="badge ok">✓ ID verified</span></div>
        <p style="margin:10px 0 0">${stars(p.rating, p.reviews)} · <b>${p.jobs}</b> jobs · ${esc(p.district || '')}</p>
        <p class="muted small" style="margin:4px 0 0">Member since ${dateOnly(p.member_since.replace(' ', 'T') + 'Z')}</p>
        ${role() === 'customer' ? `<div class="actions" style="justify-content:center"><button class="ghost sm" id="fav">${p.is_favorite ? '❤️ Saved' : '🤍 Save'}</button></div>` : ''}
      </div>
      ${p.bio ? `<div class="card"><h3>About</h3><p style="margin:6px 0 0">${esc(p.bio)}</p></div>` : ''}
      <div class="card"><h3>Availability</h3><p class="muted small" style="margin:6px 0 0">${hours || 'No regular hours set'}</p></div>
      ${p.portfolio.length ? `<h2>Work photos</h2><div class="gallery">${p.portfolio.map(x => `<a class="ph" href="${x.url}" target="_blank" style="background-image:url('${x.url}')"></a>`).join('')}</div>` : ''}
      <h2>Book ${esc(p.name.split(' ')[0])}</h2>
      ${svcs.map(s => `<a class="card row" href="#/book/${s.id}?pro=${p.id}"><span>${s.icon} ${esc(s.name)}</span><span class="price">${som(s.price)}</span></a>`).join('')}
      <p class="muted small">💡 Rebook ${esc(p.name.split(' ')[0])} through Usta and you stay covered by payment protection and the 30-day warranty.</p>
      <h2>Reviews (${p.reviews})</h2>
      ${p.reviews_list.map(r => `<div class="card"><div class="row"><b>${esc(r.name)}</b><span class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span></div>
        <div class="muted small">${esc(r.service)} · ${ago(r.created_at)}</div>${r.body ? `<p style="margin:6px 0 0">${esc(r.body)}</p>` : ''}</div>`).join('') || '<p class="muted">No reviews yet.</p>'}`;
    $('#fav')?.addEventListener('click', async e => { const r = await api('/favorites/' + id, { method: 'POST' }); e.target.textContent = r.favorite ? '❤️ Saved' : '🤍 Save'; });
  },
  async book(sid, q) {
    if (role() !== 'customer') { toast('Sign in to book'); return go('#/login?next=' + encodeURIComponent(location.hash)); }
    const c = await catalog(); const { svc, cat } = findService(c, sid); if (!svc) return views.notfound();
    const pros = await api('/pros?category=' + cat.id);
    const st = { pro: q.get('pro') || '', date: localISO(new Date()).slice(0, 10), slot: null, recurrence: 'none', photos: [] };
    const minAny = new Date(Date.now() + 2 * 3600e3); minAny.setMinutes(0, 0, 0); minAny.setHours(minAny.getHours() + 1);
    const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; });
    app.innerHTML = `<a href="#/c/${cat.id}">‹ ${esc(cat.name)}</a><h1>${esc(svc.name)}</h1><p class="muted">${som(svc.price)} ${esc(svc.unit)} · fixed price</p>
      <form id="f">
        <label>How many? (${esc(svc.unit.replace('per ', ''))})</label><input name="qty" type="number" min="1" max="500" value="${svc.default_qty}">
        ${cat.recurring ? `<label>How often?</label><div class="chips" id="rec">${[['none', 'One time'], ['weekly', 'Weekly −10%'], ['biweekly', 'Every 2 weeks −10%'], ['monthly', 'Monthly −10%']].map(([v, t]) => `<button type="button" class="chip ${v === 'none' ? 'on' : ''}" data-r="${v}">${t}</button>`).join('')}</div>` : ''}
        <label>Choose your pro</label>
        <div id="pros">
          <label class="card pro" style="margin:6px 0;cursor:pointer;font-weight:400"><input type="radio" name="pro" value="" style="width:auto;min-height:0"><div class="grow"><b>⚡ First available pro</b><div class="muted small">Fastest. Any ID-verified ${esc(cat.name.toLowerCase())} pro</div></div></label>
          ${pros.map(p => `<label class="card" style="margin:6px 0;cursor:pointer;font-weight:400;display:flex;gap:10px;align-items:center"><input type="radio" name="pro" value="${p.id}" style="width:auto;min-height:0"><div class="grow">${proRow(p)}</div></label>`).join('')}
        </div>
        <div id="when"></div>
        <label>District</label><select name="district">${c.districts.map(d => `<option>${d}</option>`).join('')}</select>
        <label>Address</label><input name="address" required placeholder="Street, building, apartment" autocomplete="street-address">
        <label>Notes for the pro <span class="muted">(optional)</span></label><textarea name="notes" placeholder="Describe the problem, floor, intercom code…"></textarea>
        <label>Photos <span class="muted">(optional, helps the pro prepare)</span></label><div class="gallery" id="ph"></div>
        <div class="sticky-cta"><div class="row"><span class="muted" id="sum"></span><b class="price" id="tot"></b></div>
          <p class="muted small" style="margin:6px 0 10px">🔒 You're charged only after you confirm the job is done. Free cancellation up to 24 h before.</p>
          <button class="block" id="submit">Book now</button></div>
      </form>`;
    const f = $('#f');
    f.querySelector(`input[name=pro][value="${st.pro}"]`)?.setAttribute('checked', '');
    const qty = () => Math.max(1, parseInt(f.qty.value) || 1);
    const total = () => { const base = svc.price * qty(); const disc = st.recurrence !== 'none' ? Math.round(base * 0.1) : 0; $('#tot').textContent = som(base - disc); $('#sum').textContent = `${qty()} × ${som(svc.price)}${disc ? ` − ${som(disc)} plan discount` : ''}`; };
    const renderPhotos = () => { $('#ph').innerHTML = st.photos.map((p, i) => `<div class="ph" style="background-image:url('${p.url}')"><button type="button" data-rm="${i}">✕</button></div>`).join('') + (st.photos.length < 8 ? '<div class="addph" id="addph">＋<br>Add photo</div>' : '');
      $('#addph')?.addEventListener('click', async () => { st.photos.push(...await upload('job', true)); renderPhotos(); });
      $('#ph').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { st.photos.splice(+b.dataset.rm, 1); renderPhotos(); }); };
    async function renderWhen() {
      st.slot = null; const el = $('#when');
      if (!st.pro) { el.innerHTML = `<label>When?</label><input name="at" type="datetime-local" min="${localISO(minAny).slice(0, 16)}" value="${localISO(minAny).slice(0, 16)}">`; return; }
      el.innerHTML = `<label>Pick a day and time</label><div class="hscroll">${days.map(d => { const v = localISO(d).slice(0, 10); return `<button type="button" class="day ${v === st.date ? 'on' : ''}" data-d="${v}">${DAYS[d.getDay()]}<b>${d.getDate()}</b></button>`; }).join('')}</div><div id="slots" class="slots"><span class="muted">Loading…</span></div>`;
      el.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { st.date = b.dataset.d; renderWhen(); });
      const r = await api(`/pros/${st.pro}/slots?service_id=${svc.id}&qty=${qty()}&date=${st.date}`);
      $('#slots').innerHTML = r.slots.map(s => `<button type="button" class="slot" data-s="${s.at}">${s.label}</button>`).join('') || '<span class="muted" style="grid-column:1/-1">No free time on this day. Try another day.</span>';
      $('#slots').querySelectorAll('[data-s]').forEach(b => b.onclick = () => { $('#slots').querySelectorAll('.slot').forEach(x => x.classList.remove('on')); b.classList.add('on'); st.slot = b.dataset.s; });
    }
    f.qty.oninput = () => { total(); if (st.pro) renderWhen(); };
    f.querySelectorAll('input[name=pro]').forEach(r => r.onchange = () => { st.pro = r.value; renderWhen(); });
    $('#rec')?.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { $('#rec').querySelectorAll('.chip').forEach(x => x.classList.remove('on')); b.classList.add('on'); st.recurrence = b.dataset.r; total(); });
    if (!f.querySelector('input[name=pro]:checked')) f.querySelector('input[name=pro]').checked = true;
    total(); renderPhotos(); renderWhen();
    f.onsubmit = async e => {
      e.preventDefault();
      const at = st.pro ? st.slot : (f.at.value && new Date(f.at.value).toISOString());
      if (!at) return toast('Pick a time');
      $('#submit').disabled = true;
      try {
        const b = await api('/bookings', { method: 'POST', body: { service_id: svc.id, qty: qty(), pro_id: st.pro || null, scheduled_at: at, district: f.district.value, address: f.address.value, notes: f.notes.value, recurrence: st.recurrence, photo_ids: st.photos.map(p => p.id) } });
        location.href = b.pay_url;
      } catch (err) { toast(err.message); $('#submit').disabled = false; if (st.pro) renderWhen(); }
    };
  },
  async login(_, q) {
    const asPro = q.get('role') === 'pro';
    app.innerHTML = `<h1>${asPro ? 'Earn with Usta' : 'Welcome to Usta'}</h1>
      ${asPro ? `<div class="card"><b>Why pros choose Usta</b><ul class="muted" style="margin:8px 0 0;padding-left:18px;line-height:1.7">
        <li>💰 <b>Guaranteed pay</b>: the client's money is held before you head out</li><li>📍 Jobs near you, with no advertising costs</li>
        <li>📅 You set your own hours. Clients book only your free slots</li><li>🔁 Only 5% commission when a client books you again (12% the first time)</li>
        <li>⭐ Reviews build your profile, so you win more jobs</li></ul></div>` : '<p class="muted">Sign in with your phone number. No password needed.</p>'}
      <form id="f" class="card"><label style="margin-top:0">Phone number</label><input name="phone" inputmode="tel" placeholder="0700 123 456" required autocomplete="tel">
        <div id="step2" hidden><label>6-digit code from SMS</label><input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
        <div id="nm" hidden><label>Your name</label><input name="name" placeholder="${asPro ? 'Name or team name' : 'First name'}"></div></div>
        <div class="actions"><button id="b" class="block">Send code</button></div></form>
      <p class="muted small">Demo: customer = 0709 999 999 or any new number · pro = 0700 111 111 · admin = 0700 000 000</p>`;
    const f = $('#f'); let sent = false;
    f.onsubmit = async e => {
      e.preventDefault(); $('#b').disabled = true;
      try {
        if (!sent) {
          const r = await api('/auth/request', { method: 'POST', body: { phone: f.phone.value } });
          sent = true; $('#step2').hidden = false; $('#nm').hidden = r.exists; $('#b').textContent = r.exists ? 'Sign in' : 'Create account';
          if (r.dev_code) { f.code.value = r.dev_code; toast('Demo mode: code filled in automatically'); }
        } else {
          const r = await api('/auth/verify', { method: 'POST', body: { phone: f.phone.value, code: f.code.value, name: f.name.value, role: asPro ? 'pro' : 'customer' } });
          state.token = r.token; localStorage.setItem('usta_token', r.token); await loadMe();
          go(q.get('next') || (role() === 'pro' ? (state.me.pro.status === 'verified' ? '#/jobs' : '#/profile') : role() === 'admin' ? '#/admin' : '#/'));
        }
      } catch (err) { toast(err.message); }
      $('#b').disabled = false;
    };
  },
  async bookings(_, q) {
    if (!role()) return go('#/login');
    const list = await api('/bookings'); const tab = q.get('t') || (role() === 'admin' ? 'all' : 'up');
    const isPro = role() === 'pro';
    const filters = role() === 'admin' ? [['all', 'All'], ['disputed', 'Disputes'], ['up', 'Active']] : [['up', 'Upcoming'], ['past', 'Past']];
    const shown = list.filter(b => tab === 'all' ? true : tab === 'disputed' ? b.status === 'disputed' : tab === 'up' ? UPCOMING.includes(b.status) : !UPCOMING.includes(b.status));
    if (tab === 'up') shown.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    app.innerHTML = `<h1>${isPro ? 'Schedule' : role() === 'admin' ? 'Bookings' : 'Bookings'}</h1>
      <div class="seg">${filters.map(([k, t]) => `<a href="#/bookings?t=${k}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>
      ${shown.map(b => `<a class="card" href="#/b/${b.id}"><div class="row top-a"><div><b>${b.icon} ${esc(b.title)}</b><div class="muted small">${when(b.scheduled_at)} · ${esc(b.district)}</div></div>${badge(b.status)}</div>
        <div class="row" style="margin-top:8px"><span class="muted small">${isPro ? esc(b.customer_name) : b.pro_name ? esc(b.pro_name) : 'Pro not assigned yet'}${b.recurrence !== 'none' ? ' · 🔁 ' + b.recurrence : ''}</span><b>${som(isPro ? b.payout : b.price + b.tip)}</b></div></a>`).join('')
        || empty(tab === 'up' ? '📅' : '🗂️', tab === 'up' ? 'No upcoming bookings.' : 'Nothing here yet.', role() === 'customer' && tab === 'up' ? '<a class="btn" href="#/">Book a service</a>' : isPro ? '<a class="btn" href="#/jobs">Find jobs</a>' : '')}`;
  },
  async booking(id) {
    if (!role()) return go('#/login?next=' + encodeURIComponent(location.hash));
    const b = await api('/bookings/' + id);
    const me = state.me.user, isPro = role() === 'pro', isCust = b.customer_id === me.id, isAdmin = role() === 'admin';
    const mine = isPro && b.pro_id === me.id && !['open', 'assigned'].includes(b.status);
    const step = Math.max(FLOW.indexOf(b.status === 'assigned' ? 'open' : b.status === 'disputed' ? 'awaiting_confirmation' : b.status), 0);
    const today = new Date().toISOString().slice(0, 10);
    const A = [];
    if (isPro && (b.status === 'open' || (b.status === 'assigned' && b.pro_id === me.id))) A.push(['accept', `Accept · earn ${som(b.payout)}`]);
    if (isPro && b.status === 'assigned' && b.pro_id === me.id) A.push(['decline', 'Decline', 'ghost']);
    if (mine && b.status === 'accepted') A.push(['start', "I've arrived, start the job"], ['release', "I can't make it", 'ghost']);
    if (mine && b.status === 'in_progress') A.push(['finish', '✓ Mark job as done']);
    if (isCust && b.status === 'unpaid') A.push(['pay', `Pay ${som(b.price)}`]);
    if (isCust && b.status === 'awaiting_confirmation') A.push(['confirm', 'Confirm & pay']);
    if (isAdmin && b.status === 'disputed') A.push(['confirm', 'Resolve: pay the pro'], ['refund', 'Resolve: refund the client', 'danger']);
    if (isCust && (b.status === 'awaiting_confirmation' || (b.status === 'completed' && b.warranty_until >= today))) A.push(['dispute', b.status === 'completed' ? '🛡️ Warranty claim' : 'Report a problem', 'ghost']);
    if ((isCust || isAdmin) && ['unpaid', 'open', 'assigned', 'accepted'].includes(b.status)) A.push(['cancel', 'Cancel booking', 'ghost']);
    if (isCust && b.recurrence !== 'none' && UPCOMING.includes(b.status)) A.push(['stop-recurring', 'Stop repeating', 'ghost']);
    const showChat = b.pro_id && (isCust || mine || isAdmin);
    app.innerHTML = `<a href="#/bookings">‹ Bookings</a>
      <div class="card"><div class="row top-a"><div><h1>${b.icon} ${esc(b.title)}</h1><div class="muted small">Booking #${b.id}${b.recurrence !== 'none' ? ' · 🔁 Repeats ' + b.recurrence : ''}</div></div>${badge(b.status)}</div>
        ${['cancelled', 'refunded'].includes(b.status) ? '' : `<div class="steps">${FLOW.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>`}
        ${!isPro ? (b.pro_id ? `<a href="#/pro/${b.pro_id}" class="pro" style="color:inherit;margin:8px 0">${avatar(b.pro_name, b.pro_avatar)}<div class="grow"><b>${esc(b.pro_name)}</b><div class="muted small">Your pro · view profile ›</div></div></a>` : '<p>⏳ We\'re matching you with a verified pro. You\'ll get a notification as soon as someone accepts.</p>') : ''}
        <div class="list-item"><span class="muted">When</span><b>${when(b.scheduled_at)}</b></div>
        <div class="list-item"><span class="muted">Where</span><span style="text-align:right">${esc(b.address)}${b.address.includes(b.district) ? '' : ', ' + esc(b.district)}</span></div>
        ${b.service_id ? `<div class="list-item"><span class="muted">Amount</span><span>${b.qty} · ${esc(b.unit)}</span></div>` : ''}
        ${isPro || isAdmin ? `<div class="list-item"><span class="muted">Client</span><span>${esc(b.customer_name)}</span></div>` : ''}
        <div class="list-item"><span class="muted">${isPro ? 'Your payout' : 'Price'}</span><b>${som(isPro ? b.payout : b.price)}${!isPro && b.tip ? ` + ${som(b.tip)} tip` : ''}</b></div>
        <div class="list-item"><span class="muted">Payment</span><span>${{ pending: '⏳ Not paid yet', none: '—', refund_pending: '↩️ Refund in progress', held: '🔒 Held securely', released: '✅ Paid to pro', refunded: '↩️ Refunded', partial_refund: `↩️ Refunded minus ${som(b.cancel_fee)} late fee` }[b.payment]}</span></div>
        ${b.warranty_until ? `<div class="list-item"><span class="muted">Warranty</span><span>🛡️ until ${dateOnly(b.warranty_until)}</span></div>` : ''}
        ${b.notes ? `<p class="muted">“${esc(b.notes)}”</p>` : ''}
        ${b.photos.length ? `<div class="gallery" style="margin-top:8px">${b.photos.map(x => `<a class="ph" href="${x.url}" target="_blank" style="background-image:url('${x.url}')"></a>`).join('')}</div>` : ''}
        <div class="actions" id="acts">${A.map(([a, t, cls]) => `<button class="${cls || ''}" data-a="${a}">${t}</button>`).join('')}</div>
        <div id="tipbox" hidden><label>Add a tip for ${esc((b.pro_name || '').split(' ')[0])}? <span class="muted">100% goes to the pro</span></label>
          <div class="tip-opts">${[0, 100, 200, 500].map(t => `<button type="button" class="chip ${t === 0 ? 'on' : ''}" data-tip="${t}">${t ? som(t) : 'No tip'}</button>`).join('')}</div>
          <button class="block" id="payNow" style="margin-top:10px">Release ${som(b.price)}</button></div>
        ${isCust && b.status === 'completed' && b.service_id && b.pro_id ? `<a class="btn ghost block" style="margin-top:10px" href="#/book/${b.service_id}?pro=${b.pro_id}">🔁 Book ${esc((b.pro_name || '').split(' ')[0])} again</a>` : ''}
      </div>
      ${isCust && b.status === 'completed' && !b.my_rating ? `<div class="card"><h3>How did ${esc(b.pro_name)} do?</h3>
        <div class="chips" id="rt" style="margin-top:10px">${[5, 4, 3, 2, 1].map(r => `<button type="button" class="chip ${r === 5 ? 'on' : ''}" data-r="${r}">${'★'.repeat(r)}</button>`).join('')}</div>
        <textarea id="rb" placeholder="What did they do well?" style="margin-top:10px"></textarea><div class="actions"><button id="rv">Submit review</button></div></div>` : ''}
      ${showChat ? `<div class="card"><h3>Chat</h3><p class="muted small" style="margin:4px 0 0">🔒 For your safety, phone numbers are hidden. Keep everything in Usta so you stay covered.</p>
        <div class="chat" id="chat"></div>
        ${isAdmin ? '' : `<form id="cf" class="row"><input name="t" placeholder="Message…" autocomplete="off"><button>Send</button></form>`}</div>` : ''}`;
    let tip = 0, rating = 5;
    app.querySelectorAll('[data-a]').forEach(btn => btn.onclick = async () => {
      const a = btn.dataset.a; let payload = {};
      if (a === 'pay') { const r = await api(`/bookings/${id}/pay`, { method: 'POST' }).catch(e => toast(e.message)); if (r) location.href = r.pay_url; return; }
      if (a === 'confirm' && isCust) { $('#tipbox').hidden = false; $('#acts').hidden = true; return; }
      if (a === 'dispute') { const reason = prompt('What went wrong? Our team will review it within 24 hours.'); if (!reason) return; payload = { reason }; }
      if (a === 'cancel') { const late = b.status === 'accepted' && Date.parse(b.scheduled_at) - Date.now() < 24 * 3600e3; if (!confirm(late ? `It's less than 24 h before the visit, so a ${som(Math.round(b.price * 0.2))} late-cancellation fee goes to the pro. Cancel anyway?` : 'Cancel this booking? You will get a full refund.')) return; }
      if (a === 'release' && !confirm('Release this job? It goes back to other pros. Doing this often hurts your ranking.')) return;
      btn.disabled = true;
      try { await api(`/bookings/${id}/${a}`, { method: 'POST', body: payload }); toast('Done'); a === 'release' || a === 'decline' ? go('#/jobs') : route(); } catch (e) { toast(e.message); btn.disabled = false; }
    });
    app.querySelectorAll('[data-tip]').forEach(c => c.onclick = () => { app.querySelectorAll('[data-tip]').forEach(x => x.classList.remove('on')); c.classList.add('on'); tip = +c.dataset.tip; $('#payNow').textContent = `Release ${som(b.price + tip)}`; });
    $('#payNow')?.addEventListener('click', async () => { try { const r = await api(`/bookings/${id}/confirm`, { method: 'POST', body: { tip } }); if (r.tip_pay_url) return (location.href = r.tip_pay_url); toast('Payment released. Thank you!'); route(); } catch (e) { toast(e.message); } });
    app.querySelectorAll('#rt [data-r]').forEach(c => c.onclick = () => { app.querySelectorAll('#rt .chip').forEach(x => x.classList.remove('on')); c.classList.add('on'); rating = +c.dataset.r; });
    $('#rv')?.addEventListener('click', async () => { try { await api(`/bookings/${id}/review`, { method: 'POST', body: { rating, body: $('#rb').value } }); toast('Thanks for the review!'); route(); } catch (e) { toast(e.message); } });
    if (showChat) {
      let last = -1;
      const loadChat = async () => {
        const msgs = await api(`/bookings/${id}/messages`).catch(() => null); if (!msgs || msgs.length === last) return; last = msgs.length;
        const el = $('#chat'); if (!el) return;
        el.innerHTML = msgs.map(m => `<div class="msg ${m.sender_id === me.id ? 'me' : ''}">${m.sender_id === me.id ? '' : `<small>${esc(m.name)}</small>`}${esc(m.body)}</div>`).join('') || '<span class="muted small">No messages yet. Say hi 👋</span>';
        el.scrollTop = el.scrollHeight;
      };
      loadChat(); every(5000, loadChat);
      $('#cf')?.addEventListener('submit', async e => { e.preventDefault(); const t = e.target.t.value; if (!t.trim()) return; e.target.t.value = ''; try { await api(`/bookings/${id}/messages`, { method: 'POST', body: { text: t } }); last = -1; loadChat(); } catch (er) { toast(er.message); } });
    }
  },
  // ----- quotes (custom jobs) -----
  async quoteNew(_, q) {
    if (role() !== 'customer') { toast('Sign in to request quotes'); return go('#/login?next=' + encodeURIComponent(location.hash)); }
    const c = await catalog(); const photos = [];
    const d = new Date(Date.now() + 864e5); d.setHours(10, 0, 0, 0);
    app.innerHTML = `<a href="javascript:history.back()">‹ Back</a><h1>Get quotes</h1><p class="muted">Describe the job. Verified pros send you their price, and you choose the one you like. There's no obligation to hire.</p>
      <form id="f">
        <label>Category</label><select name="category_id">${c.categories.map(k => `<option value="${k.id}" ${q.get('cat') == k.id ? 'selected' : ''}>${k.icon} ${esc(k.name)}</option>`).join('')}</select>
        <label>What do you need?</label><input name="title" placeholder="e.g. Replace bathroom tiles, 6 m²" maxlength="100" required>
        <label>Details</label><textarea name="description" placeholder="Size, materials, what's broken, access, deadlines…" required></textarea>
        <label>Photos <span class="muted">(pros quote more accurately with photos)</span></label><div class="gallery" id="ph"></div>
        <label>District</label><select name="district">${c.districts.map(x => `<option>${x}</option>`).join('')}</select>
        <label>Address <span class="muted">(shared only with the pro you hire)</span></label><input name="address" required placeholder="Street, building, apartment">
        <label>Preferred date</label><input name="preferred_at" type="datetime-local" value="${localISO(d).slice(0, 16)}" required>
        <div class="sticky-cta"><button class="block" id="submit">Request quotes</button></div>
      </form>`;
    const renderPhotos = () => { $('#ph').innerHTML = photos.map(p => `<div class="ph" style="background-image:url('${p.url}')"></div>`).join('') + (photos.length < 8 ? '<div class="addph" id="addph">＋<br>Add photo</div>' : ''); $('#addph')?.addEventListener('click', async () => { photos.push(...await upload('job', true)); renderPhotos(); }); };
    renderPhotos();
    $('#f').onsubmit = async e => {
      e.preventDefault(); const f = e.target; $('#submit').disabled = true;
      try { const r = await api('/requests', { method: 'POST', body: { ...Object.fromEntries(new FormData(f)), preferred_at: new Date(f.preferred_at.value).toISOString(), photo_ids: photos.map(p => p.id) } }); toast('Request sent to pros'); go('#/r/' + r.id); }
      catch (er) { toast(er.message); $('#submit').disabled = false; }
    };
  },
  async requests() {
    if (role() !== 'customer') return go('#/login');
    const list = await api('/requests');
    app.innerHTML = `<div class="row"><h1>Quotes</h1><a class="btn sm" href="#/quote/new">＋ New</a></div>
      ${list.map(r => `<a class="card" href="#/r/${r.id}"><div class="row top-a"><b>${r.icon} ${esc(r.title)}</b><span class="badge ${r.status === 'open' ? 'warn' : r.status === 'hired' ? 'ok' : ''}">${r.status === 'open' ? `${r.quote_count} quote${r.quote_count === 1 ? '' : 's'}` : r.status}</span></div>
        <div class="muted small">${esc(r.category)} · posted ${ago(r.created_at)}</div></a>`).join('')
        || empty('💬', 'Need something that is not on the price list? Describe it and verified pros will send you their price.', '<a class="btn" href="#/quote/new">Get quotes</a>')}`;
  },
  async request(id) {
    if (!role()) return go('#/login');
    const r = await api('/requests/' + id);
    const isPro = role() === 'pro';
    const head = `<div class="card"><div class="row top-a"><h1>${r.icon} ${esc(r.title)}</h1><span class="badge ${r.status === 'open' ? 'warn' : r.status === 'hired' ? 'ok' : ''}">${r.status}</span></div>
      <div class="muted small">${esc(r.category)} · ${esc(r.customer_name)} · posted ${ago(r.created_at)}</div>
      <p>${esc(r.description)}</p>
      ${r.photos.length ? `<div class="gallery">${r.photos.map(x => `<a class="ph" href="${x.url}" target="_blank" style="background-image:url('${x.url}')"></a>`).join('')}</div>` : ''}
      <div class="list-item"><span class="muted">Where</span><span>${esc(r.address)}</span></div>
      <div class="list-item"><span class="muted">Preferred</span><b>${when(r.preferred_at)}</b></div></div>`;
    if (isPro) {
      const mq = r.my_quote;
      app.innerHTML = `<a href="#/leads">‹ Leads</a>${head}
        ${mq?.status === 'accepted' ? `<div class="card">🎉 You were hired at <b>${som(mq.price)}</b>. <a href="#/b/${r.booking_id}">Open job ›</a></div>`
          : mq?.status === 'declined' ? '<div class="card muted">The client chose another pro this time.</div>'
          : r.status !== 'open' ? '' : `<form class="card" id="qf"><h3>${mq ? 'Update your quote' : 'Send a quote'}</h3><p class="muted small" style="margin:4px 0 0">${r.quote_count} pro${r.quote_count === 1 ? ' has' : 's have'} quoted. You pay no fee to quote, only 12% commission if you're hired.</p>
            <label>Your price (som, all-inclusive)</label><input name="price" type="number" min="100" required value="${mq?.price || ''}">
            <label>Message to the client</label><textarea name="message" placeholder="What's included, how long it takes, materials…">${esc(mq?.message || '')}</textarea>
            <p class="muted small">You'll receive <b id="net">—</b> after the 12% commission.</p><button class="block">${mq ? 'Update quote' : 'Send quote'}</button></form>`}`;
      const qf = $('#qf');
      if (qf) {
        const net = () => $('#net').textContent = qf.price.value ? som(Math.round(qf.price.value * 0.88)) : '—'; qf.price.oninput = net; net();
        qf.onsubmit = async e => { e.preventDefault(); try { await api(`/requests/${id}/quotes`, { method: 'POST', body: { price: qf.price.value, message: qf.message.value } }); toast('Quote sent'); route(); } catch (er) { toast(er.message); } };
      }
      return;
    }
    app.innerHTML = `<a href="#/requests">‹ Quotes</a>${head}
      ${r.status === 'hired' ? `<a class="btn block" href="#/b/${r.booking_id}">View booking ›</a>` : ''}
      <h2>Quotes (${r.quotes.length})</h2>
      ${r.quotes.map(qt => `<div class="card"><a href="#/pro/${qt.pro.id}" style="color:inherit">${proRow(qt.pro, `<b class="price">${som(qt.price)}</b>`)}</a>
        ${qt.message ? `<p style="margin:10px 0 0">${esc(qt.message)}</p>` : ''}
        ${r.status === 'open' ? `<div class="actions"><button data-hire="${qt.id}" class="block">Hire for ${som(qt.price)}</button></div>` : qt.status === 'accepted' ? '<p><span class="badge ok">Hired</span></p>' : ''}</div>`).join('')
        || (r.status === 'open' ? empty('⏳', 'Waiting for quotes. We notified every verified pro in this category. Most requests get their first quote within an hour.') : '')}
      ${r.status === 'open' ? '<div class="actions"><button class="ghost" id="close">Close request</button></div>' : ''}`;
    app.querySelectorAll('[data-hire]').forEach(b => b.onclick = async () => {
      if (!confirm('Hire this pro? We hold the payment and release it only after you confirm the job is done.')) return;
      try { const bk = await api(`/requests/${id}/hire`, { method: 'POST', body: { quote_id: +b.dataset.hire } }); location.href = bk.pay_url; } catch (e) { toast(e.message); }
    });
    $('#close')?.addEventListener('click', async () => { if (confirm('Close this request? Pros will no longer be able to quote.')) { await api(`/requests/${id}/close`, { method: 'POST' }); route(); } });
  },
  // ----- pro -----
  async jobs() {
    if (role() !== 'pro') return go('#/login?role=pro');
    await loadMe(); const { pro, stats, user } = state.me;
    if (pro.status !== 'verified') {
      const steps = [['Add a profile photo', !!user.avatar], ['Choose your services', pro.categories.length > 0], ['Write about yourself', !!pro.bio], ['Upload your passport / ID', pro.has_id_photo], ['Take a selfie', pro.has_selfie]];
      const done = steps.filter(s => s[1]).length;
      app.innerHTML = `<h1>Get verified</h1><div class="card">${pro.status === 'rejected' ? '❌ Verification was not approved. Please re-upload clear ID photos.' : `⏳ Complete your profile and we'll verify you within 24 hours.`}
        <div class="bar" style="margin:12px 0"><i style="width:${done * 20}%"></i></div>
        ${steps.map(([t, ok]) => `<div class="list-item"><span>${ok ? '✅' : '⬜️'} ${t}</span></div>`).join('')}
        <a class="btn block" href="#/profile" style="margin-top:12px">Complete profile</a></div>`;
      return;
    }
    const [jobs, mine] = await Promise.all([api('/jobs/open'), api('/bookings')]);
    const todays = mine.filter(b => ['accepted', 'in_progress'].includes(b.status) && new Date(b.scheduled_at).toDateString() === new Date().toDateString());
    const direct = jobs.filter(j => j.status === 'assigned'), open = jobs.filter(j => j.status === 'open');
    const jobCard = j => `<div class="card"><a href="#/b/${j.id}" style="color:inherit"><div class="row top-a"><b>${j.icon} ${esc(j.title)}</b><b class="price">${som(j.payout)}</b></div>
        <div class="muted small">${when(j.scheduled_at)} · ${esc(j.district)} · ${j.qty} · ${esc(j.unit)}${j.recurrence !== 'none' ? ' · 🔁 ' + j.recurrence : ''}</div>${j.notes ? `<p class="muted small">“${esc(j.notes.slice(0, 120))}”</p>` : ''}</a>
        <div class="actions"><button data-acc="${j.id}" class="sm">Accept</button>${j.status === 'assigned' ? `<button data-dec="${j.id}" class="ghost sm">Decline</button>` : ''}<span class="muted small" style="align-self:center">🔒 Payment already held</span></div></div>`;
    app.innerHTML = `<h1>Hi, ${esc(user.name.split(' ')[0])} 👋</h1>
      <div class="stat"><div><span class="muted small">Balance</span><b>${som(pro.balance)}</b></div><div><span class="muted small">Rating</span><b>${stats.rating ? '★ ' + stats.rating : '—'}</b><span class="muted small">${stats.jobs} jobs</span></div></div>
      ${todays.length ? `<h2>Today</h2>${todays.map(b => `<a class="card row" href="#/b/${b.id}"><div><b>${new Date(b.scheduled_at).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })} · ${esc(b.title)}</b><div class="muted small">${esc(b.address)}</div></div>${badge(b.status)}</a>`).join('')}` : ''}
      ${direct.length ? `<h2>Requested you (${direct.length})</h2>${direct.map(jobCard).join('')}` : ''}
      <h2>Open jobs near you (${open.length})</h2>
      ${open.map(jobCard).join('') || empty('🧰', "No open jobs right now. We'll notify you as soon as one comes in. Tip: check your quote leads too.", '<a class="btn ghost" href="#/leads">See leads</a>')}`;
    app.querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => { b.disabled = true; try { await api(`/bookings/${b.dataset.acc}/accept`, { method: 'POST' }); toast('Job accepted ✓'); go('#/b/' + b.dataset.acc); } catch (e) { toast(e.message); route(); } });
    app.querySelectorAll('[data-dec]').forEach(b => b.onclick = async () => { await api(`/bookings/${b.dataset.dec}/decline`, { method: 'POST' }).catch(e => toast(e.message)); route(); });
    every(30000, () => { if (location.hash !== '#/jobs') return; route.keepScroll = true; route().finally(() => route.keepScroll = false); });
  },
  async leads() {
    if (role() !== 'pro') return go('#/login?role=pro');
    const list = await api('/requests');
    const label = r => r.my_quote ? (r.my_quote.status === 'accepted' ? '<span class="badge ok">Hired</span>' : r.my_quote.status === 'declined' ? '<span class="badge">Not chosen</span>' : `<span class="badge brand">Quoted ${som(r.my_quote.price)}</span>`) : `<span class="badge warn">${r.quote_count} quotes</span>`;
    app.innerHTML = `<h1>Leads</h1><p class="muted">Custom jobs from clients. Send your price: quoting is free, and you only pay commission if you're hired.</p>
      ${list.map(r => `<a class="card" href="#/r/${r.id}"><div class="row top-a"><b>${r.icon} ${esc(r.title)}</b>${label(r)}</div>
        <div class="muted small">${esc(r.district)} · for ${when(r.preferred_at)} · ${ago(r.created_at)}${r.photos.length ? ` · 📷 ${r.photos.length}` : ''}</div>
        <p class="muted small" style="margin:6px 0 0">${esc(r.description.slice(0, 120))}${r.description.length > 120 ? '…' : ''}</p></a>`).join('')
        || empty('💬', state.me?.pro.status === 'verified' ? 'No leads in your categories yet.' : 'Get verified to see leads.')}`;
  },
  async earnings() {
    if (role() !== 'pro') return go('#/login?role=pro');
    const e = await api('/pro/earnings');
    app.innerHTML = `<h1>Earnings</h1>
      <div class="card" style="background:var(--brand);color:var(--brand-ink);border:0"><div class="small" style="opacity:.85">Available to withdraw</div><div style="font-size:32px;font-weight:800">${som(e.balance)}</div>
        <button id="po" style="background:var(--brand-ink);color:var(--brand);margin-top:8px" ${e.balance > 0 ? '' : 'disabled'}>Withdraw to card / Mbank</button></div>
      <div class="stat"><div><span class="muted small">This week</span><b>${som(e.week)}</b></div><div><span class="muted small">All time</span><b>${som(e.total)}</b></div>
        <div><span class="muted small">Tips received</span><b>${som(e.tips)}</b></div><div><span class="muted small">Upcoming (${e.upcoming.n} jobs)</span><b>${som(e.upcoming.amount)}</b></div></div>
      <h2>Completed jobs</h2><div class="card">${e.jobs.map(j => `<a class="list-item" href="#/b/${j.id}" style="color:inherit"><div><div>${esc(j.title)}</div><div class="muted small">${dateOnly(j.completed_at)} · ${som(j.price)} − ${som(j.commission)} fee${j.tip ? ` + ${som(j.tip)} tip` : ''}</div></div><b>${som(j.payout)}</b></a>`).join('') || '<span class="muted">No completed jobs yet.</span>'}
        ${e.fees.map(f => `<div class="list-item"><div><div>${esc(f.title)}</div><div class="muted small">Late-cancellation fee</div></div><b>${som(f.cancel_fee)}</b></div>`).join('')}</div>
      <h2>Withdrawals</h2><div class="card">${e.payouts.map(p => `<div class="list-item"><span>${ago(p.created_at)}</span><span>${som(p.amount)} <span class="badge ${p.status === 'paid' ? 'ok' : 'warn'}">${p.status}</span></span></div>`).join('') || '<span class="muted">No withdrawals yet.</span>'}</div>`;
    $('#po').onclick = async () => { try { const r = await api('/pro/payout', { method: 'POST' }); toast(`Withdrawal of ${som(r.amount)} requested. It usually arrives within 1 business day.`); route(); } catch (er) { toast(er.message); } };
  },
  async profile() {
    if (role() !== 'pro') return go('#/account');
    await loadMe(); const c = await catalog(); const { user, pro } = state.me;
    const order = [1, 2, 3, 4, 5, 6, 0];
    app.innerHTML = `<div class="row"><h1>Profile</h1>${pro.status === 'verified' ? `<a class="btn ghost sm" href="#/pro/${user.id}">View public ›</a>` : ''}</div>
      <div class="card pro">${avatar(user.name, user.avatar, 'lg')}<div class="grow"><b>${esc(user.name)}</b><div>${pro.status === 'verified' ? '<span class="badge ok">✓ Verified</span>' : pro.status === 'rejected' ? '<span class="badge bad">Rejected</span>' : '<span class="badge warn">Pending verification</span>'}</div>
        <button class="ghost sm" id="av" style="margin-top:8px">📷 ${user.avatar ? 'Change' : 'Add'} photo</button></div></div>
      <form id="f">
        <label>Name</label><input name="name" value="${esc(user.name)}">
        <label>Services you offer</label><div class="chips">${c.categories.map(k => `<label class="chip"><input type="checkbox" name="cat" value="${k.id}" ${pro.categories.includes(k.id) ? 'checked' : ''}>${k.icon} ${esc(k.name)}</label>`).join('')}</div>
        <label>Home district</label><select name="district">${c.districts.map(d => `<option ${pro.district === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
        <label>About you</label><textarea name="bio" placeholder="Experience, tools, specialties. Clients read this before booking.">${esc(pro.bio || '')}</textarea>
        <label>Working hours <span class="muted">(clients can only book these times)</span></label>
        <div class="card">${order.map(d => { const h = pro.hours[d]; return `<div class="hours-row"><label><input type="checkbox" data-day="${d}" ${h ? 'checked' : ''}> ${DAYS[d]}</label>
          <select data-from="${d}">${[...Array(24)].map((_, i) => `<option value="${i}" ${(h ? h[0] : 9) === i ? 'selected' : ''}>${String(i).padStart(2, '0')}:00</option>`).join('')}</select>
          <select data-to="${d}">${[...Array(24)].map((_, i) => `<option value="${i + 1}" ${(h ? h[1] : 19) === i + 1 ? 'selected' : ''}>${String(i + 1).padStart(2, '0')}:00</option>`).join('')}</select></div>`; }).join('')}</div>
        <label>Work photos <span class="muted">(pros with photos get 2–3× more bookings)</span></label>
        <div class="gallery" id="pf">${pro.portfolio.map(p => `<div class="ph" style="background-image:url('${p.url}')"><button type="button" data-del="${p.id}">✕</button></div>`).join('')}${pro.portfolio.length < 12 ? '<div class="addph" id="addpf">＋<br>Add photos</div>' : ''}</div>
        <h2>Verification</h2><p class="muted small">Only Usta staff can see these. They are never shown to clients.</p>
        <label>Passport / ID number</label><input name="id_note" value="${esc(pro.id_note || '')}" placeholder="ID1234567">
        <div class="actions"><button type="button" class="ghost" id="idp">${pro.has_id_photo ? '✅ ID photo uploaded' : '🪪 Upload ID photo'}</button><button type="button" class="ghost" id="sf">${pro.has_selfie ? '✅ Selfie uploaded' : '🤳 Take a selfie'}</button></div>
        <div class="sticky-cta"><button class="block">Save profile</button></div></form>
      <div class="actions"><button class="ghost block" id="lo">Sign out</button></div>`;
    const refresh = () => route();
    $('#av').onclick = async () => { if ((await upload('avatar')).length) { toast('Photo updated'); refresh(); } };
    $('#addpf')?.addEventListener('click', async () => { if ((await upload('portfolio', true)).length) refresh(); });
    app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/photos/' + b.dataset.del, { method: 'DELETE' }); refresh(); });
    $('#idp').onclick = async () => { if ((await upload('id')).length) { toast('ID uploaded'); refresh(); } };
    $('#sf').onclick = async () => { if ((await upload('selfie', false, true)).length) { toast('Selfie uploaded'); refresh(); } };
    $('#lo').onclick = logout;
    $('#f').onsubmit = async e => {
      e.preventDefault(); const f = e.target; const hours = {};
      order.forEach(d => { if (f.querySelector(`[data-day="${d}"]`).checked) hours[d] = [+f.querySelector(`[data-from="${d}"]`).value, +f.querySelector(`[data-to="${d}"]`).value]; });
      try { await api('/pro/profile', { method: 'PUT', body: { name: f.name.value, bio: f.bio.value, district: f.district.value, id_note: f.id_note.value, hours, categories: [...f.querySelectorAll('[name=cat]:checked')].map(x => +x.value) } }); toast('Profile saved'); refresh(); } catch (er) { toast(er.message); }
    };
  },
  async account() {
    if (!role()) return go('#/login'); if (role() === 'pro') return go('#/profile');
    const { user } = state.me;
    app.innerHTML = `<h1>Account</h1>
      <div class="card pro">${avatar(user.name, user.avatar, 'lg')}<div class="grow"><b>${esc(user.name)}</b><div class="muted small">${esc(user.phone)}</div><button class="ghost sm" id="av" style="margin-top:8px">📷 Change photo</button></div></div>
      <form class="card" id="f"><label style="margin-top:0">Name</label><input name="name" value="${esc(user.name)}"><div class="actions"><button class="sm">Save</button></div></form>
      ${role() === 'customer' ? `<a class="card row" href="#/requests"><span>💬 My quote requests</span><span>›</span></a><a class="card row" href="#/bookings?t=past"><span>🗂️ Past bookings &amp; receipts</span><span>›</span></a>
        <div class="card"><b>🛡️ The Usta guarantee</b><p class="muted small" style="margin:6px 0 0">Every job booked and paid through Usta is covered by a 30-day warranty. If something goes wrong, open the booking and tap “Warranty claim”.</p></div>` : ''}
      <button class="ghost block" id="lo">Sign out</button>`;
    $('#av').onclick = async () => { if ((await upload('avatar')).length) { await loadMe(); route(); } };
    $('#f').onsubmit = async e => { e.preventDefault(); await api('/me', { method: 'PUT', body: { name: e.target.name.value } }); await loadMe(); toast('Saved'); };
    $('#lo').onclick = logout;
  },
  async notifications() {
    if (!role()) return go('#/login');
    const list = await api('/notifications');
    app.innerHTML = `<h1>Notifications</h1><div class="card" style="padding:0;overflow:hidden">${list.map(n => `<a class="notif ${n.read ? '' : 'unread'}" href="${esc(n.link || '#/')}"><div>${esc(n.body)}</div><div class="muted small">${ago(n.created_at)}</div></a>`).join('') || empty('🔔', "You're all caught up.")}</div>`;
    if (list.some(n => !n.read)) { await api('/notifications/read', { method: 'POST' }); state.me.unread = 0; renderChrome(); }
  },
  // ----- admin -----
  async admin(sub) {
    if (role() !== 'admin') return go('#/login');
    if (sub === 'verify') return views.adminVerify();
    if (sub === 'payouts') return views.adminPayouts();
    const s = await api('/admin/stats'); const max = Math.max(1, ...s.by_category.map(c => c.gmv));
    const take = s.bookings.gmv ? (100 * s.bookings.revenue / s.bookings.gmv).toFixed(1) : '0';
    app.innerHTML = `<h1>Dashboard</h1>
      <div class="stat"><div><span class="muted small">GMV (completed)</span><b>${som(s.bookings.gmv)}</b></div><div><span class="muted small">Revenue · ${take}% take</span><b>${som(s.bookings.revenue)}</b></div>
        <div><span class="muted small">Completed jobs</span><b>${s.bookings.completed || 0}</b></div><div><span class="muted small">Active now</span><b>${s.bookings.active || 0}</b></div>
        <div><span class="muted small">Waiting for a pro</span><b>${s.bookings.unassigned || 0}</b></div><div><span class="muted small">Repeat client↔pro pairs</span><b>${s.repeat_pairs}</b></div>
        <div><span class="muted small">Verified pros</span><b>${s.pros.verified || 0}</b></div><div><span class="muted small">Customers</span><b>${s.customers}</b></div></div>
      ${s.bookings.disputes ? `<a class="card row" href="#/bookings?t=disputed" style="border-color:var(--bad)"><b>⚠️ ${s.bookings.disputes} open dispute${s.bookings.disputes > 1 ? 's' : ''}</b><span>Resolve ›</span></a>` : ''}
      ${s.pros.pending ? `<a class="card row" href="#/admin/verify"><b>🪪 ${s.pros.pending} pro${s.pros.pending > 1 ? 's' : ''} waiting for verification</b><span>Review ›</span></a>` : ''}
      ${s.payouts_pending ? `<a class="card row" href="#/admin/payouts"><b>💸 ${som(s.payouts_pending)} in pending payouts</b><span>Pay ›</span></a>` : ''}
      <h2>GMV by category</h2><div class="card">${s.by_category.map(c => `<div style="margin:8px 0"><div class="row small"><span>${c.icon} ${esc(c.name)} · ${c.bookings} bookings</span><b>${som(c.gmv)}</b></div><div class="bar"><i style="width:${100 * c.gmv / max}%"></i></div></div>`).join('')}</div>
      <p class="muted small">Open quote requests: ${s.open_requests} · Cancelled bookings: ${s.bookings.cancelled || 0}</p>`;
  },
  async adminVerify() {
    const pros = await api('/admin/pros');
    app.innerHTML = `<h1>Verification</h1>
      ${pros.map(p => `<div class="card"><div class="pro">${avatar(p.name, p.avatar)}<div class="grow"><div class="row"><b>${esc(p.name)}</b>${p.status === 'verified' ? '<span class="badge ok">verified</span>' : p.status === 'rejected' ? '<span class="badge bad">rejected</span>' : '<span class="badge warn">pending</span>'}</div>
        <div class="muted small">${esc(p.phone)} · ${esc(p.district || '—')} · ${esc(p.cats || 'no categories')} · ${p.jobs} jobs</div></div></div>
        <p class="small">${esc(p.bio || 'No bio')}</p><div class="muted small">ID number: ${esc(p.id_note || '—')}</div>
        ${p.id_photo || p.selfie ? `<div class="gallery" style="margin-top:8px">${p.id_photo ? `<div class="ph" data-priv="${p.id_photo}" title="ID"></div>` : ''}${p.selfie ? `<div class="ph" data-priv="${p.selfie}" title="Selfie"></div>` : ''}</div>` : '<p class="muted small">⚠️ No ID photos uploaded</p>'}
        <div class="actions">${p.status !== 'verified' ? `<button class="sm" data-v="${p.user_id}" data-d="verified">✓ Verify</button>` : ''}${p.status !== 'rejected' ? `<button class="ghost sm" data-v="${p.user_id}" data-d="rejected">Reject</button>` : ''}</div></div>`).join('')}`;
    app.querySelectorAll('[data-priv]').forEach(el => privateImg(el, el.dataset.priv));
    app.querySelectorAll('[data-v]').forEach(b => b.onclick = async () => { await api(`/admin/pros/${b.dataset.v}/${b.dataset.d}`, { method: 'POST' }); toast('Updated'); route(); });
  },
  async adminPayouts() {
    const list = await api('/admin/payouts');
    app.innerHTML = `<h1>Payouts</h1><div class="card">${list.map(p => `<div class="list-item"><div><b>${esc(p.name)}</b><div class="muted small">${esc(p.phone)} · ${ago(p.created_at)}</div></div>
      <div style="text-align:right"><b>${som(p.amount)}</b><br>${p.status === 'paid' ? '<span class="badge ok">paid</span>' : `<button class="sm" data-paid="${p.id}">Mark paid</button>`}</div></div>`).join('') || '<span class="muted">No payout requests.</span>'}</div>`;
    app.querySelectorAll('[data-paid]').forEach(b => b.onclick = async () => { await api(`/admin/payouts/${b.dataset.paid}/paid`, { method: 'POST' }); route(); });
  },
  notfound() { app.innerHTML = empty('🤷', 'Page not found.', '<a class="btn" href="#/">Home</a>'); },
};

// ---------- router ----------
function go(h) { if (location.hash === h) route(); else location.hash = h; }
async function route() {
  state.timers.forEach(clearInterval); state.timers = [];
  const [p, qs] = (location.hash.slice(1) || '/').split('?'); const q = new URLSearchParams(qs); const parts = p.split('/').filter(Boolean);
  const map = { '': 'home', search: 'search', c: 'category', pro: 'pro', book: 'book', login: 'login', bookings: 'bookings', b: 'booking', quote: 'quoteNew', requests: 'requests', r: 'request', jobs: 'jobs', leads: 'leads', earnings: 'earnings', profile: 'profile', account: 'account', notifications: 'notifications', admin: 'admin' };
  const v = views[map[parts[0] || '']] || views.notfound;
  renderChrome();
  try { await v(parts[1], q); } catch (e) { app.innerHTML = `<div class="card">⚠️ ${esc(e.message)}</div>`; }
  if (!route.keepScroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
(async () => {
  await loadMe(); route();
  setInterval(async () => { if (!state.token) return; const prev = state.me?.unread; await loadMe(); if (state.me && state.me.unread > (prev || 0)) toast('🔔 New notification'); }, 20000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
