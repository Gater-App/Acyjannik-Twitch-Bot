# ACY Community – Integration Consolidation 009

Date: 2026-10-17. Scope: local integration of Cross-Platform Expansion phases 1–6. This report does not authorize or perform a production rollout.

## Consolidated branches

- Twitch: `codex/cross-platform-integration-009`, based on `main` `639f58ee740bbe082ce06fc5a445e391486e5d31`; source commits remain visible as merge parents.
- Discord: `codex/cross-platform-integration-009`, based on `main` `d5a1a4b1d321c6e5e022756b16f676ad2d826d67`; source commits remain visible as merge parents.
- Original feature branches were not rewritten. No original phase PR was merged or closed.
- The original Phase 6 Twitch checkout and its three local VIP screenshots were not used for edits or staging. Browser-generated screenshot changes in this disposable consolidation checkout were restored to its committed baseline and excluded.

## PR audit and dependency graph

GitHub PR state/checks/reviews were refreshed on 2026-10-17. All listed source PRs were open and mergeable, with green source-branch CI and no approving review decision/request. Thus they were consolidated locally, but not merged to `main`.

| Repository | Open PRs | Branch relationship |
|---|---|---|
| Twitch | #20, #21, #22, #23, #24, #25 | #20 root; #21/#22/#23 sibling branches from Phase 1; #24 based on #23; #25 based on #24 |
| Discord | #3, #4, #5, #6, #7, #8 | #3 root; #4/#5/#6 sibling branches from Phase 1; #7 based on #6; #8 based on #7 |

The consolidated branch per repo is the single review surface targeting `main`; original PRs remain as source history pending maintainer disposition. Discord PR #2 safe guild-command registration is already part of its `main` baseline.

## Feature compatibility

| Feature | State | Notes |
|---|---|---|
| Twitch as source of truth | Integrated | Discord reads Twitch-owned identity, game, XP, rewards and eligibility; no separate XP ledger. |
| Account linking | Integrated | One-time intents/OAuth states, unique Twitch and Discord IDs, unlink audit. Migration v34. |
| Outbox / inbox | Integrated | Stable IDs, leases, retry/ack, idempotency records. Migration v33. |
| Ideas and votes | Integrated | Shared idea IDs/status, safe mentions and duplicate-safe voting. |
| Profiles / XP | Integrated | Private Discord queries use linked accounts and existing Twitch XP. |
| Twitch live announcements | Integrated | One post per stream, update/end reconciliation and configuration flags. |
| Elio / Mystery Drops | Integrated | Discord delegates state/actions/claims to Twitch; stable drop message reconciliation. |
| 8-Ball / RPS | Integrated | Shared Twitch outcome/cooldown/XP path. |
| Guess / duel | Integrated | Existing Twitch round/duel records, expiry and idempotent resolution. |
| VIP Chaos | Partial | Discord can submit a private request; current VIP and live state validated by Twitch. It is not an automatic prank execution. |
| Admin dashboard | Integrated in development | Recent effective-permission channel catalog, admin authorization and save/read-back tested. |
| Slash command registration | Integrated | Guild-scoped update preserves unrelated commands. Registration was not invoked. |
| Interactive seasonal Discord participation | Not implemented | Only notifications exist; no shared participant/reward contract. |

## Conflicts and compatibility fixes

- Combined legacy and Phase 6 Discord profile setting keys; canonical UI input is accepted while legacy saved values remain readable. Live announcement update/completion settings remain available and are not required as absent form inputs.
- Updated the browser test fixture to include a live target channel and to select it before enabling live notifications.
- Restored lost Discord Mystery Drop lifecycle dispatch, Elio/drop message builders and `/elio`/`/drop` command handlers.
- Removed conflicting duplicate profile/leaderboard handlers; Discord now uses the current Phase 6 `/community/profile` API contract and handles unavailable/unlinked users privately. Earlier Twitch profile routes remain available for compatibility.
- Added the missing effective-channel-catalog test import and aligned delivery-state persistence assertions with `drops`/`live` fields.

## Migrations

Production was checked read-only on 2026-10-17: active DB schema v32 and `PRAGMA integrity_check = ok`. Consolidated Twitch startup migrations are sequential: v33 adds `discord_event_outbox` and `discord_event_inbox`; v34 adds unique Twitch↔Discord links, expiring link/OAuth intent state and audit records. Both are transactional and create a pre-migration backup for file DBs. Discord has no DB migration; delivery reconciliation uses an atomic private JSON state file with permissions `0600`.

The pre-cutover backup `/home/ubuntu/twitch-community-bot/backups/pre-discord-cutover-v33-20261017T124102Z.sqlite` is present; read-only integrity is `ok`, schema v32, SHA-256 `84892a490d3330d1538239110b64e817af4ed9b7e5b50bfdc7778cb613f1f8d8`. It does not evidence migration v33 or v34.

## Unfinished product contracts

VIP Mystery Drop, Elio Party, Bless and Royal have no defined Twitch-side behavior/reward contract. Before implementation, decide each action's effect, eligibility, cosmetic/reward status, limits/cooldown, moderator approval, failure behavior, and whether a public message is allowed.

Seasonal participation needs a single event ID source, time window/timezone, participant identity, eligibility across platforms, reward source/amount/limits, duplicate-claim rule, cancellation semantics, and outage reconciliation. Until agreed, only existing seasonal notifications should be used.

## Read-only Oracle and Discord check

- PM2 processes `twitch-community-bot` and `acy-discord-bot` were online. Runtime Node versions: 24.21.0 and 22.23.2. Deployed directories `/home/ubuntu/twitch-community-bot` and `/home/ubuntu/discord-bot` have no Git metadata; installed commit SHAs cannot be proven there.
- Production DB remains v32; v33 and v34 are unapplied.
- Discord API GET verification confirmed `AcyCommunityBot` in guild `1206225751544832040`, no Administrator/Manage Guild/Manage Roles/Manage Channels/Ban/Kick/timeout rights. Its `BOT` role still has Manage Messages and Mention Everyone; remove these for least privilege unless a reviewed feature needs them.
- Effective View Channel, Send Messages, Embed Links and Read Message History are all true in `✧₊⁺ideen-💡`, `✧₊⁺main-chat`, and `✧₊⁺updates-lives`. No permissions or channels were changed and no messages were sent.
- Production cutover remains separate and disabled; no config state was changed.

## Tests

- Twitch `npm run check`: build passed; 205/205 unit/integration tests passed.
- Twitch `npm run test:browser`: 5/5 passed, including dashboard settings save/read-back and desktop/mobile checks.
- Discord `npm run check`: passed; `npm test`: 34/34 passed.
- `git diff --check`: run on both repos before publication.

## Status

1. **Development integration:** complete on local consolidation branches after the above checks.
2. **Technically ready for staging:** conditional; stage with isolated credentials, rehearse v33/v34 against a disposable v32 copy, verify channel setup and native module compatibility first.
3. **Production:** not released. v33/v34, process replacement/restarts, slash registration, integration activation and real Discord messages remain out of scope.
