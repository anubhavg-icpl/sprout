# Sprout design contract

Sprout's UI follows the owner-supplied UEC module UI contract (v2.0). This file
records only the rules this app applies. The full source document is internal
and is deliberately not committed to this public repo.

## Tokens (public/css/app.css, `:root` + dark block)

- **Colour:** OKLCH values with shared names only: `--background`, `--foreground`, `--card`,
  `--popover`, `--primary`, `--primary-foreground`, `--primary-accent`, `--muted`, `--muted-foreground`,
  `--destructive`, `--border`, `--input`, `--ring`, `--status-*`.
  - Every token has one name with two values, light and dark. Never write a theme-specific colour rule.
  - There is one accent, the family blue `#2769FC` (dark `oklch(0.5722 0.2291 262.98)`). `--primary-accent`
    is its AA-safe text tone.
- **Washes:** `--accent-soft` (13% mix) and `--accent-line` (35% mix). They are composed from the accent, not new hues.
- **Elevation:** elevated surfaces are brighter in both themes. Depth is a hairline plus a light shadow, never a glow.
- **Type:** Geist and Geist Mono, self-hosted variable WOFF2 (OFL), `font-display: optional`, preloaded.
  - Scale: 20/600 title, 18/600 section, 16/500 page title, 14/400 body, 13/500 label, 12/500 caption.
  - **Nothing goes below 12px.**
- **Radius:** 6 for chips, 8 for buttons and inputs, 10 for cards, 14 for dialogs.
- **Spacing:** 4px grid. The topbar is 58px with a hairline below it. Content padding is 26px by 30px.

## Rules

- Status is a dot plus a word, resolved in one place (`canonicalStatus()` in `app.js`).
  Only error and offline dots pulse.
- Agents are told apart by icon, never by hue.
- There is exactly one primary button per screen (Send).
- Toasts sit bottom-right, or top-centre under 640px, with at most 3 visible.
  - Info toasts dismiss after 4s; errors never auto-dismiss.
  - The close button is always visible.
- Icons are Phosphor Bold only (MIT). Icon-only controls carry an `aria-label`.
- Motion runs 150 to 250ms with ease-out, using transform and opacity only.
  - Allowed motion: a step shimmer and the dialog and toast entrance.
  - The reduced-motion block stays last in the stylesheet.
- Copy is sentence case, with no em-dashes, no exclamation marks and no cute empty states.
- Banned: gradients, glow, `backdrop-filter`, decorative grid textures, coloured side stripes.
  The 3px toast severity edge is the one exception.
- **3D robot exception:** WebGL can't read CSS variables, so `robot.js` uses concrete hex
  (neutral shell, graphite joints, accent-blue eyes). This mirrors the contract's canvas exception.

## Enforcement

`scripts/check-invariants.ts` runs as part of `bun run check` and fails on any of these:
- an em-dash in `public/` or `src/`
- a font size below 12px
- inline script or style
- a raw-HTML sink
