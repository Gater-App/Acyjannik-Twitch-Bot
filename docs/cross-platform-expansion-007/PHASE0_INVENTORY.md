# Cross-platform expansion 007 — Phase 0 inventory

Checked 2026-10-17 against the clean release worktrees based on Twitch `639f58ee740bbe082ce06fc5a445e391486e5d31` and Discord `d5a1a4b1d321c6e5e022756b16f676ad2d826d67`. The earlier integration worktrees remain untouched.

## Verified components

| Area | State | Evidence / reuse |
|---|---|---|
| Twitch viewer OAuth | Implemented | `ViewerCommunityPortal` uses one-time state, same-browser HttpOnly cookie, Twitch token validation, Twitch user ID, 12-hour session and CSRF checks. Existing viewer OAuth requests no extra scopes. |
| Discord identity | Implemented for gateway interactions | Discord.js guild allowlist and interaction user IDs; current commands `/status` and `/idee`; no Discord OAuth or account-link flow existed. |
| Twitch XP / levels | Implemented, central source | SQLite `xp_users` and idempotent `xp_ledger`; level calculation and rank query already exist in `FeatureStore`. |
| Ideas / votes | Implemented across both bots | Twitch persists shared ideas/votes and outbox/inbox; Discord modal submits with stable interaction ID; delivery has a persisted dedupe/reconciliation path. |
| Twitch → Discord notifications | Partial but live transitions wired | Twitch outbox has retry/dead-letter; `main.ts` records confirmed stream transitions. Other event producers are selective; configurable notification flags alone do not imply that each event is emitted. |
| Quests / events / drops / Elio / minigames / Chaos Wheel | Implemented in Twitch; absent on Discord | Reuse Twitch `CommunityFeatures`, `CommunityArcade`, quest, event, and XP services through authenticated API operations. Never mutate SQLite from Discord. |
| Twitch VIP | Partial/implemented on Twitch | Twitch-side VIP service uses broadcaster authorization and fails closed; no cross-platform privilege mapping exists. |
| Discord XP / profile / leaderboard | Not implemented | Would require link lookup plus authenticated read/write APIs and server-side limits; must not create a Discord balance. |
| EventSub | Implemented for Twitch runtime | Existing EventSub and live-state transition path can feed Discord outbox. Do not create another EventSub client. |
| Dashboard | Partial | Existing admin-only Discord page controls integration, three channel IDs, notification switches and outbox retries. Channel discovery is not implemented. |
| Migrations | v33 on code; production remains v32 | v33 adds outbox/inbox. Phase 1 adds only local migration v34 for identity links and short-lived challenges; no production migration was run. |

## Production read-only recheck

At the check time, both PM2 services were online: `twitch-community-bot` and `acy-discord-bot`. Twitch process uses Node 24 and release symlink `2270094-20261015`; the shell default Node 22 cannot load that service's native SQLite binding, so the database was inspected with the running process's Node 24 binary. SQLite integrity was `ok`, schema was v32, and public `/health` returned 200 (liveness only). The previously verified v32 restore-tested backup remains present. No process, database, secret, channel, permission, or live Discord state was changed.

The most recent read-only Discord permission review found excessive role-level privileges and channel overrides that deny the bot view/send in the intended ideas and announcement channels. These rights are a security blocker for a production cutover; this development work must not adjust them. Integration secrets are not configured in the currently running production services, and the integration remains disabled.

## Dependencies and risk controls

1. Account links must bind a Discord interaction ID to a Twitch identity verified by the existing OAuth callback.
2. Profile/rank features must resolve links server-side and query Twitch's existing XP store.
3. Discord XP, if ever enabled, must call an idempotent Twitch ledger operation; no second balance.
4. Elio, drops, games, VIP, and seasons must call existing Twitch services; each feature remains off by default.
5. Live announcements can reuse the existing transition producer; no second EventSub or unbounded polling.
6. Any future production rollout requires the minimal Discord role/channel permission review, configured integration authentication, verified backup, migration v33 then the additive migration, and one controlled process cutover. None of those production operations is authorized here.

## Phase status

Phase 0 inventory: **VERIFIED locally and read-only for the production facts above**. The current app's `/health` does not establish OAuth, database, Caddy, Discord-send, or end-to-end health. Phase 1 is the first implementation package. Later phases remain open until their own paired API/Discord behavior and tests are implemented.
