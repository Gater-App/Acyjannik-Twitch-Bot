# Codex Cloud handover: ACY Twitch Bot

## Repository and starting point

Open `Gater-App/Acyjannik-Twitch-Bot`. Current GitHub `main` verified 15.10.2026: `f075663790263e59256f49130f00274dd4067fea`.

Open review candidates:

| PR | Branch | State | Scope |
|---|---|---|---|
| [#12](https://github.com/Gater-App/Acyjannik-Twitch-Bot/pull/12) | `codex/security-operations-hardening-004` | Open | Security and operations hardening |
| [#13](https://github.com/Gater-App/Acyjannik-Twitch-Bot/pull/13) | `codex/community-live-control-007` | Open | Community and live-control polish |
| [#14](https://github.com/Gater-App/Acyjannik-Twitch-Bot/pull/14) | `codex/acy-release-integration-008` | Open | Existing integration candidate; do not merge or deploy from Cloud |
| [#15](https://github.com/Gater-App/Acyjannik-Twitch-Bot/pull/15) | `codex/imposter-secret-word-006` | Open, draft | Separate WIP; not release-ready |
| [#16](https://github.com/Gater-App/Acyjannik-Twitch-Bot/pull/16) | `codex/safe-local-to-cloud-handover-010` | Open | Handover documentation |

Imposter Secret Word 006 is a distinct, unfinished work stream and must not be added to PR #14. Consult this handover's status report for its branch and current verification status.

## Local setup

- Node.js 24 or newer (`package.json` declares `>=24`; CI candidate uses Node 24).
- npm with lockfile v3; use `npm ci`, not an unconstrained install.
- Build/type check: `npm run build`.
- Unit/integration suite: `npm test`.
- Combined check: `npm run check`.
- Browser suite: `npm run test:browser` (Playwright; browser binaries may need to be provisioned by the runner).
- `better-sqlite3` is a native dependency. A compatible build toolchain may be needed if npm cannot use a prebuilt binary. Do not install or upgrade packages to work around this without reviewing the lockfile change.

No production credentials are required for ordinary checks. Tests should use temporary SQLite databases, local loopback ports, synthetic OAuth responses, and stubbed Twitch/OBS interfaces. Do not populate real tokens. Do not point test configuration at `twitch.gater-app.de` or Oracle. On current `main`, there is no `.github/workflows/ci.yml`; PR #14 carries the proposed CI workflow. Its run on `3c97f3849ffc357efff1aa9dac4f658d5c8f7041` completed successfully, including dependency setup, Chromium install, check, build, unit/integration tests, browser tests, and whitespace check. The workflow's pull-request filter only targets `main`, so stacked PRs targeting PR #14's branch do not trigger it automatically.

## Credentials and access

Routine implementation, unit tests, browser tests, documentation, and static analysis require no Oracle, Twitch, or Discord credentials. Twitch client metadata and synthetic values may be used in tests. Real OAuth credentials are only relevant to a separately approved live OAuth verification. Oracle SSH and production secrets must never be copied into Cloud. Do not connect to Oracle, read secret files, run migrations, restart PM2, reload Caddy, send chat messages, or operate OBS from Cloud.

The Twitch bot may not modify, restart, or deploy the Discord bot. These applications share a VM but have separate PM2 process names and runtime versions.

## Release process

Keep each feature on a separate branch and PR. Review the diff and staged file list, run checks, inspect CI, and obtain explicit approval before merge. Production deployment, database migration, PM2 restart, and Caddy reload each require separate release authorization. Use the Twitch-only release procedure, a fresh verified backup, an exact commit/release record, health and reconnect verification, and a rehearsed rollback. A green build or `/health` response does not establish production readiness.
