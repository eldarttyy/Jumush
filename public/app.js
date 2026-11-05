'use strict';
const $ = s => document.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const som = n => Number(n).toLocaleString('ru-RU') + ' сом';
const stars = r => r ? `<span class="stars">${'★'.repeat(Math.round(r))}${'☆'.repeat(5 - Math.round(r))}</span> ${r}` : '<span class="muted">New</span>';
const when = s => new Date(s).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
let state = { token: localStorage.getItem('usta_token'), me: null, catalog: null };

function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2500); }
async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && state.token) { logout(); }
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
function logout() { state.token = null; state.me = null; localStorage.removeItem('usta_token'); renderNav(); location.hash = '#/'; }
async function loadMe() { if (!state.token) return (state.me = null); try { state.me = await api('/me'); } catch { state.me = null; } }
async function catalog() { return state.catalog ||= await api('/catalog'); }
const role = () => state.me?.user.role;

const STATUS = {
  open: ['Looking for a pro', 'warn'], assigned: ['Waiting for pro', 'warn'], accepted: ['Pro confirmed', 'ok'],
  in_progress: ['In progress', 'ok'], awaiting_confirmation: ['Confirm the work', 'warn'], completed: ['Completed', 'ok'],
  disputed: ['Disputed', 'bad'], cancelled: ['Cancelled', ''], refunded: ['Refunded', ''],
};
const FLOW = ['open', 'accepted', 'in_progress', 'awaiting_confirmation', 'completed'];
const badge = s => `<span class="badge ${STATUS[s]?.[1] || ''}">${STATUS[s]?.[0] || s}</span>`;

function renderNav() {
  const r = role();
  const links = r === 'pro' ? [['#/jobs', 'Job feed'], ['#/bookings', 'My jobs'], ['#/profile', 'Profile']]
    : r === 'admin' ? [['#/admin', 'Admin'], ['#/bookings', 'All bookings']]
    : r === 'customer' ? [['#/', 'Services'], ['#/bookings', 'My bookings']] : [['#/', 'Services'], ['#/login?role=pro', 'Become a pro']];
  $('#nav').innerHTML = links.map(([h, t]) => `<a href="${h}">${t}</a>`).join('') + (r ? `<a href="#" id="lo">Sign out</a>` : `<a href="#/login">Sign in</a>`);
  $('#lo')?.addEventListener('click', e => { e.preventDefault(); logout(); });
}

