# Model Quality Test

Multi-provider model quality probe for five groups: OpenAI, Anthropic, Google, Sakana, and Image. The app is designed for Vercel deployment with PostgreSQL-backed logs and TOTP-only admin access.

## Features

- OpenAI tests use the Responses endpoint by default.
- Anthropic tests keep the existing Claude channel and thinking probes.
- Google tests target Gemini `models/*:generateContent`.
- Sakana tests target Fugu through an OpenAI-compatible Responses shape.
- Image tests target `gpt-image-2` and cover `n`, `quality`, `size`, and a small burst load test.
- Every test run is logged to PostgreSQL and can be exported from the admin panel.
- Cost estimates are calculated from a local PostgreSQL `model_prices` table synchronized from `https://models.dev/api.json`.
- Price sync stores only the provider/model rows needed by the five groups: OpenAI, Anthropic, Google, Sakana/Fugu, and Image. It does not persist unrelated providers from models.dev.
- The console uses a grouped sidebar: a Testing section (the five provider groups) and a Platform section (Endpoints, History, Admin).
- Each type (provider group) can hold multiple named endpoints — e.g. "官方", "代理A", "Azure" — each with its own Base URL / API key. An endpoint is **not bound to a single model**: it maintains a model list. Endpoint configuration is stored in PostgreSQL (globally shared); API keys are encrypted at rest. Nothing but the UI theme is kept in browser `localStorage`.
- Adding a channel requires a successful **model-list detection** (calls the channel's `/models` API with its key) before it can be saved. Detection returns the channel's full model list, shown as a **checkbox list in the detect panel**; you tick which models to **enable** for that endpoint, and save is gated on at least one enabled model. The full list and the enabled subset are stored on the endpoint. Lists refresh manually (同步模型) or automatically via the daily `/api/cron/sync` cron; a sync that drops a model upstream also prunes it from the enabled subset.
- The test page picks a target: select one or more endpoints, then pick one or more of each endpoint's **enabled models**. Every (question × endpoint × model) combination runs and renders side by side, so you can compare across endpoints and across models at once.
- First TOTP enrollment becomes the initial admin; later admins join through invite codes created by an admin.
- TOTP setup returns an otpauth URL rendered client-side as a QR with the qrbtf bundle, supports per-admin 2FA rotation, and rejects replayed TOTP counters.

## Local Development

```bash
npm install
npm run check
npm run preflight
npm run test:logic
npx vercel dev
```

Required environment variables:

```bash
DATABASE_URL=postgres://...
SESSION_SECRET=replace-with-a-long-random-secret
```

`DATABASE_URL` is required because auth, logs, and exports are database-backed. The API lazily creates the required tables, and the same DDL is also available in `schema.sql`.

## Deployment

Vercel does not provide the old built-in Vercel Postgres product as a normal new
database path. Use a Vercel Marketplace PostgreSQL integration such as Neon, or
bring an external PostgreSQL database and set `DATABASE_URL`.

Generate a Vercel Account Access Token from
`https://vercel.com/account/tokens`, then use it with the target team scope:

```bash
export VERCEL_TOKEN=...
export VERCEL_SCOPE=your-team-slug
npx vercel link --yes --project model-quality-test --token "$VERCEL_TOKEN" --scope "$VERCEL_SCOPE"
npx vercel install neon --name model-quality-test-db --environment production --environment preview --environment development --token "$VERCEL_TOKEN" --scope "$VERCEL_SCOPE"
```

Configure:

- `DATABASE_URL`: PostgreSQL connection string.
- `SESSION_SECRET`: HMAC secret for signed session cookies.
- Optional `CRON_SECRET`: protects the Vercel cron endpoint. Vercel Cron sends it as a bearer token when configured.
- Optional `PGSSLMODE=disable` for local non-SSL PostgreSQL.

When adding `CRON_SECRET` or other header-facing secrets through stdin, avoid a
trailing newline:

```bash
printf '%s' "$CRON_SECRET" | npx vercel env add CRON_SECRET production --token "$VERCEL_TOKEN" --scope "$VERCEL_SCOPE"
```

Deploy:

```bash
npx vercel deploy --prod --yes --token "$VERCEL_TOKEN" --scope "$VERCEL_SCOPE"
```

Open the deployed site, bind the first TOTP account, and that user becomes the first administrator. Create invite codes from the admin panel for additional administrators.

After the first admin login, click **Prices** once to seed `model_prices`. Vercel also runs `/api/cron/sync` daily at 02:00 UTC, which refreshes both the price table and every endpoint's model list. (Price sync and model-list sync share one function because the Hobby plan caps a deployment at 12 serverless functions.)

## Verification

Syntax and logic checks:

```bash
npm run check
npm run preflight
npm run test:logic
```

Strict deployment preflight:

```bash
DATABASE_URL=postgres://... SESSION_SECRET=... npm run preflight -- --strict-env
```

Database smoke test with a local PostgreSQL database:

```bash
DATABASE_URL='postgresql://user@%2Fvar%2Frun%2Fpostgresql/dbname' PGSSLMODE=disable npm run test:db
```

`test:db` verifies schema creation, price table writes, test-run logging, first-admin TOTP enrollment, invite-code enrollment, TOTP replay rejection, 2FA rotation, and TOTP login.

## Security Notes

The app is not intended to be fully public. Server APIs require a signed session, and admin-only endpoints require an admin role.

Endpoint configuration (Base URL, model, auth mode, limits, and the API key) is stored in PostgreSQL and shared globally across all admins. API keys are encrypted at rest with AES-256-GCM (`api/_lib/secrets.js`) using a key derived from `SESSION_SECRET`; they are decrypted server-side only for admins editing the Endpoints page and for outbound test calls. Keys are never written to the `test_runs` logs. Rotating `SESSION_SECRET` makes previously stored keys undecryptable — they degrade to empty and must be re-entered, the same trade-off the signed session cookies already make.
