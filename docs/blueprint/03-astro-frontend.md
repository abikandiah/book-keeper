# Part 3 — Astro Frontend

**Context:** "Book Keeper" is a static Astro site. Part 1 defined the content
schema/collection; each book is a validated JSON file in
`src/content/books/`. This part builds the actual site: routes, components,
and visual direction. See `00-INDEX.md` for full context if needed.

## Routes to build

| Route | Purpose |
|---|---|
| `/` | All books, most-recently-added first, as compact list rows (see "Listing layout" below): title, author/year, tag pills, `one_line_takeaway`, cover thumbnail if `isbn` resolved. |
| `/books/[slug]` | Full book page: header (with cover if available), synopsis, chapter-by-chapter breakdown, key claims section, a "Review key claims →" link to `/review/[slug]` (Part 4). |
| `/tags/[tag]` | All books carrying that tag, same list layout as home. |
| `/tags` | A plain alphabetical index of every tag in use (not a weighted cloud — see "Visual direction"), linking to each `/tags/[tag]`. |

Every page also sets its own `<title>` and `<meta name="description">` (book
pages use `one_line_takeaway` as the description) — cheap, and it means a
pasted link actually previews something meaningful instead of generic
boilerplate.

Use `getCollection('books')` + `getStaticPaths()` for the dynamic routes —
standard Astro Content Collections pattern, no custom data-fetching needed.

## Styling & component system

Use the existing personal design system, `@abumble/design-system` — React
components built on Tailwind CSS, specifically customized shadcn-ui
components. It's already used in another Astro project on Cloudflare
(amumble), so this is a case of reusing an established system, not choosing
one fresh. Concretely:

