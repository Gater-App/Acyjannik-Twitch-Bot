# Twitch × Discord integration v1

## Ownership and safety

- Twitch SQLite remains the source of truth for ideas, idea votes, XP, quests, seasonal events, and live state.
- Discord has no XP ledger. Its small private JSON file stores only idea message IDs and recently delivered outbox IDs for retry reconciliation.
- `DISCORD_INTEGRATION_SECRET` must be a separately generated random value of at least 32 characters, supplied to both services outside Git. Do not reuse `ACY_GAME_DISCOVERY_SECRET`.
- The feature is disabled until an administrator enables it in `/dashboard/discord`, sets an ideas channel, and both processes receive the secret.
- Discord sends and interactions are restricted to the configured guild. The backend accepts integration traffic only with the secret and applies a per-route request limit.

## Event flow

1. A Twitch portal/chat idea or `/idee` submission is committed to `community_ideas`; when the integration and idea notifications are enabled, the same database transaction adds a stable UUID to `discord_event_outbox`.
2. The Discord service polls the authenticated internal endpoint and publishes the idea with a disabled vote button until Twitch moderation approves it.
3. Discord votes use a namespaced identity (`discord:<Discord user ID>`) in the existing `community_idea_votes` table. A unique key and the integration inbox prevent duplicate votes and replayed submissions.
4. Twitch moderation, Twitch portal votes, Discord votes, selected XP level-ups, Mystery Drop completions, completed quests, seasonal transitions, and confirmed live/offline transitions create outbox events when their corresponding notification is enabled.
5. Discord acknowledges after the Discord API succeeds. Twitch retries failures with bounded exponential backoff and marks the event dead after eight failed attempts. The dashboard lists and can retry dead deliveries.

Delivery is at-least-once across process crashes. Stable Discord message nonces, recent-message reconciliation, and the local delivery journal suppress common duplicate windows; no remote API can provide an atomic transaction across SQLite and Discord.

## Current limitations

- Twitch and Discord identities are not linked. A person using both services can have one vote per platform, because the existing schema stores distinct Twitch and Discord identity namespaces. Do not describe cross-platform votes as one-person-one-vote until account linking is implemented.
- Discord channel IDs are currently entered manually in the admin page; channel discovery and a live send-test are not implemented.
- Discord-native moderation buttons are not enabled. Moderation remains in the existing Twitch dashboard; status changes synchronize to the Discord idea card.
- Live notifications are driven by the Twitch bot's existing confirmed status polling, not a second EventSub subscription.
- Existing ideas are not backfilled or automatically re-posted. New ideas are published only after the integration is enabled.

## Deploy preparation (not performed here)

Provision the same integration secret in both processes, keep the existing Discord application/guild, set `TWITCH_INTEGRATION_ENABLED=true` only after both commits are deployed, then enable the feature in the Twitch admin page. The Twitch v33 migration runs on bot startup; back up the production SQLite database first. Never run two Discord Gateway processes with the same application token. Register `/idee` using the existing guild-scoped command registration after reviewing the new command definition.
