# ACY local-to-cloud handover 010

Stand: 15.10.2026. Inventory uses a fresh `git fetch origin`, worktree listing, Git status checks, and GitHub PR lookup. Production facts refer to the read-only preflight recorded the same day. No production service was changed in this handover.

## GitHub reference and PR state

- `origin/main`: `f075663790263e59256f49130f00274dd4067fea`.
- PR #12 Security 004: open, branch `codex/security-operations-hardening-004`, HEAD `d9de3b140d99713fe505d502b3a16ca2bd2257b6`.
- PR #13 Community 007: open, branch `codex/community-live-control-007`, HEAD `2d932530ea69d8f1a8812c86453bb8c9ee6fb641`.
- PR #14 Integration 008: open, branch `codex/acy-release-integration-008`, HEAD `3c97f3849ffc357efff1aa9dac4f658d5c8f7041`. It remains the existing candidate and is not changed, merged, or deployed by this handover.
- PR #15 Imposter 006: open draft, branch `codex/imposter-secret-word-006`, HEAD `fbd823e430a650d0536c3852bf70647e9e8ac291`.
- PR #16 Handover 010: open, branch `codex/safe-local-to-cloud-handover-010`, HEAD `c764f1158c20f28e770d6fb419a60ef932f2d52c`.

## Worktree inventory

| Local path | Branch / HEAD | Status and purpose | GitHub secured | Cloud recommended |
|---|---|---|---|---|
| `/Users/basti/Documents/Codex/2026-10-14/und-gleich-das-erste-problem-das/work/Acyjannik-Twitch-Bot` | `feature/halloween-haunted-house` / `886826ca` | 3 modified verification screenshots and untracked `artifacts/`; protected user checkout | Code on GitHub; local images/artifacts not uploaded | No; preserve locally |
| `/private/tmp/acy-bot-release-2270094` | detached / `22700942` | 3 modified screenshots and ignored/untracked `node_modules/`; historical release checkout | Base release on GitHub | No; local artifacts only |
| `/private/tmp/acy-health-proxy` | `fix/health-proxy-route` / `37d9fc4` | clean; merged PR #10 | Yes | No additional work |
| `/private/tmp/acy-release-report` | `docs/health-hotfix-production-report` / `743795e` | clean; merged PR #11 | Yes | No additional work |
| `.../work/acy-community-live-control-007` | `codex/community-live-control-007` / `2d932530` | clean; Community 007 | Yes, PR #13 | Yes, as a separate PR |
| `.../work/acy-imposter-secret-word-006` | `codex/imposter-secret-word-006` / `f075663` | WIP source, tests, status report and two synthetic screenshots; detailed below | Source was local-only at inventory; this handover pushes verified source/test/report files on its own WIP branch | Yes, separate WIP only |
| `.../work/acy-production-preflight-009` | `codex/acy-production-preflight-009` / `3c97f384` | clean; tracks PR #14 | Yes | Yes, PR #14 only |
| `.../work/acy-release-integration-008` | `codex/acy-release-integration-008` / `b311e21` | clean; old checkout is 10 commits behind pushed PR branch | Newer branch on GitHub | No; use current PR branch |
| `.../work/acy-security-operations-hardening-004` | `codex/security-operations-hardening-004` / `d9de3b1` | clean; Security 004 | Yes, PR #12 | Yes, as a separate PR |
| `/private/tmp/acy-handover-010` | `codex/safe-local-to-cloud-handover-010` | this handover's documentation and repository instructions | This PR/branch | Yes, documentation only |

`/Users/basti/Documents/ChatGPT/Twitch Bot 2` is a separate empty Git repository with no remote and no commits; it is not a second ACY project checkout. Local refs `ux/dashboard-5.0` and `fix/dashboard-elio-song-requests` contain no commits absent from `origin/main` (ancestry checked). The protected Halloween checkout and its artifacts were not staged, copied, or modified.

