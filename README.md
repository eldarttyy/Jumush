# Usta — verified tradespeople & cleaners (Bishkek MVP)

Zero-dependency Node 22+ app (built-in `node:http` + `node:sqlite`).

    node server.js          # http://localhost:3000
    node --test test.js     # end-to-end API tests

Demo logins (dev mode auto-fills the SMS code): customer = any new number,
pro = 0700 111 111, admin = 0700 000 000.

## What's in it
- Customer: categories → fixed price list → pick pro or "first available" → book → held payment → confirm → review → 30-day warranty claim.
- Pro: ID-verification gate, job feed by category (address hidden until accept), atomic accept, start/finish, balance & withdrawal.
- Admin: verification queue, dispute resolution (pay pro / refund + claw back).
- Anti-leakage: payment held up front, phone/Telegram/WhatsApp masking in chat & reviews,
  warranty only on in-app jobs, commission drops 12% → 5% when a client rebooks the same pro.

## Not production yet
- Payments are simulated (`payment='held'`) — integrate Mbank / O!Dengi / Elsom / card acquiring.
- OTP is returned in the API response in dev — wire an SMS gateway and set NODE_ENV=production.
- ID verification is a text field — add document + selfie upload.
- English only — Russian/Kyrgyz localization needed before launch.
- No rate limiting, no push notifications, no geolocation matching.
