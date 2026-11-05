// SMS providers. Pick with SMS_PROVIDER=console|twilio|nikita.
'use strict';

const xmlEsc = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const need = (env, keys, name) => {
  const missing = keys.filter(k => !env[k]);
  if (missing.length) throw new Error(`SMS provider "${name}" needs env vars: ${missing.join(', ')}`);
};

function createSms(env = process.env, fetchImpl = globalThis.fetch) {
  const provider = env.SMS_PROVIDER || 'console';

  if (provider === 'console') {
    // Development only: prints the message to the server log.
    return { name: 'console', async send(to, text) { console.log(`[sms → ${to}] ${text}`); } };
  }

  if (provider === 'twilio') {
    // https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
    need(env, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], 'twilio');
    if (!env.TWILIO_FROM && !env.TWILIO_MESSAGING_SERVICE_SID) throw new Error('SMS provider "twilio" needs TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID');
    return {
      name: 'twilio',
      async send(to, text) {
        const form = new URLSearchParams({ To: to, Body: text });
        if (env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID); else form.set('From', env.TWILIO_FROM);
        const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form,
        });
        if (!r.ok) throw new Error(`Twilio error ${r.status}: ${(await r.text()).slice(0, 200)}`);
      },
    };
  }

  if (provider === 'nikita') {
    // Nikita SMS Pro (smspro.nikita.kg), the most common local gateway in Kyrgyzstan.
    // ⚠️ VERIFY against the API spec Nikita sends you with your contract. This follows
    // their XML format as commonly integrated (login/pwd/id/sender/text/phones, status 0 = accepted),
    // but we could not find public docs to confirm it. Your sender name must be approved by Nikita first.
    need(env, ['NIKITA_LOGIN', 'NIKITA_PASSWORD', 'NIKITA_SENDER'], 'nikita');
    const url = env.NIKITA_API_URL || 'https://smspro.nikita.kg/api/message';
    return {
      name: 'nikita',
      async send(to, text) {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const xml = `<?xml version="1.0" encoding="UTF-8"?><message><login>${xmlEsc(env.NIKITA_LOGIN)}</login><pwd>${xmlEsc(env.NIKITA_PASSWORD)}</pwd>` +
          `<id>${id}</id><sender>${xmlEsc(env.NIKITA_SENDER)}</sender><text>${xmlEsc(text)}</text><phones><phone>${xmlEsc(to.replace(/^\+/, ''))}</phone></phones>` +
          `${env.NIKITA_TEST === '1' ? '<test>1</test>' : ''}</message>`;
        const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xml });
        const body = await r.text();
        const status = (body.match(/<status>(\d+)<\/status>/) || [])[1];
        if (!r.ok || status !== '0') throw new Error(`Nikita SMS error (HTTP ${r.status}, status ${status ?? '?'}): ${body.slice(0, 200)}`);
      },
    };
  }

  throw new Error(`Unknown SMS_PROVIDER "${provider}". Use console, twilio or nikita.`);
}

module.exports = { createSms };
