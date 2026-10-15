# Repository instructions for Codex

- This repository controls the ACY Twitch bot only. Do not modify, restart, or deploy the Discord bot or its process.
- Treat `main` and open pull requests as review inputs. Do not merge or deploy without an explicit release request.
- Do not read or print real `.env` files, OAuth tokens, private keys, passwords, session cookies, or production database contents. Check only path, ignore, and Git-index metadata where possible.
- Do not connect to Production, run migrations against Production, restart PM2, reload Caddy, or trigger Twitch chat/OBS actions unless the user explicitly authorizes that exact operation.
- Use isolated worktrees for changes. Preserve existing uncommitted files and artifacts; never reset, clean, stash, force-push, or overwrite them.
- Use Node.js 24 or newer and `npm ci` from the lockfile. Local tests must use synthetic credentials and stubs, and must not default to Production endpoints.
- Keep unfinished features in separate branches and pull requests. In particular, keep Imposter Secret Word 006 separate from PR #14 until it is independently reviewed and approved.
