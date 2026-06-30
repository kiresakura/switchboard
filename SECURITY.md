# Security Policy

## Reporting a Vulnerability

Please report security issues privately to **<security@example.com>** (replace
with your contact). Do not open public issues for undisclosed vulnerabilities.
We aim to acknowledge reports within 72 hours.

## Deploying safely

Switchboard handles customer message data and provider (Telegram) account
sessions. Before deploying:

- **Generate real secrets.** `SESSION_SECRET`, `TELEGRAM_SESSION_KEY`, and
  `INTERNAL_SECRET` must each be a unique 32-byte value
  (`openssl rand -hex 32`). The app **refuses to start in production** if any of
  them is unset or left at the build-time placeholder
  (see `src/lib/security/secret-guard.ts`).
- **Never commit a real `.env`.** Only `.env.example` /
  `.env.production.example` (placeholders) belong in version control. A
  `.gitleaks.toml` config is provided; wire it into a pre-commit hook / CI.
- **Set strong seed passwords.** Seeding a production database requires
  `SEED_ADMIN_PASSWORD` / `SEED_CS_PASSWORD`; the seed script throws otherwise.
  Change the admin password on first login.
- **Put the app behind a trusted proxy** and set `TRUSTED_PROXY_HOPS` to match
  your topology, so rate-limiting and audit logs use a trustworthy client IP.
- **Keep internal services private.** The bridge worker (3001) and the voice
  gateway/helper (3002/3003) are protected only by `INTERNAL_SECRET` and must
  sit on a private network — never expose them publicly.
- **Never commit database dumps, logs, screenshots, or media** — they can
  contain real personal data. They are excluded by `.gitignore`.

## Scope notes

- Client-side anti-copy / watermark overlays are deterrents, not access
  controls.
- Operating automated Telegram **user** accounts may be subject to Telegram's
  Terms of Service; review them for your use case before deploying.
