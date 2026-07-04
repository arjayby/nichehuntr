---
name: verify
description: Drive the nichehuntr web app (TanStack Start + Convex) headlessly to verify UI changes at runtime.
---

# Verifying apps/web changes

## Handle

- Dev server: `bun dev` in `apps/web` serves **http://localhost:3001** (vite, HMR — code edits are live immediately). Check `lsof -iTCP -sTCP:LISTEN | grep 3001` first; it's usually already running. Port 4321 is the Astro marketing site, not this app.
- Backend is the Convex **cloud dev deployment** (`cool-dragon-124`) — no local backend process needed; if signup works, Convex is reachable.
- Playwright is not a repo dep. Install `playwright@latest` in the scratchpad (`bun add playwright`); chromium revisions 1217/1228 are already cached in `~/Library/Caches/ms-playwright`.

## Getting a logged-in user

No seeded test creds. Sign up a throwaway user through the real UI:

1. `goto /signup`, then **wait for hydration** — `waitForLoadState("networkidle")` + ~1s. Filling/clicking before React hydrates submits the form natively and dumps the values into the query string.
2. Fill labels `Name`, `Email` (unique, e.g. timestamped), `Password`; click button **"Create account"** (not "Sign up").
3. New users have no subscription → route guards land them on `/subscribe`. The header (wordmark + user menu) renders there, so most header/menu flows are verifiable without a subscription.

## Gotchas

- The subscribed states (e.g. "Manage Subscription" in the user menu) needs a Polar sandbox subscription; as of 2026-07 `generateCheckoutLink` fails in dev ("Could not start checkout"), so that branch may not be drivable.
- `/login` and `/signup` render without the app header.
- Toasts: read `[data-sonner-toast]` inner texts to catch server-side action failures.
- Throwaway users accumulate in the dev deployment; use recognizable emails (`verify-*@example.com`).
