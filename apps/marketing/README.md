# marketing

Public marketing site + blog for NicheHuntr. Static **Astro** app, part of the
Turborepo monorepo. Fully decoupled from the product app (no Convex/auth) — every
CTA links out to `app.nichehuntr.com`.

- **Landing** (`/`) — a static page whose only heavy region is an animated
  particle hero, isolated in a React island (`ParticleHero.tsx`, `client:visible`)
  so its JS loads only there. Everything else ships zero JS.
- **Blog** (`/blog`) — MDX/Markdown posts in `src/content/blog`, validated by the
  schema in `src/content.config.ts`. Rendered to static HTML.
- **SEO** — per-page canonical/OG/Twitter tags via `layouts/BaseLayout.astro`,
  plus `sitemap-index.xml`, `rss.xml`, and `robots.txt`.

## Design system

Brand tokens come from `@nichehuntr/ui` — `src/styles/global.css` imports
`@nichehuntr/ui/globals.css`, so the theme (lime primary, JetBrains Mono/Inter,
radii, light/dark) matches `apps/web` exactly. Marketing chrome is native `.astro`
(zero JS); React islands are reserved for genuinely interactive bits.

## Commands

Run from the repo root:

```sh
bun dev:web            # or: turbo -F marketing dev   → http://localhost:4321
turbo -F marketing build       # static output to apps/marketing/dist
turbo -F marketing check-types # astro check
```

## Deploy — Cloudflare Pages

Static output, no adapter needed. Connect this repo as a Pages project:

| Setting | Value |
| :-- | :-- |
| Root directory | *(repo root)* |
| Build command | `bunx turbo run build --filter=marketing` |
| Build output directory | `apps/marketing/dist` |

`public/_headers` sets immutable caching on fingerprinted `/_astro/*` assets.

### DNS (Namecheap → Cloudflare)

1. Add `nichehuntr.com` to Cloudflare and switch the Namecheap nameservers to the
   two Cloudflare assigns (domain stays registered at Namecheap).
2. Point the apex (`nichehuntr.com`) at this Pages project; add a `www` →️ apex
   redirect rule.
3. Point `app.nichehuntr.com` at the product app (`apps/web`, deployed to
   Cloudflare Workers — a separate task).

Update `site` in `astro.config.mjs` if the apex domain ever changes (it drives
canonical URLs, the sitemap, and RSS links).
