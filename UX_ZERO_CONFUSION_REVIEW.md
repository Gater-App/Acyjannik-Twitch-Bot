# ACY Dashboard – Zero Confusion UX review

## Changes made

- Replaced Conversation Spark's raw JSON topic editor with fields for topic name, matching terms, and suggested action. Existing topic IDs and values are retained; polling no longer overwrites unsaved edits.
- Removed the empty “Allgemein” tab. Its legacy route still opens technical diagnostics; raw settings JSON remains available only inside its collapsed maintenance details.
- Replaced millisecond inputs for events, custom chat commands, and the community boss with seconds or minutes. Values are converted back to the same stored millisecond values.
- Simplified XP corrections: search by Twitch name, select the account, and see its current XP. The internal account ID is not shown in the normal form.
- Clarified Channel Points setup/status, removed internal redemption and reward IDs from visible text, and translated common redemption statuses. When the integration is not provided by the runtime, the dashboard continues to show its existing clear unavailable state rather than a non-working setup form.
- In Streamer Mode, phase names and the Twitch chat connection are explicit. Running-game status no longer repeats destructive controls; the next action stays in the games list. The compact control reports its current mode.

## Verification

- `npm run check`: build succeeds; 128 tests pass.
- `npm run test:browser`: passes. Covers admin navigation and views, saved Spark topic form, XP account selection, logout, Streamer Mode active-game controls, and guest Community Portal.
- Browser viewport checks: dashboard and Streamer Mode at desktop, tablet, and iPhone widths; guest Portal at desktop and iPhone widths. No horizontal overflow or page JavaScript errors.
- Guest Portal check confirms it offers Twitch sign-in and does not expose an Admin Dashboard link.
- No Oracle access, deployment, or server restart was used.

## Remaining scope

This was a targeted repair of verified confusing flows, not a manual review of every control in every live production state. Spotify, channel-points OAuth, real OBS sources, and authenticated viewer journeys still require production credentials and a live browser session to verify their real external integrations. No data migration or feature removal was made.

## Screenshot evidence

Local browser captures are stored beside the repository in `zero-confusion-ux-evidence/` (`before/` and `after/`). They show the dashboard overview, settings, and Streamer Mode before and after; the after set also includes Spark, XP correction, and the guest Portal on desktop/mobile.
