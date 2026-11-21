# Threat model

VISCOSITY CONTROL is remote code execution as a product: whoever controls the dashboard can run commands on every enrolled server. The design goal is that **only an authenticated, authorised operator can cause execution, each component can do only what it must, and every consequential action leaves a trace.**

## Assets

1. Shell/file/Docker access to enrolled servers.
2. Provider API keys and GitHub tokens.
3. Source code and data in agent workspaces.
4. The audit trail.

## Trust boundaries

```
[operator browser] ──①── [web UI] ──②── [API + Postgres] ──③── [worker] ──④── [agent / browser / shell]
```

| # | Boundary | What crosses it | Enforced by |
| --- | --- | --- | --- |
| ① | Internet → dashboard | credentials, session cookie | TLS (Caddy), CSP/frame headers, rate limits |
| ② | Browser → API | every operation | session cookie (httpOnly, SameSite=Lax, Secure), **Origin check on every mutation and WebSocket upgrade**, server-side role check on every route (deny by default), zod validation, audit log |
| ③ | API → worker | RPC requests, provider keys at run start | worker-initiated TLS socket, per-server random credential (only its SHA-256 is stored), protocol version check, schema validation in both directions, ownership checks on worker events |
| ④ | Worker → workloads | prompts, tool calls, page content | unprivileged service account, allowed-roots path guard, permission modes + approval gates, browser network guard, timeouts |

## Actors and what stops them

**Unauthenticated internet attacker.** Sees a login page. Passwords are scrypt-hashed; login, setup, MFA and enrollment endpoints are rate limited; failures are audited; the error does not reveal whether the account exists. TOTP MFA is available. First-run setup is serialised and works exactly once.

**Malicious web page in the operator's browser (CSRF / cross-site WebSocket hijacking).** Mutations and WebSocket upgrades require an allow-listed `Origin`; the cookie is SameSite=Lax and httpOnly. The UI is not framable.

**Lower-privileged dashboard user.** Roles are `viewer < operator < admin`, enforced in one server-side hook; a route without explicit configuration requires a session and, for non-GET, the operator role. Enrolling/removing servers, credentials, reboot and the audit log are admin-only. A terminal can be attached only by its creator or an admin. Admins manage users in Settings; changing a role or password signs that user out everywhere, and the last administrator cannot be removed or demoted. Production deployments requested by an operator wait for an admin's approval.

**Stolen enrollment token.** Tokens are 256-bit, single-use (atomic `UPDATE … WHERE used_at IS NULL`), expire after 15 minutes, are stored hashed and shown once. Using one rotates the server's credential and disconnects whatever was connected, so theft is noisy.

**Compromised worker / server.** A worker authenticates only as its own server. Events it sends are schema-validated and dropped unless the session belongs to that server; terminal output is routed by `(serverId, ptyId)`. It receives a provider key only when the operator starts a run on it — **a compromised server therefore exposes the keys used on that server**; use per-server or scoped keys where that matters. Revoking a server's credential disconnects it immediately.

**Compromised control plane.** This is the root of trust: it can instruct every worker. Mitigations are limited to what the worker enforces locally and cannot be overridden remotely: the allowed roots, the non-root service account, `allowReboot`, `allowRootShell`, Docker group membership and the browser allow-list all live in the worker's own config file.

**Prompt injection / a misbehaving agent.** An agent can do whatever its permission mode allows inside the worker account. `ask` and `acceptEdits` route tool calls to the operator for approval (Claude). Repository-provided Claude settings are **not** loaded, so a repo cannot pre-approve its own commands. Git worktrees keep concurrent agents out of each other's working trees. `auto` mode is exactly as dangerous as giving the model a shell in that account — use it only in disposable workspaces.

**Hostile web content in a browser session.** Each session gets its own browser process and context with a private download directory. Every request (including WebSockets) passes a guard that blocks loopback, RFC 1918, link-local/metadata (169.254.169.254, fd00::/8), CGNAT and non-http(s) schemes unless the host is allow-listed in the worker's config. The autonomous agent is instructed to pause for approval before purchases, payments, publishing and account changes, and scripted sessions support explicit approval steps.

**Path traversal / command injection.** Every path is resolved with `realpath` and must stay under an allowed root (symlink escapes included). Processes are always spawned with argument arrays, never through a shell; identifiers passed to `docker`, `journalctl` and `git` are pattern-validated in the protocol schema.

**Managed services and reboot.** The dashboard can only touch systemd units listed in the worker's own config, backed by a polkit rule scoped to exactly those units and the start/stop/restart verbs. Reboot is off unless enabled at install time.

**Deployments.** Compose files must sit inside the worker's allowed roots; environment secrets are encrypted at rest, write-only over the API, kept out of the audit log, and handed to the worker only for the run. Anyone who can deploy can run arbitrary containers on that server — treat the operator role accordingly.

## Secrets

* Provider keys, GitHub tokens, deployment variables and generic secrets: AES-256-GCM with a key derived (HKDF) from `VISCOSITY_SECRET_KEY`; write-only over the API (only the last four characters are ever returned); sent to a worker over the authenticated socket at run start and placed only in the child process environment; never written to the event log.
* The browser never holds a secret: the session token is httpOnly, and nothing sensitive is put in `localStorage` (only layout and font preferences).
* Git tokens are passed to `git` per invocation through the environment (not argv), never written to `.git/config` or the remote URL. Browser steps reference stored secrets as `{{secret:label}}`; the value is resolved at launch and never stored in the session or echoed in events.
* Rotation: provider keys via *Settings → rotate*; worker credentials via *re-enroll*; `VISCOSITY_SECRET_KEY` rotation requires re-entering stored keys (no re-encryption tool yet).

## Known gaps (not disguised as done)

| Gap | Impact | Planned fix |
| --- | --- | --- |
| Agents are isolated by Unix account + allowed roots, **not** by container/VM | An agent in `auto` mode can read anything the worker account can | Per-agent container/namespace sandbox |
| Browser guard resolves DNS separately from Chromium | A sub-second DNS-rebinding attacker could race the check | Egress proxy / network namespace pinning the checked address |
| Path guard is check-then-use | A local process could race a symlink swap | `openat2`-style resolution or per-agent mount namespaces |
| Membership of the `docker` group is root-equivalent | Opt-in (`--with-docker`); treat such servers as fully operator-controlled | Rootless Docker or a filtering socket proxy |
| TOTP codes are not single-use within their 90 s window | Replay by someone who observed a code and knows the password | Store last-used step |
| No per-user server scoping | Every operator can act on every server | Server ACLs |
| Audit log is in the same database | A database-level attacker can alter it | Ship to an append-only sink |
