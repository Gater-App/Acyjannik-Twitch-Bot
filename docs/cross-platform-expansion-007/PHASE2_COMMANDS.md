# Phase 2 — Discord profile commands

This package depends on the Twitch account-link API and migration from Phase 1.

New ephemeral commands:

- `/profil` — linked Twitch XP, level progress, rank, earned Community-World badges.
- `/level` — same personal progression view.
- `/rangliste` — paginated view of the existing Twitch XP leaderboard, ten rows per page.

The registration tool uses safe per-command upserts; it does not bulk-replace guild commands. No production command registration was performed. Discord XP accrual is intentionally not part of this phase slice.
