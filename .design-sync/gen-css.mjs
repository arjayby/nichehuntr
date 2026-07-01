#!/usr/bin/env node
/*
 * design-sync CSS build (cfg.buildCmd = `node .design-sync/gen-css.mjs`).
 *
 * @nichehuntr/ui ships Tailwind v4 *source* (globals.css), not compiled CSS, and
 * has no dist build. The claude.ai/design runtime loads only the static styles.css
 * closure (it does NOT run Tailwind), so:
 *   1. Tailwind must be compiled to real CSS here, and
 *   2. utilities the design agent may write (beyond what component source uses)
 *      must be emitted too — hence the generated safelist below.
 *
 * Steps: (a) ensure the workspace self-symlink the converter needs to resolve the
 * package dir; (b) generate .design-sync/tw-safelist.tsx (a broad utility palette
 * scanned via @source in tw-entry.css); (c) compile packages/ui/.ds-css/compiled.css
 * (which cfg.cssEntry points at) from .design-sync/tw-entry.css.
 *
 * Deterministic — safe to re-run on every sync. Requires bun (repo package manager).
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // .design-sync
const REPO = resolve(HERE, '..');

// ── (a) workspace self-symlink ────────────────────────────────────────────
// Converter derives PKG_DIR = join(--node-modules, "@nichehuntr/ui"); in a bun
// workspace the package isn't self-linked, so create it (mirrors the existing
// @nichehuntr/config link). Idempotent.
const link = resolve(REPO, 'packages/ui/node_modules/@nichehuntr/ui');
if (!existsSync(link)) {
  mkdirSync(dirname(link), { recursive: true });
  try { symlinkSync('../../../ui', link); console.error('· created @nichehuntr/ui self-symlink'); }
  catch (e) { console.error('! could not create self-symlink:', e.message); }
}

// ── (b) safelist ──────────────────────────────────────────────────────────
const classes = [];
const push = (...c) => { for (const x of c) if (x) classes.push(x); };
const cross = (prefixes, values) => prefixes.flatMap((p) => values.map((v) => `${p}${v}`));
const variants = (list, vs) => list.flatMap((c) => vs.map((v) => `${v}${c}`));

const SP = ['0', 'px', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '7', '8', '9', '10', '11', '12', '14', '16', '20', '24', '28', '32', '36', '40', '44', '48', '52', '56', '64', '72', '80', '96'];
const FRAC = ['1/2', '1/3', '2/3', '1/4', '3/4', '1/5', '2/5', '3/5', '4/5', '1/6', '5/6', '1/12'];
const SIZE_KW = ['full', 'min', 'max', 'fit', 'auto'];

// theme semantic colors (from packages/ui globals.css @theme inline)
const COLORS = [
  'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground',
  'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground',
  'accent', 'accent-foreground', 'destructive', 'border', 'input', 'ring',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
  'sidebar', 'sidebar-foreground', 'sidebar-primary', 'sidebar-primary-foreground',
  'sidebar-accent', 'sidebar-accent-foreground', 'sidebar-border', 'sidebar-ring',
  'transparent', 'current', 'white', 'black',
];
const OPACITY = ['5', '10', '20', '30', '40', '50', '60', '70', '80', '90'];
const OPACITY_COLORS = ['primary', 'secondary', 'muted', 'accent', 'destructive', 'foreground', 'background', 'border', 'input', 'ring', 'card', 'popover', 'black', 'white'];

// state variants applied to color/interactive utilities
const STATE = ['', 'hover:', 'focus:', 'focus-visible:', 'active:', 'disabled:', 'dark:', 'group-hover:', 'group-focus:', 'peer-focus:', 'aria-selected:', 'data-[state=open]:', 'data-[state=checked]:'];
const STATE_LITE = ['', 'hover:', 'focus:', 'active:', 'disabled:', 'dark:'];
// responsive variants applied to layout essentials
const BP = ['', 'sm:', 'md:', 'lg:'];

// display / box
push(...variants(['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'hidden', 'table', 'contents', 'flow-root', 'list-item'], BP));
push('static', 'fixed', 'absolute', 'relative', 'sticky');
push('isolate', 'isolation-auto', 'overflow-auto', 'overflow-hidden', 'overflow-clip', 'overflow-visible', 'overflow-scroll');
push(...cross(['overflow-x-', 'overflow-y-'], ['auto', 'hidden', 'clip', 'visible', 'scroll']));
push(...cross(['z-'], ['0', '10', '20', '30', '40', '50', 'auto']));
push(...cross(['object-'], ['contain', 'cover', 'fill', 'none', 'scale-down', 'center', 'top', 'bottom', 'left', 'right']));
push(...cross(['aspect-'], ['auto', 'square', 'video']));
push('box-border', 'box-content');

// flexbox / grid
push(...variants(['flex-row', 'flex-row-reverse', 'flex-col', 'flex-col-reverse'], BP));
push('flex-wrap', 'flex-wrap-reverse', 'flex-nowrap', 'flex-1', 'flex-auto', 'flex-initial', 'flex-none', 'grow', 'grow-0', 'shrink', 'shrink-0');
push(...cross(['basis-'], ['0', 'auto', 'full', ...FRAC]));
push(...variants(cross(['grid-cols-'], ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'none', 'subgrid']), BP));
push(...cross(['grid-rows-'], ['1', '2', '3', '4', '5', '6', 'none']));
push(...variants(cross(['col-span-'], ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'full']), BP), 'col-auto');
push(...cross(['row-span-'], ['1', '2', '3', '4', '5', '6', 'full']), 'row-auto');
push(...cross(['col-start-', 'col-end-'], ['1', '2', '3', '4', '5', '6', '7', '13', 'auto']));
push(...cross(['grid-flow-'], ['row', 'col', 'dense', 'row-dense', 'col-dense']));
push(...variants(cross(['justify-'], ['start', 'center', 'end', 'between', 'around', 'evenly', 'stretch']), BP));
push(...cross(['justify-items-'], ['start', 'center', 'end', 'stretch']));
push(...cross(['justify-self-'], ['auto', 'start', 'center', 'end', 'stretch']));
push(...variants(cross(['items-'], ['start', 'center', 'end', 'baseline', 'stretch']), BP));
push(...cross(['content-'], ['start', 'center', 'end', 'between', 'around', 'evenly', 'stretch', 'baseline']));
push(...cross(['self-'], ['auto', 'start', 'center', 'end', 'stretch', 'baseline']));
push(...cross(['place-content-', 'place-items-', 'place-self-'], ['start', 'center', 'end', 'stretch']));
push(...cross(['order-'], ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'first', 'last', 'none']));

// spacing
push(...variants(cross(['gap-'], SP), BP), ...cross(['gap-x-', 'gap-y-'], SP));
push(...cross(['p-', 'px-', 'py-', 'pt-', 'pr-', 'pb-', 'pl-', 'ps-', 'pe-'], SP));
push(...cross(['m-', 'mx-', 'my-', 'mt-', 'mr-', 'mb-', 'ml-', 'ms-', 'me-'], [...SP, 'auto']));
push(...cross(['-mt-', '-mr-', '-mb-', '-ml-', '-mx-', '-my-', '-m-'], SP.filter((s) => s !== '0' && s !== 'px')));
push(...cross(['space-x-', 'space-y-'], SP), 'space-x-reverse', 'space-y-reverse');

// sizing
push(...variants(cross(['w-'], [...SP, ...FRAC, ...SIZE_KW, 'screen']), BP));
push(...cross(['h-'], [...SP, ...FRAC, ...SIZE_KW, 'screen']));
push(...cross(['size-'], [...SP, 'full', 'min', 'max', 'fit', 'auto']));
push(...cross(['min-w-'], ['0', ...SIZE_KW.filter((k) => k !== 'auto')]));
push(...cross(['min-h-'], ['0', 'full', 'screen', 'min', 'max', 'fit']));
push(...variants(cross(['max-w-'], ['0', 'none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', 'full', 'min', 'max', 'fit', 'prose']), BP));
push(...cross(['max-h-'], [...SP, 'full', 'screen', 'none', 'min', 'max', 'fit']));

// typography
push(...variants(cross(['text-'], ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl']), BP));
push(...cross(['font-'], ['thin', 'extralight', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black', 'sans', 'serif', 'mono', 'heading']));
push(...cross(['leading-'], ['none', 'tight', 'snug', 'normal', 'relaxed', 'loose', '3', '4', '5', '6', '7', '8', '9', '10']));
push(...cross(['tracking-'], ['tighter', 'tight', 'normal', 'wide', 'wider', 'widest']));
push(...variants(cross(['text-'], ['left', 'center', 'right', 'justify', 'start', 'end']), BP));
push('underline', 'overline', 'line-through', 'no-underline', 'uppercase', 'lowercase', 'capitalize', 'normal-case', 'italic', 'not-italic', 'truncate', 'text-ellipsis', 'text-clip', 'antialiased', 'subpixel-antialiased', 'tabular-nums', 'proportional-nums');
push(...cross(['underline-offset-'], ['auto', '0', '1', '2', '4', '8']));
push(...cross(['whitespace-'], ['normal', 'nowrap', 'pre', 'pre-line', 'pre-wrap', 'break-spaces']));
push(...cross(['break-'], ['normal', 'words', 'all', 'keep']), 'text-wrap', 'text-nowrap', 'text-balance', 'text-pretty');
push(...cross(['line-clamp-'], ['1', '2', '3', '4', '5', '6', 'none']));
push(...cross(['list-'], ['none', 'disc', 'decimal', 'inside', 'outside']));
push(...cross(['align-'], ['baseline', 'top', 'middle', 'bottom', 'text-top', 'text-bottom', 'sub', 'super']));
push(...cross(['indent-'], ['0', '1', '2', '4', '8']));

// colors — base + variants for the common utilities
push(...variants(cross(['bg-', 'text-', 'border-', 'ring-'], COLORS), STATE_LITE));
push(...cross(['fill-', 'stroke-', 'outline-', 'divide-', 'placeholder-', 'caret-', 'decoration-', 'accent-', 'from-', 'via-', 'to-'], COLORS));
push(...variants(cross(cross(['bg-', 'text-', 'border-'], OPACITY_COLORS).map((c) => `${c}/`), OPACITY), ['', 'hover:', 'dark:']));

// borders / radius / effects
push(...cross(['rounded-'], ['none', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full']));
push(...cross(['rounded-t-', 'rounded-r-', 'rounded-b-', 'rounded-l-', 'rounded-tl-', 'rounded-tr-', 'rounded-br-', 'rounded-bl-', 'rounded-s-', 'rounded-e-'], ['none', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full']));
push('border', ...cross(['border-'], ['0', '2', '4', '8', 'x', 'y', 't', 'r', 'b', 'l', 'solid', 'dashed', 'dotted', 'double', 'hidden', 'none']));
push(...cross(['border-x-', 'border-y-', 'border-t-', 'border-r-', 'border-b-', 'border-l-'], ['0', '2', '4', '8']));
push('divide-x', 'divide-y', 'divide-x-0', 'divide-y-0', 'divide-x-2', 'divide-y-2', 'divide-x-4', 'divide-y-4', 'divide-solid', 'divide-dashed', 'divide-dotted');
push('ring', ...cross(['ring-'], ['0', '1', '2', '4', '8', 'inset']), ...cross(['ring-offset-'], ['0', '1', '2', '4', '8']));
push('outline', ...cross(['outline-'], ['0', '1', '2', '4', '8', 'none', 'dashed', 'dotted', 'solid']), ...cross(['outline-offset-'], ['0', '1', '2', '4', '8']));
push(...variants(['shadow-2xs', 'shadow-xs', 'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl', 'shadow-2xl', 'shadow-inner', 'shadow-none', 'shadow'], STATE_LITE));
push(...variants(cross(['opacity-'], ['0', '5', '10', '20', '25', '30', '40', '50', '60', '70', '75', '80', '90', '95', '100']), STATE_LITE));
push(...cross(['bg-linear-to-', 'bg-gradient-to-'], ['t', 'tr', 'r', 'br', 'b', 'bl', 'l', 'tl']), 'bg-none', 'bg-cover', 'bg-contain', 'bg-center', 'bg-no-repeat', 'bg-repeat', 'bg-fixed', 'bg-clip-border', 'bg-clip-padding', 'bg-clip-text');

// transitions / animation / transforms
push('transition', ...cross(['transition-'], ['none', 'all', 'colors', 'opacity', 'shadow', 'transform']));
push(...cross(['duration-'], ['0', '75', '100', '150', '200', '300', '500', '700', '1000']));
push('ease-linear', 'ease-in', 'ease-out', 'ease-in-out');
push(...cross(['delay-'], ['0', '75', '100', '150', '200', '300', '500', '700', '1000']));
push('animate-none', 'animate-spin', 'animate-ping', 'animate-pulse', 'animate-bounce');
push(...variants(cross(['scale-', 'scale-x-', 'scale-y-'], ['0', '50', '75', '90', '95', '100', '105', '110', '125', '150']), STATE_LITE));
push(...cross(['rotate-', '-rotate-'], ['0', '1', '2', '3', '6', '12', '45', '90', '180']));
push(...variants(cross(['translate-x-', 'translate-y-', '-translate-x-', '-translate-y-'], ['0', 'px', '1', '2', '3', '4', '6', '8', '12', '1/2', '1/3', '2/3', '1/4', '3/4', 'full']), STATE_LITE));
push('transform', 'transform-gpu', 'transform-none', 'origin-center', 'origin-top', 'origin-bottom', 'origin-left', 'origin-right', 'origin-top-left', 'origin-top-right', 'origin-bottom-left', 'origin-bottom-right');

// positioning (inset)
push(...cross(['inset-', 'inset-x-', 'inset-y-', 'top-', 'right-', 'bottom-', 'left-', 'start-', 'end-'], ['0', 'px', '1', '2', '3', '4', '5', '6', '8', '10', '12', '16', '20', '24', 'auto', 'full', '1/2', '1/3', '2/3', '1/4', '3/4']));
push(...cross(['-top-', '-right-', '-bottom-', '-left-', '-inset-'], ['1', '2', '3', '4', '6', '8', '12', 'px']));

// interactivity / misc
push(...cross(['cursor-'], ['auto', 'default', 'pointer', 'wait', 'text', 'move', 'help', 'not-allowed', 'none', 'progress', 'grab', 'grabbing', 'zoom-in', 'zoom-out']));
push(...cross(['select-'], ['none', 'text', 'all', 'auto']));
push('pointer-events-none', 'pointer-events-auto', 'resize-none', 'resize', 'resize-x', 'resize-y', 'appearance-none', 'appearance-auto', 'scroll-auto', 'scroll-smooth', 'sr-only', 'not-sr-only', 'will-change-auto', 'will-change-scroll', 'will-change-contents', 'will-change-transform', 'backdrop-blur', 'backdrop-blur-sm', 'backdrop-blur-md', 'backdrop-blur-lg', 'blur', 'blur-sm', 'blur-md', 'blur-lg', 'blur-none');

// de-dupe + emit as className strings (chunked so no single attribute is enormous)
const uniq = [...new Set(classes)];
const CHUNK = 400;
const blocks = [];
for (let i = 0; i < uniq.length; i += CHUNK) {
  blocks.push(`      <span className=${JSON.stringify(uniq.slice(i, i + CHUNK).join(' '))} />`);
}
const tsx = `// AUTO-GENERATED by .design-sync/gen-css.mjs — do not edit by hand.
// A broad Tailwind utility palette scanned by @source in tw-entry.css, so the
// claude.ai/design agent's compositions render styled (the design runtime loads
// static CSS and does not run Tailwind). ${uniq.length} utilities.
export default function TwSafelist() {
  return (
    <>
${blocks.join('\n')}
    </>
  );
}
`;
writeFileSync(resolve(HERE, 'tw-safelist.tsx'), tsx);
console.error(`· wrote tw-safelist.tsx (${uniq.length} utilities)`);

// ── (c) compile ───────────────────────────────────────────────────────────
mkdirSync(resolve(REPO, 'packages/ui/.ds-css'), { recursive: true });
const cmd = 'bunx @tailwindcss/cli@4.3.1 -i .design-sync/tw-entry.css -o packages/ui/.ds-css/compiled.css --minify';
console.error(`· ${cmd}`);
execSync(cmd, { cwd: REPO, stdio: 'inherit' });
console.error('· compiled packages/ui/.ds-css/compiled.css');
