// Payment providers. Pick with PAYMENT_PROVIDER=mock|odengi|mbank.
//
// Model: Usta collects the full price up front into its own merchant account ("held"),
// releases it to the pro's in-app balance when the client confirms, and pays pros out
// in batches. Local wallets don't offer card-style authorization holds, so "held"
// means "Usta holds the money", not a bank hold. ⚠️ Holding money on behalf of pros may
// need payment-agent status from the National Bank of the Kyrgyz Republic: check with a lawyer.
//
// Every provider implements:
//   createPayment({ id, amount, description, returnUrl, callbackUrl }) -> { providerRef, payUrl }
//   parseWebhook(headers, rawBody) -> { paymentId?, providerRef?, status: 'paid' | 'failed' }   (MUST verify the signature)
//   refund({ providerRef, amount }) -> { status: 'refunded' | 'refund_pending' }
'use strict';

class PaymentNotImplemented extends Error {}

function mock() {
  // Simulated checkout at /pay/mock/:id so the full flow works end to end without a merchant account.
  return {
    name: 'mock',
    async createPayment(p) { return { providerRef: 'mock_' + p.id, payUrl: `/pay/mock/${p.id}` }; },
    parseWebhook() { throw new Error('The mock provider uses /api/payments/mock/:id/:result instead of webhooks'); },
    async refund() { return { status: 'refunded' }; },
  };
}

// Adapter slots for real providers. Their merchant API specs are issued under contract and are not public,
// so these deliberately refuse to run instead of guessing field names or signature schemes.
// To finish one: implement the three methods from the provider's spec, add a test with a recorded webhook,
// and set the env vars below.
function pending(name, envVars, contact) {
  const fail = () => { throw new PaymentNotImplemented(`${name} adapter is not implemented yet. Get the merchant API spec (${contact}), then implement lib/payments.js → ${name.toLowerCase().replace(/\W/g, '')}(). Env vars it will need: ${envVars.join(', ')}`); };
  return { name: name.toLowerCase().replace(/\W/g, ''), createPayment: fail, parseWebhook: fail, refund: fail };
}
const odengi = () => pending('O!Dengi', ['ODENGI_MERCHANT_ID', 'ODENGI_SECRET', 'ODENGI_API_URL'], 'O! / dengi.kg business team');
const mbank = () => pending('Mbank', ['MBANK_MERCHANT_ID', 'MBANK_API_KEY', 'MBANK_API_URL'], 'Mbank MKassa / MBusiness merchant team');

function createPayments(env = process.env) {
  const p = env.PAYMENT_PROVIDER || 'mock';
  const factory = { mock, odengi, mbank }[p];
  if (!factory) throw new Error(`Unknown PAYMENT_PROVIDER "${p}". Use mock, odengi or mbank.`);
  return factory(env);
}

module.exports = { createPayments, PaymentNotImplemented };
