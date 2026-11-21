# Status and validation

Legend: **Verified** = exercised for real (how is stated) · **Built, unverified** = implemented against the documented interface but never run against the real dependency · **Not built**.

## How it is tested

| Suite | Command | What it uses |
| --- | --- | --- |
| Type checking (strict, 4 packages) | `pnpm typecheck` | — |
| Unit + integration | `pnpm test` | real Postgres, a real in-process worker, real Chromium, real git, and real Docker for the deployment suite |
| UI end-to-end | `pnpm test:e2e` | throwaway database, production build of the dashboard, a real worker enrolled with the token shown in the UI |
| Deployment path | CI job `deploy-assets` | builds the Docker images, starts the Compose stack behind Caddy with TLS, runs `deploy/install-worker.sh` on an Ubuntu runner with systemd |
| Live Claude agent | `VISCOSITY_LIVE_CLAUDE=1 pnpm exec vitest run apps/api/test/live-claude.test.ts` | a real Claude Agent SDK run (spends tokens; opt-in) |

Current results are on the repository's Actions tab. Linting: ESLint is not configured — `typescript-eslint` does not yet support the TypeScript 7 compiler this repo uses, so strict `tsc` is the gate.

## Feature status

| Area | Status | Notes |
| --- | --- | --- |
| Authentication, sessions, TOTP MFA | Verified | setup-once, login, CSRF/Origin, MFA cycle |
| Roles and user management | Verified | viewer/operator/admin enforced server-side; add/edit/delete users, last admin protected |
| Server enrollment, live metrics, reconnect | Verified | single-use token, `/proc` metrics, offline detection, event replay, lost-session detection, queued start |
| Long-range metrics | Verified | one sample per minute kept 14 days; Live / 1h / 24h / 7d charts |
| Terminals | Verified | PTY on the worker, scrollback replay, exit codes, foreign Origin refused |
| File manager | Verified | browse, Monaco edit, upload/download, rename, delete, search; traversal blocked on the worker |
| Processes, journald logs, reboot | Verified / unverified | process list + signals verified; journald and reboot need systemd (reboot is never exercised automatically) |
| Managed systemd services | Verified in CI | units allow-listed in the worker's config; narrowly scoped polkit rule |
| Docker containers | Verified | list, health, stats, logs, start/stop/restart against a real daemon |
| Claude agents | Verified | real run: approval → edit → follow-up resume, from the API and from the dashboard |
| Codex agents | **Built, unverified** | needs an OpenAI API key |
| Custom-process agents, command runs | Verified | streaming, stop, restart, history |
| Approvals, worktrees, git changes view | Verified | |
| Browser sessions (scripted) | Verified | per-action verification, screenshots, approvals, uploads, stored secrets, SSRF guard |
| Browser sessions (autonomous, LLM-driven) | **Built, unverified** | needs an Anthropic API key |
| Projects and git | Verified | clone, branches, commits, diff, commit, worktrees, build/test runs |
| GitHub integration | **Partly verified** | repository listing, push and pull-request creation are tested against a fake GitHub API and a local remote — not against github.com |
| Deployments (Docker Compose) | Verified | deploy, env secrets, health checks, redeploy, rollback, production approval, teardown — against real Docker |
| Workflows | Verified | cron schedules, multi-step runs with dependencies, parallel steps, retries, timeouts, approval gates, cancel, resume after restart, exactly-once step starts |
| Control-plane deployment (Compose + Caddy) | Verified in CI | images build, stack starts, TLS endpoint answers |
| Worker installer (systemd) | Verified in CI | on Ubuntu 24.04; Debian and the `--with-browser`, `--with-docker`, `--allow-reboot` options are not exercised |

## Known limits (not hidden)

- **Agents are not container-sandboxed.** They are confined by an unprivileged account and the allowed directories. See `THREAT-MODEL.md`.
- **No pause for agents.** Neither provider SDK supports it; the control is not shown.
- **Deploys are not resumable.** A deploy in flight when the API restarts is marked failed, not continued.
- **GitHub repository listing** returns the first 100 repositories by last push.
- **Commits from the dashboard stage everything** (`git add -A`); there is no per-file staging.
- **No Redis/BullMQ.** Queuing, scheduling and the workflow engine run on Postgres; this is deliberate, not missing.
- **Single region, single API process assumed for live sockets.** The scheduler and workflow engine are replica-safe, but the worker hub keeps connections in one process's memory.

## To finish verification on your infrastructure

1. Deploy with `deploy/docker-compose.yml` on a real host and domain (public certificate issuance is the one step CI cannot cover).
2. Enroll a real VPS; try the optional installer flags you need.
3. Add a real GitHub token and clone/push/open a pull request.
4. Add an OpenAI key and run a Codex agent; add an Anthropic key and run an autonomous browser session.
