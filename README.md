# Model Quality Test

Multi-provider model quality probe for five groups: OpenAI, Anthropic, Google, Sakana, and Image. The app is designed for Vercel deployment with PostgreSQL-backed logs and TOTP-only admin access.

## Features

- OpenAI tests use the Responses endpoint by default.
- Anthropic tests keep the existing Claude channel and thinking probes.
- Google tests target Gemini `models/*:generateContent`.
- Sakana tests target Fugu through an OpenAI-compatible Responses shape.
- Image probes inherit the model selected for each endpoint (`gpt-image-2` remains the default, but is not forced) and run in four ordered stages: Base64/URL return capability; real `/v1/images/edits` compositing with `1/2/4/8` input images; a `quality` (`low`/`medium`/`high`) × size matrix (`1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840`, `auto`); then output `n=2/4/8` at 1K low quality. The 24 matrix cells use a fixed palette of distinct cube colors while keeping the rest of the composition unchanged. Edit inputs use a fixed target scene and seven distinct reference objects, render beside the result, and run serially for comparable latency. The server downloads every returned image (or decodes Base64), records its actual byte size and PNG/JPEG/WebP dimensions, and fails explicit-size cells unless returned pixels exactly match; `auto` accepts any successfully parsed dimensions selected by the model. File sizes render with each result. PDF export embeds original PNG/JPEG bytes without resizing or quality reduction; WebP is converted losslessly to PNG only for TeX compatibility. Image bytes are never persisted to PostgreSQL logs.
- Batch concurrency uses one shared queue across all currently visible test categories; workers may execute questions from different task groups at the same time.
- Text test requests (OpenAI Responses, Anthropic Messages, Google, Sakana) are issued as **streaming (SSE)** calls; the server reassembles the stream into the same final JSON a buffered call would return, so usage/cost/logging are unchanged. Image generation stays non-streaming. Anthropic requests send the `claude-cli/2.1.198 (external, cli)` User-Agent.
- Every test run is logged to PostgreSQL and can be exported from the admin panel.
- Cost estimates are calculated from a local PostgreSQL `model_prices` table synchronized from `https://models.dev/api.json`.
- Price sync stores only the provider/model rows needed by the five groups: OpenAI, Anthropic, Google, Sakana/Fugu, and Image. It does not persist unrelated providers from models.dev.
- The console uses a grouped sidebar: a Testing section (the five provider groups) and a Platform section (Endpoints, History, Admin). Within a group, probes are grouped into titled sections by category, and the card grid fills the full available width on widescreen.
- Sakana/Fugu only accepts `reasoning.effort` in `('high','xhigh','max')`; probe definitions using the Responses spec value `medium` are clamped up to `high` for the Sakana group while OpenAI keeps the original value. Endpoint defaults are `maxTokens=102400` and `timeout=600000` (10 min).
- Detail panels (Response / Request / Headers) render each JSON block with a one-click copy button.
- Each type (provider group) can hold multiple named endpoints — e.g. "官方", "代理A", "Azure" — each with its own Base URL / API key. An endpoint is **not bound to a single model**: it maintains a model list. Endpoint configuration is stored in PostgreSQL (globally shared); API keys are encrypted at rest. Nothing but the UI theme is kept in browser `localStorage`.
- Adding a channel requires a successful **model-list detection** (calls the channel's `/models` API with its key) before it can be saved. Detection returns the channel's full model list, shown as a **checkbox list in the detect panel**; you tick which models to **enable** for that endpoint, and save is gated on at least one enabled model. The full list and the enabled subset are stored on the endpoint. Lists refresh manually (同步模型) or automatically via the daily `/api/cron/sync` cron; a sync that drops a model upstream also prunes it from the enabled subset.
- The test page picks a target: select one or more endpoints, then pick one or more of each endpoint's **enabled models**. Every (question × endpoint × model) combination runs and renders side by side, including the Image group, so versioned or compatible GPT Image model slugs pass through unchanged.
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