// ---------- views ----------
const views = {
  async home() {
    if (role() === 'pro') return (location.hash = '#/jobs');
    if (role() === 'admin') return (location.hash = '#/admin');
    const c = await catalog();
    app.innerHTML = `
      <h1>Home repairs and cleaning, at fixed prices</h1>
      <p class="muted">Verified pros in Bishkek. You pay the listed price. We release the money only after you confirm the job.</p>
      <div class="grid">${c.categories.map(x => `<a class="card cat" href="#/c/${x.id}"><span class="ic">${x.icon}</span>${esc(x.name)}</a>`).join('')}</div>
      <h2>Why book through Usta</h2>
      <div class="trust">
        <div>🪪 <b>ID-verified</b><br><span class="muted">Every pro's passport is checked</span></div>
        <div>💰 <b>Fixed prices</b><br><span class="muted">No haggling on the spot</span></div>
        <div>🔒 <b>Pay after the job</b><br><span class="muted">Money is held until you confirm</span></div>
        <div>🛡️ <b>30-day warranty</b><br><span class="muted">Free redo if it breaks again</span></div>
      </div>`;
  },
  async category(id) {
    const c = await catalog(); const cat = c.categories.find(x => x.id == id); if (!cat) return views.notfound();
    const pros = await api('/pros?category=' + id);
    app.innerHTML = `<a href="#/">← All services</a><h1>${cat.icon} ${esc(cat.name)}</h1>
      <h2>Prices</h2>
      ${cat.services.map(s => `<div class="card row"><div><b>${esc(s.name)}</b><div class="muted">${esc(s.unit)} · ~${s.duration_min} min</div></div>
        <div style="text-align:right"><div class="price">${som(s.price)}</div><a class="btn" style="margin-top:6px" href="#/book/${s.id}">Book</a></div></div>`).join('')}
      <h2>Verified pros (${pros.length})</h2>
      ${pros.map(p => `<a class="card row" href="#/pro/${p.id}" style="color:inherit"><div><b>${esc(p.name)}</b> <span class="badge ok">Verified</span><div class="muted">${esc(p.district)} · ${p.jobs} jobs</div></div><div>${stars(p.rating)}</div></a>`).join('') || '<p class="muted">No pros yet. Book anyway and we will find you one.</p>'}`;
  },
  async pro(id) {
    const [p, c] = await Promise.all([api('/pros/' + id), catalog()]);
    app.innerHTML = `<a href="javascript:history.back()">← Back</a>
      <div class="card"><h1>${esc(p.name)} <span class="badge ok">ID verified</span></h1>
      <div>${stars(p.rating)} <span class="muted">· ${p.reviews} reviews · ${p.jobs} completed jobs · ${esc(p.district)}</span></div>
      <p>${esc(p.bio)}</p></div>
      <h2>Book ${esc(p.name.split(' ')[0])}</h2>
      <p class="muted">Rebook your pro through Usta and their commission drops to 5%. Your warranty and payment protection still apply.</p>
      <select id="svc">${c.categories.flatMap(k => k.services.map(s => `<option value="${s.id}">${k.icon} ${esc(s.name)} — ${som(s.price)}</option>`)).join('')}</select>
      <div class="actions"><button id="go">Continue</button></div>
      <h2>Reviews</h2>
      ${p.reviews_list.map(r => `<div class="card"><div class="row"><b>${esc(r.name)}</b>${stars(r.rating)}</div><div class="muted">${esc(r.service)}</div><p>${esc(r.body)}</p></div>`).join('') || '<p class="muted">No reviews yet.</p>'}`;
    $('#go').onclick = () => location.hash = `#/book/${$('#svc').value}?pro=${id}`;
  },
  async book(sid, q) {
    if (role() !== 'customer') { toast('Sign in to book'); return (location.hash = '#/login?next=' + encodeURIComponent(location.hash)); }
    const c = await catalog(); let svc, cat;
    for (const k of c.categories) for (const s of k.services) if (s.id == sid) { svc = s; cat = k; }
    if (!svc) return views.notfound();
    const pros = await api('/pros?category=' + cat.id);
    const min = new Date(Date.now() + 2 * 3600e3); min.setMinutes(0, 0, 0);
    const local = d => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
    app.innerHTML = `<a href="#/c/${cat.id}">← ${esc(cat.name)}</a><h1>${esc(svc.name)}</h1>
      <p class="muted">${som(svc.price)} ${esc(svc.unit)}</p>
      <form id="f">
        <label>Quantity (${esc(svc.unit.replace('per ', ''))})</label><input name="qty" type="number" min="1" value="1">
        <label>Pro</label><select name="pro_id"><option value="">First available verified pro (fastest)</option>
          ${pros.map(p => `<option value="${p.id}" ${q.get('pro') == p.id ? 'selected' : ''}>${esc(p.name)} — ${p.rating || 'new'}★, ${p.jobs} jobs</option>`).join('')}</select>
        <label>District</label><select name="district">${c.districts.map(d => `<option>${d}</option>`).join('')}</select>
        <label>Address</label><input name="address" required placeholder="Street, building, apartment">
        <label>When</label><input name="scheduled_at" type="datetime-local" required min="${local(min)}" value="${local(min)}">
        <label>Notes for the pro (optional)</label><textarea name="notes" placeholder="Describe the problem, floor, intercom code…"></textarea>
        <div class="card row"><span>Total, fixed</span><span class="price" id="tot">${som(svc.price)}</span></div>
        <p class="muted">🔒 We hold the payment and release it to the pro only after you confirm the work is done. If something goes wrong, you get a full refund. <i>(Demo build: no real money is taken.)</i></p>
        <button>Confirm booking</button>
      </form>`;
    const f = $('#f');
    f.qty.oninput = () => $('#tot').textContent = som(svc.price * Math.max(1, parseInt(f.qty.value) || 1));
    f.onsubmit = async e => {
      e.preventDefault(); const d = Object.fromEntries(new FormData(f));
      try { const b = await api('/bookings', { method: 'POST', body: { ...d, service_id: svc.id, scheduled_at: new Date(d.scheduled_at).toISOString() } }); toast('Booked!'); location.hash = '#/b/' + b.id; }
      catch (err) { toast(err.message); }
    };
  },
  async login(_, q) {
    const asPro = q.get('role') === 'pro';
    app.innerHTML = `<h1>${asPro ? 'Join as a pro' : 'Sign in'}</h1>
      ${asPro ? `<div class="card"><b>Why work through Usta</b><ul class="muted" style="margin:6px 0 0;padding-left:18px">
        <li>Guaranteed payment: the client's money is held before you go out</li><li>A steady flow of jobs near you, with no ad costs</li>
        <li>12% commission on new clients, and only 5% when a client books you again</li><li>Reviews build your profile, so you win more jobs</li></ul></div>` : ''}
      <form id="f"><label>Phone</label><input name="phone" inputmode="tel" placeholder="0700 123 456" required>
        <div id="step2" hidden><label>SMS code</label><input name="code" inputmode="numeric" maxlength="6">
        <label>Your name</label><input name="name" placeholder="For new accounts"></div>
        <div class="actions"><button id="b">Get code</button></div></form>
      <p class="muted">Demo accounts: customer: any new number · pro: 0700 111 111 · admin: 0700 000 000</p>`;
    const f = $('#f'); let sent = false;
    f.onsubmit = async e => {
      e.preventDefault();
      try {
        if (!sent) {
          const r = await api('/auth/request', { method: 'POST', body: { phone: f.phone.value } });
          sent = true; $('#step2').hidden = false; $('#b').textContent = 'Sign in';
          if (r.dev_code) { f.code.value = r.dev_code; toast('Dev mode: code auto-filled'); }
        } else {
          const r = await api('/auth/verify', { method: 'POST', body: { phone: f.phone.value, code: f.code.value, name: f.name.value, role: asPro ? 'pro' : 'customer' } });
          state.token = r.token; localStorage.setItem('usta_token', r.token); await loadMe(); renderNav();
          location.hash = q.get('next') || (role() === 'pro' ? (state.me.pro.status === 'verified' ? '#/jobs' : '#/profile') : '#/');
        }
      } catch (err) { toast(err.message); }
    };
  },
  async bookings() {
    if (!role()) return (location.hash = '#/login');
    const list = await api('/bookings');
    app.innerHTML = `<h1>${role() === 'pro' ? 'My jobs' : role() === 'admin' ? 'All bookings' : 'My bookings'}</h1>
      ${list.map(b => `<a class="card" href="#/b/${b.id}" style="display:block;color:inherit"><div class="row"><b>${b.icon} ${esc(b.service)}</b>${badge(b.status)}</div>
        <div class="muted">${when(b.scheduled_at)} · ${esc(b.district)} · ${som(role() === 'pro' ? b.price - b.commission : b.price)}${b.pro_name && role() !== 'pro' ? ' · ' + esc(b.pro_name) : ''}</div></a>`).join('') || '<p class="muted">Nothing here yet.</p>'}`;
  },
  async booking(id) {
    if (!role()) return (location.hash = '#/login');
    const [list, msgs] = await Promise.all([api('/bookings'), api(`/bookings/${id}/messages`).catch(() => [])]);
    const b = list.find(x => x.id == id); if (!b) return views.notfound();
    const me = state.me.user, isPro = role() === 'pro', isCust = role() === 'customer', isAdmin = role() === 'admin';
    const step = Math.max(FLOW.indexOf(b.status === 'assigned' ? 'open' : b.status), 0);
    const A = [];
    if (isPro && b.status === 'assigned') A.push(['accept', 'Accept job'], ['decline', 'Decline', 'ghost']);
    if (isPro && b.status === 'accepted') A.push(['start', "I've arrived, start job"]);
    if (isPro && b.status === 'in_progress') A.push(['finish', 'Mark as done']);
    if ((isCust || isAdmin) && b.status === 'awaiting_confirmation') A.push(['confirm', 'Confirm and release payment']);
    if ((isAdmin) && b.status === 'disputed') A.push(['confirm', 'Resolve: pay the pro'], ['refund', 'Resolve: refund the customer', 'danger']);
    if (isCust && (b.status === 'awaiting_confirmation' || (b.status === 'completed' && b.warranty_until >= new Date().toISOString().slice(0, 10)))) A.push(['dispute', b.status === 'completed' ? 'Warranty claim' : 'Report a problem', 'ghost']);
    if ((isCust || isAdmin) && ['open', 'assigned', 'accepted'].includes(b.status)) A.push(['cancel', 'Cancel', 'ghost']);
    app.innerHTML = `<a href="#/bookings">← Back</a>
      <div class="card"><div class="row"><h1>${b.icon} ${esc(b.service)}</h1>${badge(b.status)}</div>
        <div class="steps">${FLOW.map((_, i) => `<i class="${i <= step && !['cancelled', 'refunded'].includes(b.status) ? 'on' : ''}"></i>`).join('')}</div>
        <p>${when(b.scheduled_at)}<br>${esc(b.address)}, ${esc(b.district)}<br>Qty ${b.qty} · ${esc(b.unit)}</p>
        ${b.notes ? `<p class="muted">“${esc(b.notes)}”</p>` : ''}
        <div class="row"><span>${isPro ? 'Your payout' : 'Fixed price'}</span><span class="price">${som(isPro ? b.price - b.commission : b.price)}</span></div>
        <div class="muted">Payment: ${b.payment === 'held' ? '🔒 held by Usta' : b.payment === 'released' ? '✅ paid to pro' : '↩️ refunded'}
          ${b.warranty_until ? ` · 🛡️ warranty until ${b.warranty_until}` : ''}${!isPro && b.pro_name ? ` · Pro: ${esc(b.pro_name)}` : ''}${isPro || isAdmin ? ` · Client: ${esc(b.customer_name)}` : ''}</div>
        <div class="actions">${A.map(([a, t, cls]) => `<button class="${cls || ''}" data-a="${a}">${t}</button>`).join('')}</div>
      </div>
      ${isCust && b.status === 'completed' && !b.my_rating ? `<div class="card"><b>Rate ${esc(b.pro_name)}</b>
        <select id="rt"><option value="5">★★★★★ Excellent</option><option value="4">★★★★ Good</option><option value="3">★★★ OK</option><option value="2">★★ Poor</option><option value="1">★ Bad</option></select>
        <textarea id="rb" placeholder="What did they do well?"></textarea><div class="actions"><button id="rv">Submit review</button></div></div>` : ''}
      ${b.pro_id ? `<div class="card"><b>Chat</b> <span class="muted">· for your safety, phone numbers are hidden. Keep the job in Usta to stay covered by the warranty.</span>
        <div class="chat">${msgs.map(m => `<div class="msg ${m.sender_id === me.id ? 'me' : ''}"><b>${esc(m.name)}:</b> ${esc(m.body)}</div>`).join('') || '<span class="muted">No messages yet</span>'}</div>
        ${isAdmin ? '' : `<form id="cf" class="row"><input name="t" placeholder="Message…" autocomplete="off"><button>Send</button></form>`}</div>` : ''}`;
    app.querySelectorAll('[data-a]').forEach(btn => btn.onclick = async () => {
      const a = btn.dataset.a; let payload = {};
      if (a === 'dispute') { const reason = prompt('What went wrong?'); if (!reason) return; payload = { reason }; }
      if (a === 'cancel' && !confirm('Cancel this booking? You will get a full refund.')) return;
      try { await api(`/bookings/${id}/${a}`, { method: 'POST', body: payload }); toast('Updated'); route(); } catch (e) { toast(e.message); }
    });
    $('#rv')?.addEventListener('click', async () => { try { await api(`/bookings/${id}/review`, { method: 'POST', body: { rating: $('#rt').value, body: $('#rb').value } }); toast('Thanks!'); route(); } catch (e) { toast(e.message); } });
    $('#cf')?.addEventListener('submit', async e => { e.preventDefault(); const t = e.target.t.value; if (!t.trim()) return; try { await api(`/bookings/${id}/messages`, { method: 'POST', body: { text: t } }); route(); } catch (er) { toast(er.message); } });
  },
  async jobs() {
    if (role() !== 'pro') return (location.hash = '#/login?role=pro');
    await loadMe(); const p = state.me.pro;
    if (p.status !== 'verified') return (app.innerHTML = `<h1>Job feed</h1><div class="card">${p.status === 'rejected' ? '❌ Verification was rejected. Update your profile and try again.' : '⏳ Your profile is waiting for verification. Complete your profile and we will check your ID within 24 hours.'}</div><a class="btn" href="#/profile">Go to profile</a>`);
    const jobs = await api('/jobs/open');
    app.innerHTML = `<h1>Job feed</h1>
      <div class="card row"><div><div class="muted">Balance</div><div class="price" style="font-size:22px">${som(p.balance)}</div><div class="muted">${stars(state.me.stats.rating)} · ${state.me.stats.jobs} jobs</div></div><button id="po" ${p.balance > 0 ? '' : 'disabled'}>Withdraw</button></div>
      ${jobs.map(j => `<div class="card"><div class="row"><b>${j.icon} ${esc(j.service)}</b>${j.status === 'assigned' ? '<span class="badge ok">Requested you</span>' : ''}</div>
        <div class="muted">${when(j.scheduled_at)} · ${esc(j.address)} · Qty ${j.qty} · ${esc(j.unit)}</div>${j.notes ? `<p class="muted">“${esc(j.notes)}”</p>` : ''}
        <div class="row"><span>Guaranteed payout <span class="muted">(already held)</span></span><span class="price">${som(j.payout)}</span></div>
        <div class="actions"><button data-acc="${j.id}">Accept</button></div></div>`).join('') || '<p class="muted">No open jobs in your categories right now.</p>'}`;
    app.querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => { try { await api(`/bookings/${b.dataset.acc}/accept`, { method: 'POST' }); toast('Job accepted'); location.hash = '#/b/' + b.dataset.acc; } catch (e) { toast(e.message); route(); } });
    $('#po').onclick = async () => { try { const r = await api('/pro/payout', { method: 'POST' }); toast(`Withdrawal of ${som(r.amount)} requested`); route(); } catch (e) { toast(e.message); } };
  },
  async profile() {
    if (role() !== 'pro') return (location.hash = '#/login?role=pro');
    await loadMe(); const c = await catalog(); const { user, pro } = state.me;
    app.innerHTML = `<h1>Your pro profile</h1>
      <div class="card">Status: ${pro.status === 'verified' ? '<span class="badge ok">Verified</span>' : pro.status === 'rejected' ? '<span class="badge bad">Rejected</span>' : '<span class="badge warn">Pending verification</span>'}</div>
      <form id="f"><label>Name</label><input name="name" value="${esc(user.name)}">
        <label>What do you do?</label><div class="chips">${c.categories.map(k => `<label><input type="checkbox" name="cat" value="${k.id}" ${pro.categories.includes(k.id) ? 'checked' : ''}>${k.icon} ${esc(k.name)}</label>`).join('')}</div>
        <label>District</label><select name="district">${c.districts.map(d => `<option ${pro.district === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
        <label>About you</label><textarea name="bio" placeholder="Experience, tools, specialties">${esc(pro.bio)}</textarea>
        <label>Passport / ID number (for verification)</label><input name="id_note" value="${esc(pro.id_note)}" placeholder="ID AN1234567">
        <p class="muted">In the full version you will upload a photo of your ID and a selfie here.</p>
        <button>Save</button></form>`;
    $('#f').onsubmit = async e => {
      e.preventDefault(); const f = e.target;
      try { await api('/pro/profile', { method: 'PUT', body: { name: f.name.value, bio: f.bio.value, district: f.district.value, id_note: f.id_note.value, categories: [...f.querySelectorAll('[name=cat]:checked')].map(x => +x.value) } }); toast('Saved'); route(); } catch (er) { toast(er.message); }
    };
  },
  async admin() {
    if (role() !== 'admin') return (location.hash = '#/login');
    const pros = await api('/admin/pros');
    app.innerHTML = `<h1>Verification queue</h1>
      ${pros.map(p => `<div class="card"><div class="row"><b>${esc(p.name)}</b>${p.status === 'verified' ? '<span class="badge ok">verified</span>' : p.status === 'rejected' ? '<span class="badge bad">rejected</span>' : '<span class="badge warn">pending</span>'}</div>
        <div class="muted">${esc(p.phone)} · ${esc(p.district || '—')} · ${esc(p.cats || 'no categories')}</div><div class="muted">ID: ${esc(p.id_note || '—')}</div><p>${esc(p.bio || '')}</p>
        <div class="actions">${p.status !== 'verified' ? `<button data-v="${p.user_id}" data-d="verified">Verify</button>` : ''}${p.status !== 'rejected' ? `<button class="ghost" data-v="${p.user_id}" data-d="rejected">Reject</button>` : ''}</div></div>`).join('')}`;
    app.querySelectorAll('[data-v]').forEach(b => b.onclick = async () => { await api(`/admin/pros/${b.dataset.v}/${b.dataset.d}`, { method: 'POST' }); toast('Done'); route(); });
  },
  notfound() { app.innerHTML = '<h1>Not found</h1><a href="#/">Home</a>'; },
};

async function route() {
  const [p, qs] = (location.hash.slice(1) || '/').split('?'); const q = new URLSearchParams(qs); const parts = p.split('/').filter(Boolean);
  const map = { '': 'home', c: 'category', pro: 'pro', book: 'book', login: 'login', bookings: 'bookings', b: 'booking', jobs: 'jobs', profile: 'profile', admin: 'admin' };
  const v = views[map[parts[0] || '']] || views.notfound;
  try { await v(parts[1], q); window.scrollTo(0, 0); } catch (e) { app.innerHTML = `<div class="card">⚠️ ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);
(async () => { await loadMe(); renderNav(); route(); })();