- Install `@abumble/design-system` plus `@astrojs/react`. Tailwind is wired
  via `tailwindcss` + `@tailwindcss/vite` directly in `astro.config.mjs`
  (Tailwind v4's own Vite plugin) — **not** `@astrojs/tailwind`, which
  targets Tailwind v3 and doesn't apply here (see Part 0).
- `src/styles/global.css` already exists, seeded from the amumble project's
  own global stylesheet, and already imports the design system's token
  layer (`@import '@abumble/design-system/styles.css'`) plus the EB
  Garamond/Inter/JetBrains Mono font stack. Keep: the design tokens block,
  the `.site-header`/`.site-brand`/`.theme-toggle` structure, the
  centralized focus-style block, and the `.prose` → `--tw-prose-*` token
  mapping (this is what makes dark mode "just work" for body text with no
  `.prose-invert` needed). Prune before Part 3 is done: `.verse-feed*`,
  `.from-series*`, `.from-collection*`, `.collection-card`/`.content-list` —
  these are amumble content types (verses, series, a mixed content feed)
  with no book-keeper equivalent, pure dead weight here.
- **Dark mode: one light/dark pair, a plain sun/moon toggle button, no
  color-theme switcher.** The design system ships 5 named color themes
  (`linen`/`steel`/`sage`/`dusk`/`canopy`) plus a `ThemeProvider`/`useTheme`
  React Context for switching between them — don't use that provider here.
  It needs to hydrate as a client component wrapping the whole app, which
  defeats the "zero client JS except the review deck" principle below, and
  amumble itself doesn't use it either — amumble only ever toggles
  light/dark via a single sun/moon icon button, no dropdown. Reuse that
  simpler pattern: pick **one** color theme (`linen` is the practical
  choice — its CSS is written directly on bare `:root`/`:root.dark`, so
  using it means the *only* state to manage is toggling the `.dark` class,
  with no `data-theme` attribute involved at all) and implement the
  toggle as a small vanilla inline `<script>` in `Layout.astro`'s `<head>`
  (read `localStorage`/`prefers-color-scheme` before first paint to avoid a
  flash, toggle `.dark` on click, persist the choice) — no React, no
  hydration cost. The `.theme-toggle` CSS already in `global.css` (the
  sun/moon icon swap keyed off `html.dark`) is already written for exactly
  this vanilla approach.
- **Static pages ship zero extra client JS even though the components are
  React.** Astro renders React components to static HTML at build time by
  default — you only need a `client:*` directive when a component needs
  browser-side interactivity. `BookCard`, `TagPill`, `ChapterBlock`, and the
  page chrome are all presentational, so render them with no client
  directive at all. The *only* component in this whole project that needs
  `client:load` is the review deck in Part 4.
- Prefer composing existing primitives from the design system (Card, Badge,
  Separator, Typography wrappers, etc. — whatever it actually exports) over
  writing new components from scratch. Only build a new component when the
  library genuinely has no equivalent primitive to compose from.

## Components to build

- **`Layout.astro`** — shared shell: `<head>`, a fixed translucent header bar
  (`.site-header`/`.site-brand`/`.theme-toggle` from `global.css`, reused
  near-verbatim from amumble's structure), nav (Home / Tags), footer, wraps
  page content. The brand mark is `src/assets/logo.svg` (originally seeded
  as `beekeeper-svgrepo-com.svg`, renamed once selected as the actual logo;
  the unused alternate `beehive-honey-svgrepo-com.svg` is still sitting in
  `src/assets/` if a different mark is ever wanted) — "Book Keeper" as a
  beekeeper pun is intentional. It's inlined via a Vite `?raw` import and
  `set:html` (not `<img src>`), which is what lets `.site-logo svg path {
  fill: var(--foreground) }` in `global.css` recolor it per theme — an
  `<img>` reference can't be restyled that way. The original SVG had
  per-path inline `fill` styles from its source (svgrepo.com), which inline
  styles always win over a stylesheet rule; the checked-in file keeps only
  the subset of paths that were already unstyled black outline/line-art in
  the original (dropping the colored fill shapes), which is what renders as
  a legible monochrome silhouette instead of a solid blob. Use it in the
  `.site-logo` slot the way amumble's own logo occupies that same slot. Nav
  stays minimal — this is a personal site for one reader, not a product. Use
  the design system's layout/typography primitives here rather than raw HTML
  where they exist.
- **`BookCard`** — despite the name, this renders as a **compact list row**,
  not a boxed card (see "Listing layout" below) — used on `/` and
  `/tags/[tag]`. A small (`-M` size) cover thumbnail on the left if `isbn`
  resolved to one — see Part 1's `isbn` field note for the URL pattern,
  don't re-derive it here — otherwise a `CoverPlaceholder` (a tinted box at
  the same dimensions, with a small line-art book-glyph icon) fills the same
  slot, so every row has the same layout regardless of whether a given book
  has a resolved cover. (v1 shipped with no placeholder at all — an absent
  `isbn` just skipped the slot entirely — but that was revised once real
  covers existed alongside cover-less books side by side and the
  inconsistency read as more jarring than a deliberate placeholder would.)
  Title, author/year, tag pills, one-line takeaway. Links to `/books/[slug]`.
  Build as a React component, rendered with no client directive.
- **`TagPill`** — a tag chip, links to `/tags/[tag]`. This is very likely
  just the design system's existing `Badge` component reused directly —
  check before building a custom one.
- **`ChapterBlock`** — renders one chapter: number, title, `core_claim` as a
  pulled-out/emphasized line, `key_points` as a bullet list. Used in a loop
  on the book page.
- Book page itself can be `src/pages/books/[slug].astro` directly rather than
  a separate component, since it's not reused elsewhere — it composes
  `ChapterBlock` in a loop, shows a larger cover next to the header if
  `isbn` resolved (`-L` size instead of `-M`), and ends with a "Review key
  claims →" link to `/review/[slug]`.

### Listing layout: compact rows, not a card grid

The schema has no cover-image field of its own — covers, when present, come
from an ISBN resolved during generation (Part 2), and plenty of books won't
have one (obscure/self-published titles). A boxed card grid wants an image
to fill its whitespace and looks sparse without one; a **dense list** (dot
or thumbnail, title, author/year, tags trailing, one-liner beneath) reads
like a table of contents for a personal reading log instead, and holds up
fine whether or not a given row has a thumbnail. Use this for both `/` and
`/tags/[tag]`.

## Visual direction

This is a personal library/archive, not a marketing site or a SaaS dashboard
— design toward "a calm place to read," not toward conversion or density.
The design system provides the concrete tokens (colors, spacing, type scale)
— within that, aim for:

- **Typography-led, not chrome-led.** Whatever the design system's body-text
  styles are, favor generous line-height and a comfortable measure (line
  length) for the synopsis/chapter prose — this is a reading surface first.
- **Restrained use of the palette.** Even if the design system offers a full
  color set, lean on one or two accents at most here (e.g. for tag pills and
  the `core_claim` emphasis) — a busy multi-color result would fight the
  "calm library" feel regardless of how good the underlying tokens are.
- **The `core_claim` per chapter should be visually distinct** from the
  `key_points` bullets — e.g. a pull-quote treatment — since it's the one
  line a returning reader most wants their eye to land on first when
  skimming a chapter list.
- **Chapter list layout:** a vertical stack is fine and simplest; an
  accordion (collapsed by default, expand for `key_points`) is a nice later
  touch if chapter counts get long (e.g. the "All About Circuits" textbook
  case) — the design system likely already has an Accordion primitive
  (standard in shadcn-ui) if you want to reach for it, but don't add that
  complexity until a book actually needs it.
- **Dark mode is in for v1**, not deferred — see the "Dark mode" bullet
  under "Styling & component system" above for the concrete approach (one
  `linen` light/dark pair, vanilla toggle, no color-theme switcher).
- **`/tags` is a plain alphabetical list, not a weighted tag cloud.** A
  cloud (bigger font for more-used tags) looks busy and a little dated —
  with a personal library's worth of tags, a sorted list (optionally with a
  count per tag) stays legible and calm.
- **Cover thumbnails, when present, stay modest.** This is still a reading
  surface, not a shop shelf — a small thumbnail in the list rows, a
  slightly larger one next to the book-page header, never hero-sized or the
  visual focus of the page.

## Explicitly out of scope for v1

- Search (Pagefind or similar) — see Part 5, add once there are enough books
  that browsing by tag stops being sufficient.
- Any client-side interactivity on these routes beyond the dark-mode toggle's
  small vanilla script — review mode (Part 4) is the only page that needs a
  *React* JS island (`client:load`); everything in this part should ship
  zero React hydration despite being built from React components.

## Acceptance check for this part

- With the example book JSON from Part 1 in place, `/`, `/books/[slug]`, and
  `/tags/[tag]` all render correctly with real content, not placeholder text.
- Adding a second example book (different tag, different chapter count)
  confirms the templates hold up across varying input shapes — don't sign off
  on this part against a single example book only.
- Test with **both** an `isbn` present and absent across your example books —
  confirm the no-cover case renders the `CoverPlaceholder` cleanly (no
  broken-image icon, no layout shift versus a row/header that has a real
  cover), not just the happy path.
