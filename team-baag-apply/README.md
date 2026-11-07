# TEAM_BAAG apply backend (server-side)

This service is the TEAM_BAAG recruitment website/backend. It is **independently deployable** from the website static files and from the Aiko Discord bot. The bot polls this backend over HTTPS using the shared API contract in `../../Aiko (bot)/RECRUITMENT.md` (authoritative for bot integration).

## Security (non-negotiable)
- **Never expose** `RECRUITMENT_API_KEY` / `BOT_API_KEY` to browser JavaScript or frontend bundles.
- All `/api/v1` bot-contract routes require `Authorization: Bearer RECRUITMENT_API_KEY` (including `/health`). The browser uses session cookies from Discord OAuth, not the API key.
- Discord identity is validated server-side via OAuth; membership is checked for the requested guild; applications are guild-scoped.
- Uploads are magic-byte validated (image/video) and never executed.

## Run
1. `npm install`
2. Copy `.env.example` to `.env` and fill values. Set the **same** `RECRUITMENT_API_KEY` in the bot host environment.
3. `node server.js` (or `npm start`).

## Storage
- Default: durable file store `data/recruitment.json` (keep on persistent host storage; do not publish).
- Optional: configure Supabase env vars; migrations in `migrations/` (001 legacy, 002 contract model).

## Key endpoints (RECRUITMENT.md)
- `GET  /api/v1/health`
- `POST /api/v1/applications` (session server-side or service)
- `GET  /api/v1/applications/?guild_id=&status=&limit=&cursor=` (keyset pagination)
- `GET  /api/v1/applications/:id?guild_id=`
- `GET  /api/v1/applications/:id/status?guild_id=`
- `POST /api/v1/applications/:id/analysis` (Idempotency-Key)
- `POST /api/v1/applications/:id/decision` (Idempotency-Key)
- `POST /api/v1/applications/:id/notify` (Idempotency-Key)

AI never makes the final decision; analysis outcomes route to human review.
