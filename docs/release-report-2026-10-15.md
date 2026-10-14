# ACY Twitch Bot – Production Release Report

Release date: 15.10.2026 (CEST)

Repository: `Gater-App/Acyjannik-Twitch-Bot`
Production host: `twitch.gater-app.de`

## Release identity

- GitHub `main` release commit: `e409596eddf0e579833c295e23f3dce259b541b4`.
- Merged pull requests: #2, #3, and #7. PR #7 corrected restart-message status so a Twitch/send-queue acceptance is not represented as confirmed delivery.
- Deployment artifact: `/home/ubuntu/twitch-community-bot/releases/e409596-20261015`.
- Uploaded runtime archive SHA-256: `d94ad43152016b7f4db45eb0de5a13ba851e1b5f8e3bb0952f899bcb63d5219a`.
- The production directory has no Git metadata, so an exact pre-release Git commit could not be read. Before release, 58 production TypeScript files were present: 13 matched the local source byte-for-byte, 45 differed, and 38 local source files were absent from the production source folder.

## Build and regression results

- TypeScript build: passed.
- Unit and integration tests: **194/194 passed**.
- Browser regression tests: **5/5 passed**, including real desktop/mobile portal and dashboard interactions, logout, Elio, Chaos Wheel OBS rendering, and VIP Lounge.
- `git diff --check`: passed.
- GitHub reported no configured PR check statuses; the release was verified with the local build and test runs above.

## Production deployment

- Active path now resolves to `/home/ubuntu/twitch-community-bot/releases/e409596-20261015/dist`.
- Previous runtime was retained at `/home/ubuntu/twitch-community-bot/dist.rollback-pre-e409596-20261015` for code rollback.
- A fresh SQLite backup was created and integrity-checked immediately before switching: `/home/ubuntu/twitch-community-bot/backups/community-bot-2026-10-14T23-13-10-894Z.sqlite` (mode `0600`). The database also passed `integrity_check` after startup.
- Schema advanced from version 26 to version 32. The migrations were exercised on isolated local fixtures before release; no production database file was replaced.
- The ACY Twitch PM2 process restarted from Node.js 24.21.0 and is online. Its restart count moved from 18 to 19. The separate `acy-discord-bot` process remained online with the same PID and restart count 0.
- PM2 logs showed the OAuth server and EventSub chat subscription starting after the release.

## Live checks

| Check | Result | Meaning |
|---|---:|---|
| `/dashboard` | 302 | Protected dashboard redirects as expected. |
| `/dashboard/login` | 302 | Login route redirects as expected. |
| `/dashboard/oauth/callback` without OAuth state/code | 400 | Invalid callback probe was rejected. |
| `/streamer` | 302 | Protected streamer page redirects as expected. |
| `/hilfe` | 200 | Public help page loads. |
| `/community` | 200 | Public community portal loads; browser accessibility inspection showed its current navigation and community cards. |
| `/` | 404 | No root landing route is configured. |
| `/health` | 404 | No dedicated health endpoint is configured; process state and public routes were checked instead. |

The authenticated production dashboard and OAuth login were not exercised in a user session. Local browser tests cover the authenticated dashboard flow.

## Planned restart message test

The existing marker had expired, so the configured 30-minute restart cooldown was allowed to finish. A fresh marker was then created through the release's `BotLifecycle.prepare()` logic, and PM2 received one orderly `SIGINT` for `twitch-community-bot`.

The lifecycle record ended with both farewell and return statuses `skipped`. Therefore **no Twitch chat message was sent during this release restart**. The application only attempts those messages when its shutdown-time stream check and EventSub connection are both valid; the recorded outcome does not identify which condition was false. The bot reconnected and returned online. No second restart was attempted.

The new status model distinguishes a queue/Twitch API acceptance from independently confirmed delivery. The dashboard now describes an accepted message as “von Twitch angenommen (Zustellung nicht unabhängig bestätigt)”.

## Remaining work

- [#4 Imposter clue-word round mode](https://github.com/Gater-App/Acyjannik-Twitch-Bot/issues/4) is not implemented.
- [#5 Browser E2E coverage](https://github.com/Gater-App/Acyjannik-Twitch-Bot/issues/5) remains open for broader Live Control, poll, and moderation flows.
- [#6 Staging verification](https://github.com/Gater-App/Acyjannik-Twitch-Bot/issues/6) remains open for official VIP, channel-points, Spotify, and OBS credentials.
- Root `/` and `/health` return 404; no route was added as part of this release.
- Local screenshot artifacts created or refreshed during browser verification remain in the working tree and were not included in the runtime release.

The detailed feature matrix and migration audit remain in [the integration stabilization audit](integration-stabilization-audit.md). Local test success does not substitute for the remaining external Twitch/Spotify/OBS staging checks.
