# design-sync notes — @nichehuntr/ui

Repo-specific gotchas for future syncs. Read before re-running.

## Build shape
- **Package shape, synth-entry (no dist).** `@nichehuntr/ui` ships Tailwind v4 *source* + `.tsx` directly (its `exports` map points at `src/*`); there is no build and no `dist/`. The converter synthesizes an entry from `src/` and derives 28 PascalCase exports from 8 files.
- **Workspace self-symlink required.** The converter resolves `PKG_DIR = join(--node-modules, "@nichehuntr/ui")`. bun doesn't self-link a workspace package into its own `node_modules`, so `gen-css.mjs` creates `packages/ui/node_modules/@nichehuntr/ui -> ../../../ui` (mirrors the existing `@nichehuntr/config` link). It's idempotent; on a fresh clone `bun install` won't create it but the first `buildCmd` run (gen-css.mjs) will. Build command: `--node-modules packages/ui/node_modules` (no `--entry`, so it synths).

## CSS / Tailwind (the important part)
- **`cfg.buildCmd` = `node .design-sync/gen-css.mjs`.** The claude.ai/design runtime loads only the static `styles.css` closure and does **not** run Tailwind, so we must compile Tailwind to real CSS AND ship a broad utility palette (the agent writes classes beyond what component source uses).
- `gen-css.mjs`: (a) ensures the self-symlink, (b) generates `.design-sync/tw-safelist.tsx` (~5.8k utilities: layout/spacing/sizing/typography/theme-colors/borders/effects + hover/focus/dark + responsive on layout essentials), (c) compiles `packages/ui/.ds-css/compiled.css` (~586 KB minified) from `.design-sync/tw-entry.css` via `bunx @tailwindcss/cli@4.3.1`.
- `tw-entry.css` (committed) `@import`s the real `globals.css` (so theme tokens + `@source` for components/apps stay in sync) and adds `@source` for `previews/` + `tw-safelist.tsx`.
- `cfg.cssEntry = .ds-css/compiled.css` (must stay inside the package dir). `.ds-css/` is gitignored (regenerated).
- **Requires network the first time** for `bunx @tailwindcss/cli@4.3.1` (then cached). Pinned to tailwindcss 4.3.1 (the installed version).
- If you broaden/trim the palette, edit the family lists in `gen-css.mjs` and re-run the driver.

## Fonts
- **JetBrains Mono Variable** is the brand font (html + `--font-heading`), shipped via `cfg.extraFonts` → fontsource `index.css` (6 latin/greek/cyrillic/vietnamese woff2 in `fonts/`).
- **Inter Variable** (`--font-sans`, body text) is referenced by the theme but **never installed anywhere in the repo** — the app itself falls back to system sans today. User chose (2026-07-01) to **match the repo: system-sans fallback for body**, not ship Inter. Suppressed via `cfg.runtimeFontPrefixes: ["Inter Variable", ...]`.
- **Cambria** is only in Tailwind's default `--font-serif` fallback stack (system font, unused by components) — accepted, suppressed via the same key.
- These two are the only `[FONT_MISSING]` families and are intentionally unshipped. If a future validate flags a NEW family, investigate it.

## Previews
- Authored (7, all graded good): Button, Card, Checkbox, DropdownMenu, Input, Label, Skeleton. Layout glue uses inline styles (robust vs. the utility compile); the components render with their own compiled classes.
- **Toaster (sonner) → floor card by design.** It's an imperative/async toast container (`toast()` renders later) + reads `next-themes` — nothing renders statically. Not a failure. To preview it later would need a mounted-toast + capture delay, not worth it.
- All Card* / DropdownMenu* sub-parts are floor cards (composed inside their parent's authored preview) but remain fully importable with `.d.ts`. 21 floor cards total; that's the deliberate baseline.

## Base UI gotchas (@base-ui/react)
- **`DropdownMenuLabel` (Menu.GroupLabel) MUST be inside `DropdownMenuGroup` (Menu.Group)** — otherwise it throws `MenuGroupContext is missing` and blanks the whole render. (Cost one debug cycle.)
- DropdownMenu preview renders open via `defaultOpen` + `cfg.overrides.DropdownMenu {cardMode:"single", viewport:"380x400"}` so the portalled popup is captured inside the card.
- `DropdownMenuTrigger render={<Button variant="outline" />}` works to style the trigger.

## Known render warns
- `[FONT_MISSING] "Inter Variable", "Cambria"` — expected/suppressed (see Fonts). Not new.

## Re-sync risks (watch-list)
- **tw-safelist is a generated palette, not derived from real usage.** If the DS adds components using utilities outside the safelist families, they still ship (component source is `@source`-scanned), but the agent-facing palette won't grow unless you extend `gen-css.mjs`.
- **Tailwind version pin (4.3.1) in gen-css.mjs** can drift from `packages/ui`'s installed tailwindcss. If `bun install` bumps tailwindcss, update the `@tailwindcss/cli@X` pin in `gen-css.mjs` to match.
- **Self-symlink** is gitignored; recreated by gen-css.mjs each run. If you bypass buildCmd, create it manually.
- **Inter decision** is user-chosen (match repo). If the repo later actually installs Inter, drop it from `runtimeFontPrefixes` and it'll ship automatically.
- Previews are neutralized against the current Base UI API; a major @base-ui/react bump could change prop names (e.g. `defaultOpen`, `defaultChecked`, `render`).
