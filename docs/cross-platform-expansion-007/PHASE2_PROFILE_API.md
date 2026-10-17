# Phase 2 — Shared profiles and leaderboard (read-only slice)

## Implemented

- Authenticated Twitch integration endpoints provide a linked member's own XP profile and a paginated community leaderboard.
- The source of truth is the existing Twitch `xp_users`, `community_world_badges`, and account-link tables. Existing level helpers are reused.
- Discord receives display name, XP, level, progress, rank, and earned Community-World badges for the linked member. Twitch/Discord IDs are never returned in profile or leaderboard responses.
- `/profil` and `/level` are ephemeral. `/rangliste` is ephemeral, bounded to pages 1–1000, ten entries per page, and omits identifiers.
- Twitch dashboard has a new `profilesEnabled` switch, default off. Disabled integration or profiles fail closed. Personal-profile requests are rate-limited per Discord ID.
- Discord replies disable mentions so imported Twitch display names cannot ping roles or users.

## Not implemented in this slice

Discord XP accrual, Discord event reward payouts, privacy preferences beyond private interaction replies, VIP status display, and a public profile UI are not included. No second XP ledger or Discord-side level calculation exists. Discord XP remains off until activity eligibility, cooldowns, daily limits, and audit semantics are defined and tested.

## Tests

- Twitch: profile API auth, account-link requirement, level/progress/rank calculation, badge metadata, ID omission, leaderboard pagination, and disabled-feature rejection.
- Discord: command definitions and bounds, private responses, authenticated API calls, mention suppression, profile error feedback, and page selection.
- Dashboard browser coverage verifies default-off state and saving the profile toggle on desktop/mobile.
