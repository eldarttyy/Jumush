# Usta — verified tradespeople & cleaners (Bishkek)

Zero-dependency Node 22+ app (built-in `node:http` + `node:sqlite`).

    node server.js          # http://localhost:3000
    node --test test.js     # end-to-end API tests

Demo logins (with `SMS_PROVIDER=console` the code is auto-filled): customer `0709 999 999` or any new number,
pro `0700 111 111`, admin `0700 000 000`.

## Configuration

| Variable | Values | Notes |
|---|---|---|
| `PAYMENT_PROVIDER` | `mock` (default), `odengi`, `mbank` | `mock` serves a test checkout at `/pay/mock/:id`. `odengi`/`mbank` are adapter slots in `lib/payments.js` that need the merchant API spec (not public). |
| `SMS_PROVIDER` | `console` (default), `twilio`, `nikita` | `console` logs codes and returns them to the client (dev only). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | | for `twilio` |
| `NIKITA_LOGIN`, `NIKITA_PASSWORD`, `NIKITA_SENDER`, `NIKITA_API_URL`, `NIKITA_TEST=1` | | for `nikita`. ⚠️ verify the XML format against the spec Nikita gives you; sender name must be approved |
| `OTP_SECRET` | random string | required in production (codes are stored as HMAC hashes) |
| `BASE_URL` | e.g. `https://usta.kg` | used for payment return / webhook URLs |
| `NODE_ENV=production` | | refuses `mock` payments / `console` SMS unless `ALLOW_DEMO_PROVIDERS=1` |
| `TRUST_PROXY=1` | | use `X-Forwarded-For` for per-IP rate limits behind a proxy |

## Payment flow

1. Booking is created as `unpaid` and reserves the slot for 30 minutes; pros can't see it yet.
2. Client pays at the provider checkout → webhook (`POST /api/payments/webhook/:provider`) marks it paid → booking goes live (`open` / `assigned` / `accepted` for quotes).
3. Usta holds the money; on client confirmation it moves to the pro's balance; pros withdraw, admin marks payouts paid.
4. Cancellations refund in full, or minus the 20% late fee. Refunds the provider can't do automatically show up for admin as "manual refund".
5. Tips are a separate payment, 100% to the pro. Recurring visits are reserved and the client pays for each one.

Webhook handling is idempotent; payments that arrive after a booking expired are refunded automatically.

⚠️ Collecting money on behalf of pros may require payment-agent status from the National Bank of the Kyrgyz Republic. Get legal advice before launch.

## Languages

Russian (default) and English. Server messages and notifications: `lib/i18n.js`; UI: `public/i18n.js`.
Notifications are stored in the recipient's language.
