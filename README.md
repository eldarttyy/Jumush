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

## Deploying the web app

- **Docker:** `docker build -t usta . && docker run -p 3000:3000 -v usta-data:/data --env-file .env usta`
- **Render:** New → Blueprint → this repo (`render.yaml`). Fill in `BASE_URL` and the Twilio keys.

⚠️ `ALLOW_DEMO_PROVIDERS=1` with `PAYMENT_PROVIDER=mock` means anyone can mark a payment as paid. That's fine for a demo, never with real customers.

## Android & iOS apps (`mobile/`)

Capacitor 8 wraps the same `public/` UI into native apps (`kg.usta.app`). The UI ships inside the app and calls your server at `USTA_API_URL`.

**Build in the cloud (no Mac needed):** GitHub → Actions → "Mobile apps" runs on every push to `main`:
- `usta-android-debug-apk`: install directly on an Android phone
- `usta-ios-simulator`: runs in the iOS Simulator
- with signing secrets: `usta-android-release` (`.aab` for Google Play) and `usta-ios-ipa` (for TestFlight / App Store)

Set repository **variable** `USTA_API_URL` (e.g. `https://usta.onrender.com`). Signing **secrets**:

| Platform | Secrets |
|---|---|
| Android | `ANDROID_KEYSTORE_BASE64` (`base64 -w0 release.jks`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` |
| iOS | `IOS_CERT_P12_BASE64` (Apple Distribution cert), `IOS_CERT_PASSWORD`, `IOS_PROVISION_PROFILE_BASE64` (App Store profile for `kg.usta.app`), `IOS_TEAM_ID` |

Create an Android keystore once: `keytool -genkey -v -keystore release.jks -alias usta -keyalg RSA -keysize 2048 -validity 10000`. **Back it up**: losing it means you can never update the Play Store app.

**Build locally:**

    cd mobile && npm install
    USTA_API_URL=https://your-server npm run android   # opens Android Studio
    USTA_API_URL=https://your-server npm run ios       # opens Xcode (macOS only)

The server allows the app origins (`capacitor://localhost`, `https://localhost`) through CORS. Add more with `CORS_ORIGINS`.
Payments open in an in-app browser (`@capacitor/browser`); closing it refreshes the booking.

Not yet: push notifications (need a Firebase project + APNs key), deep links back from the payment page.
