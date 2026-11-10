# Relay — Development Build v1 (Profiles + Badges + Chat)

Relay is a starting point for an original community-chat platform. This is **not a Discord client** and does not use Discord APIs.

## Requirements
- Node.js 22+ recommended
- npm

## Quick start
```bash
npm install
npm run dev
```
Then open **http://localhost:5173**. Create an account, then a server. Open another browser/incognito window to create a second account. Copy the invite code from the top-right button and join the server with the second account. Messages appear for both accounts in real time.

For local development, the API uses port 3001 and the web app uses 5173. Persistent data is stored in `server/relay.sqlite` (created automatically).

## Production build
```bash
npm run build
JWT_SECRET="a-long-random-secret-at-least-32-characters" CLIENT_ORIGIN="https://your-domain.example" NODE_ENV=production npm start
```
Put the API behind HTTPS and use a proper reverse proxy. This MVP isn't production-hardened: add email verification, account recovery, CSRF protections if switching to cookie sessions, request validation, tests, logging, abuse moderation, spam prevention, message pagination, database backups and migration management. Do not expose this publicly without a security review. SQLite is suitable for local development; move to PostgreSQL before scaling horizontally.

## New in this development build
- **Profiles**: click a user's name/avatar to see their profile; click your own account's settings gear to edit display name, bio, gradient colors and gradient angle.
- **Avatar and banner uploads**: PNG, JPEG, WebP and GIF, up to 2 MB. Assets are saved locally in `server/uploads/`.
- **Badge system**: permanent earned badges, plus a dynamically computed Premium badge and server Boost badge only when their respective entitlements are active.
- **Jumpstart**: automatically given to the first 100 registered user accounts in a fresh installation (including account #100).
- **Bot Developer**: admin issuance closes after January 18, 2027 (UTC); existing awards remain.
- **Premium tiers**: Matte (start), Jade (1 month), Silver (3), Sapphire (6), Quartz (12), Ruby (24), Pink Sapphire (36), Citrine (60), Diamond (72).
- **Boost tiers**: start, 1, 2, 3, 6, 9, 12, 15, 18 and 24 months.

Badge visuals in this code are **temporary icons**. The approved concept-sheet images are not yet extracted as individual transparent production badge assets. No payment processing, subscription checkout, or boost purchase UI is implemented yet.

## Admin testing (local development only)
Set `RELAY_ADMIN_TOKEN` to a secret of at least 24 characters in the API's environment to enable the two protected test endpoints. Never expose this token to the browser or end users. Example:

```bash
curl -X POST http://localhost:3001/api/admin/award \
  -H 'Content-Type: application/json' -H 'x-relay-admin-token: YOUR_SECRET' \
  -d '{"user_id":"USER_UUID","badge_key":"early_supporter_dingo"}'
```

To set Premium/boost entitlement for a test account:

```bash
curl -X POST http://localhost:3001/api/admin/entitlements \
  -H 'Content-Type: application/json' -H 'x-relay-admin-token: YOUR_SECRET' \
  -d '{"user_id":"USER_UUID","premium_active":true,"boost_active":true,"premium_since":"2026-01-01T00:00:00Z","boost_since":"2026-01-01T00:00:00Z"}'
```

These are administration/testing endpoints only. Before launching publicly, replace them with authenticated staff tools, verified entitlement webhooks, payment reconciliation and an auditable grant history. Local images are not scanned for malware or moderated; serve uploads from isolated asset storage in production. Paid account tier continuity must be settled with your billing policy before integrating subscriptions.

## Included
- Registration / login using bcrypt-hashed passwords and signed JWTs
- Persistent server, membership, channel and message records
- Invite-code server joining
- Server-owner channel creation
- Socket.IO message delivery with authentication and server membership checks
- Dark desktop-responsive interface

## Planned
- Friends, DMs, group DMs and presence
- Roles and granular permissions
- Editable/deletable messages, reactions, uploads, threads, search
- WebRTC audio/video with an SFU (e.g. LiveKit)
- Electron and mobile packaging
- Automated tests, accessibility pass, production infrastructure

## Notes
- There is no built-in demo account; create one in the app.
- The code intentionally doesn't expose server membership data publicly.
- JWTs are held in localStorage for MVP simplicity. For a public launch, consider short-lived tokens, secure refresh-token cookies, and appropriate CSRF protections.
- Don't commit secrets, `.env` files, or `relay.sqlite` to source control.