The remote HEADs for both newly published branches were independently confirmed with GitHub. PR #15 and #16 currently report no CI checks; their state is open, and #15 is draft.

## Imposter Secret Word 006 status

The isolated WIP branch is based on `origin/main` and adds migration v33, game logic, dashboard controls, portal OAuth/private-role views, tests, and a status report. It remains a separate WIP branch and is not part of PR #14. The two browser screenshots contain synthetic test labels and a deterministic sample word; they are left out of GitHub as generated debug artifacts. The report is updated to identify them as local-only.

Fresh isolated validation on a disposable worktree with Node 24.20.0 and npm 11.19.0: `npm ci` succeeded; `npm run check` passed (build and 204/204 unit/integration tests); `npm run test:browser` passed (6/6); `git diff --check` passed. No screenshot path was configured in the candidate run. Any browser-generated output stays in the disposable worktree.

The mode is default-off and not production-ready: v33 has not run in staging or Production; the word is stored in SQLite plaintext; Twitch OAuth/Caddy/OBS/Oracle behavior was not live-verified; retention is not defined; and no Whisper path exists. Portal login is required for private role delivery. Do not deploy or migrate as part of cloud onboarding.

## Secret and ignored-file handling

The tracked-path audit found only `.env.example` among secret-like names. It contains example placeholders and is not a live credential file. Ignore rules cover `.env` (except `.env.example`), token files, SQLite databases and sidecars, backups, and `node_modules`. Local ignored `dist/`, `node_modules/`, screenshots, and artifacts were not published. SSH keys and real `.env`/token/database contents were not opened or copied. Before any later commit, repeat path/index/ignore checks and review the exact staged diff; do not print matching secret values.

No local uncommitted work was discarded. Screenshot changes and `artifacts/` in the protected checkouts remain local and excluded because they are user-owned/generated artifacts, not source needed for cloud continuation. The old integration worktree is a stale duplicate; continue from the current pushed branch in PR #14.

## Cloud setup and operational boundary

See [Codex Cloud setup](operations/ACY_CODEX_CLOUD_HANDOVER.md) and [Oracle infrastructure](operations/ACY_ORACLE_INFRASTRUCTURE.md). The reproducible baseline is Node 24+, lockfile-backed `npm ci`, `npm run check`, and `npm run test:browser`, using synthetic credentials and local temporary databases. The Twitch bot repository may not modify, restart, or deploy the Discord bot. Cloud has no Oracle permission; no SSH key or production credential belongs in the Cloud environment.

## Tests and release state

- PR #12, #13, and #14 remain open; #15 is a separate open draft and #16 is the open documentation PR. None was merged in this work.
- Imposter WIP tests ran in a disposable isolated worktree to preserve its ignored local `dist/` output: build and 204/204 tests passed; browser tests 6/6 passed; `git diff --check` passed.
- New branch commits: WIP `fbd823e430a650d0536c3852bf70647e9e8ac291`; documentation `c764f1158c20f28e770d6fb419a60ef932f2d52c`. Both remote HEADs were independently verified.
- The separate documentation branch is built from current `origin/main`; it does not alter PR #14.
- Production runtime evidence remains the 15.10.2026 preflight: Twitch process reported Node 24.21.0 and release directory `2270094-20261015`, SQLite schema 32, PM2 process online; Discord remained a separate Node 22.23.2 PM2 process. Do not describe these as freshly rechecked by this handover.
- The known Caddy active file differs from repository config; backup age was about ten hours at preflight and restore was not tested. Production readiness is not established by local tests.

## PC shutdown answer

**JA.** Die relevanten Quelländerungen, Tests und Reports sind auf verifizierten GitHub-Branches. Imposter 006 ist separat im Draft-PR #15 gesichert; die Handover-Dokumentation steht in PR #16. Screenshot-Modifikationen und `artifacts/` bleiben bewusst lokal als nicht benötigte Benutzer-/Debug-Artefakte. Das bestätigt keine Production-Release-Freigabe.
