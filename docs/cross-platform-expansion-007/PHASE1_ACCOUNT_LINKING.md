# Phase 1 — Twitch / Discord account linking

## Flow

Discord `/verknüpfen` (canonical command `verknuepfen`) asks the Twitch integration API for a one-use, ten-minute link intent. The intent stores only a SHA-256 token hash and the Discord user ID. The ephemeral Discord reply contains the bearer token in the URL fragment; fragments are not sent in the initial HTTP request, keeping the token out of access logs. The consent page removes the fragment before the user continues. Twitch binds a random OAuth state to the same browser's HttpOnly state cookie and the pending intent. The existing callback validates the Twitch access token and resolves the Twitch user ID before a transaction inserts the unique account pair. The raw short-lived token is never stored or logged.

`/konto` reports whether the invoking Discord identity has a link. `/trennen` unlinks only the invoking Discord identity; an audit row records the IDs and action for 180 days, while XP, Twitch profiles, and game records remain untouched. Duplicate links are rejected rather than merged. Tokens, OAuth states, and audit rows are handled separately from viewer sessions.

The integration and account-link switches both default off. No extra Twitch scopes are requested. The existing confidential Twitch authorization-code flow is used with cryptographic state and same-browser cookie binding; Twitch's documented authorization-code parameters do not define a PKCE exchange for this flow. See [Twitch OAuth documentation](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/).

## Data change

Additive local SQLite migration v34 creates active unique account links, short-lived link intents, OAuth-state bindings, and an append-only link/unlink audit. Existing XP/user tables are not updated or merged. Production remains at v32; v33 and v34 are not applied there.

## Safety and limits

- Discord endpoints require the existing constant-time checked integration bearer key.
- Creation additionally requires both the global integration and account-link flags.
- Intent creation is limited per Discord identity and the portal link start is limited per IP.
- A repeated/replayed OAuth state cannot create another link.
- An account already paired to another identity fails without overwriting either account.
- Unlink is private, identity-scoped, idempotent, and does not delete community progress.
- OAuth failure leaves only an expiring intent/state; the cleanup job removes them.

## Test status

Paired backend tests cover API authentication, one-time link completion, session-bound OAuth, replay rejection, unlink, migration, and both bots' private Discord replies. Final full-suite results are recorded in the pull requests.
