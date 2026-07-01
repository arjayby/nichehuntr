# Building with @nichehuntr/ui

A shadcn-style React design system on **Base UI** primitives + **Tailwind v4**. Import components from the library; do your layout with Tailwind utility classes and the design tokens below. The look is mono-forward: **JetBrains Mono** for headings/UI, a **lime/chartreuse primary**, and generously rounded corners.

## Setup

- **No provider is required** for Button, Card, Checkbox, Input, Label, Skeleton, or DropdownMenu — Base UI components manage their own state/context. Compose sub-parts inside their parent (a `DropdownMenuLabel` must live inside a `DropdownMenuGroup`; card parts inside `Card`).
- **Toaster** (from sonner): render it once near the app root, then call `toast(...)` imperatively. It reads `next-themes` for light/dark if a `ThemeProvider` is present, otherwise defaults to system.
- **Theme = CSS variables**, already loaded via `styles.css` (light by default). For dark mode add the `dark` class to an ancestor (e.g. `<html class="dark">`). Don't redefine the tokens; use the utilities that map to them.

## Styling idiom — Tailwind v4 + semantic tokens

Style with Tailwind utility classes. **Always prefer the semantic color tokens over raw palette colors** so components stay on-theme and dark-mode-correct. Each token has a `bg-`, `text-`, `border-`, and `ring-` form:

| Token | Use for |
|---|---|
| `primary` / `primary-foreground` | primary actions, emphasis (the lime brand color) |
| `secondary` / `secondary-foreground` | secondary surfaces/buttons |
| `muted` / `muted-foreground` | subtle backgrounds, secondary text (`text-muted-foreground`) |
| `accent` / `accent-foreground` | hover/active surfaces, highlights |
| `card` / `card-foreground` | card surfaces |
| `popover` / `popover-foreground` | menus, popovers, floating panels |
| `destructive` | errors / dangerous actions (often `text-destructive` or `bg-destructive/10`) |
| `background` / `foreground` | page base surface + text |
| `border`, `input`, `ring` | `border-border`, `bg-input`, `focus-visible:ring-ring` |

Opacity modifiers work on these (`bg-primary/80`, `bg-destructive/10`, `ring-ring/30`). Layout is ordinary Tailwind: `flex`, `grid`, `gap-*`, `p-*`/`m-*`, `w-*`/`max-w-*`, `text-*`, `items-*`, `justify-*`, responsive `sm:`/`md:`/`lg:`, and state variants `hover:`/`focus:`/`disabled:`/`dark:`.

**Typography & shape:** headings/titles use `font-heading` (JetBrains Mono) — `CardTitle` already applies it; body text uses `font-sans`. Controls (buttons, inputs) are `rounded-2xl`; cards are more rounded still. Match this — don't hand-pick `rounded-sm`.

## Where the truth lives

Before styling, read the design system's `styles.css` (and its `@import`s) for the full token/utility set, and each component's `<Name>.d.ts` (its exact props) and `<Name>.prompt.md` (usage). Prefer real components over hand-built lookalikes — every export in the bundle is the shipped component.

## Idiomatic example

```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Button } from "@nichehuntr/ui";

export function DeployCard() {
  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>Deploy your project</CardTitle>
        <CardDescription>Ship changes to production in one click.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">All systems operational.</p>
      </CardContent>
      <CardFooter className="flex gap-2">
        <Button size="sm">Deploy</Button>
        <Button size="sm" variant="outline">Preview</Button>
      </CardFooter>
    </Card>
  );
}
```

Button `variant`: `default | secondary | outline | ghost | destructive | link`; `size`: `default | xs | sm | lg | icon | icon-xs | icon-sm | icon-lg`.
