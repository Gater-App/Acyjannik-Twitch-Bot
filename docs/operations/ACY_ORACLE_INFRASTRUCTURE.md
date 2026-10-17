# ACY Oracle Infrastructure

Stand: 15.10.2026. This is an operational reference, not permission to change Production.

## Verified service ownership

The Oracle VM is named `acy-discord-bot` in the operations records. It hosts two separate PM2 applications:

| Service | PM2 process | Runtime evidence |
|---|---|---|
| Twitch community bot | `twitch-community-bot` | Node 24.21.0; release directory `2270094-20261015`; database schema 32 (read-only preflight, 15.10.2026) |
| Discord bot | `acy-discord-bot` | Node 22.23.2 (read-only preflight, 15.10.2026) |

The Discord application is outside this repository's deployment scope. A Twitch change must never alter, restart, or deploy the Discord process.

## Paths, routing, and ports

The Twitch service project root recorded in the preflight is `/home/ubuntu/twitch-community-bot`; versioned releases are kept below its `releases/` directory and the active PM2 entry resolves into release `2270094-20261015`. The Twitch app uses local backend port 3001 and OAuth port 3000. Caddy fronts `https://twitch.gater-app.de`; the repository configuration is `ops/Caddyfile.oracle`.

The active Caddy configuration was inspected read-only and differs from repository configuration. The known route families include `/health`, `/community*`, `/hilfe`, `/streamer*`, `/dashboard*`, `/widgets/*`, and `/games/*` to port 3001, with `/oauth/*` to port 3000. Some active matchers are broader than repository matchers. This was not demonstrated to be an authentication bypass, but should be reconciled during a separately approved infrastructure review. Do not publish the full active Caddy file or host addresses in this document.

The application database path is `/home/ubuntu/twitch-community-bot/data/halloween.sqlite`; backups are under the project `backups/` directory. This document records paths only and contains no database contents.

## Backup, release, and rollback

The recorded deployment uses versioned release directories and a switchable active runtime link. The 15.10.2026 preflight found an integrity-checked schema-32 backup and a prior release link. The newest backup at that check predated later WAL writes by about ten hours; it is evidence of a backup, not proof of a current recovery point. Restore was not exercised.

Before any future approved release, an operator must take a fresh SQLite-consistent backup, verify `quick_check` or `integrity_check`, record the exact code commit and dependency versions, and rehearse restore in a separate copy. Keep WAL handling consistent with SQLite's backup mechanism. A rollback should switch the Twitch runtime to the recorded previous release and verify health; database rollback is a separate operation and must not be assumed safe after a migration.

## Health and monitoring limits

`GET /health` is an HTTP liveness response only. It does not prove database, Twitch EventSub, OAuth, chat send, OBS, or backup health. PM2 online status is likewise not an end-to-end service check. Monitor process restarts, application logs, database integrity/backup age, OAuth callback reachability, Twitch EventSub reconnects, and Caddy routes separately.

## Change boundary

No Oracle, PM2, Caddy, SQLite, Twitch, or Discord action is authorized by this reference. Release execution requires a separate explicit approval and must target only `twitch-community-bot`. Never use a broad process restart that can affect both applications.
