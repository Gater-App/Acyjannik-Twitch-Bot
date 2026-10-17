# Cross-platform Expansion 008 — Phase 6 status

## Implemented in this branch

- Added a responsive, administrator-only Discord management page for service status, current delivery backlog/errors, shared-account use, level notifications, live notices, Elio, Mystery Drops, available mini-games, VIP Chaos requests, and channel mapping.
- Channel choices are populated only from the Discord service's recent effective-permission catalog. The catalog records View Channel, Send Messages, Embed Links, and Read Message History separately; changed channel assignments must be present in a catalog checked within five minutes.
- Discord heartbeats can refresh the catalog without a schema change. All new feature flags default to false. No Twitch features, Discord settings, or production data are enabled or modified by this branch.
- Added authenticated, rate-limited Discord endpoints for linked Twitch profiles/leaderboard, guesses in an already-running Twitch number game, duels, and moderator-reviewed VIP Chaos requests. Game outcomes and XP use the existing Twitch services and ledger. Discord game replies are ephemeral.
- A stale cached Discord channel catalog is no longer refreshed on the server after a failed Discord permission read. Duels return truthful acceptance results and report their configured expiry. VIP Chaos requires a recently confirmed live stream and a currently verified Twitch VIP.

## Deliberately not implemented

- VIP Mystery Drop, Elio Party, Bless, and Royal actions: the existing Twitch project has no defined action/reward contract for them. This branch does not invent separate VIP rewards or bypass Twitch-side limits.
- Interactive Halloween, Christmas, and Easter Discord participation: no single existing cross-platform seasonal event/participant contract exists. The existing seasonal notification setting remains separate from interaction/reward features.
- Discord-managed XP, game rules, or role grants: Twitch remains the source of truth; Discord cannot start Twitch games or assign Twitch privileges.

## Verification

- No SQLite migration added; existing integration inbox/outbox and account-link schema are reused.
- Twitch build and all 204 unit/integration tests pass; all 5 browser tests pass on desktop/mobile-sized viewports.
- Discord-side command definitions and permission catalog need registration/runtime verification in the Discord Phase 6 branch. Production slash commands have not been changed.
- No Oracle writes, Discord messages, command registration, permission changes, migration, deployment, or restart were performed.

## Required integration order

Merge the existing Phase 1 account-link roots in both repositories first, then their Phase 2–4 descendants, then Phase 5, and only then these Phase 6 branches. The Phase 5 PRs are based on Phase 4; this Phase 6 branch is based on Phase 5. Review each Twitch/Discord pair together. No merge is authorized by this status report.
