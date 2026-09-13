# Part 3 — Astro Frontend

**Context:** "Book Keeper" is a static Astro site. Part 1 defined the content
schema/collection; each book is a validated JSON file in
`src/content/books/`. This part builds the actual site: routes, components,
and visual direction. See `00-INDEX.md` for full context if needed.

## Routes to build

| Route | Purpose |
|---|---|
| `/` | All books, most-recently-added first. Card per book: title, author, tags, `one_line_takeaway`. |
| `/books/[slug]` | Full book page: header, synopsis, chapter-by-chapter breakdown, key claims section. |
| `/tags/[tag]` | All books carrying that tag, same card layout as home. |
| `/tags` | Index of all tags in use (simple list/cloud), linking to each `/tags/[tag]`. |

Use `getCollection('books')` + `getStaticPaths()` for the dynamic routes —
standard Astro Content Collections pattern, no custom data-fetching needed.

## Styling & component system

Use the existing personal design system, `@abumble/design-system` — React
components built on Tailwind CSS, specifically customized shadcn-ui
components. It's already used in another Astro/Cloudflare Pages project
(amumble), so this is a case of reusing an established system, not choosing
one fresh. Concretely:

- Install `@abumble/design-system` plus Astro's `@astrojs/react` and
  `@astrojs/tailwind` integrations. Pull in the same Tailwind config/theme
  the design system expects (check how amumble wires this up and mirror it,
  rather than reinventing the Tailwind config independently).
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

- **`Layout.astro`** — shared shell: `<head>`, nav (Home / Tags), footer,
  wraps page content. Nav stays minimal — this is a personal site for one
  reader, not a product. Use the design system's layout/typography
  primitives here rather than raw HTML where they exist.
- **`BookCard`** — used on `/` and `/tags/[tag]`. Title, author, year, tag
  pills, one-line takeaway. Links to `/books/[slug]`. Build this as a React
  component using the design system's `Card`-style primitive (or equivalent),
  rendered with no client directive.
- **`TagPill`** — a tag chip, links to `/tags/[tag]`. This is very likely
  just the design system's existing `Badge` component reused directly —
  check before building a custom one.
- **`ChapterBlock`** — renders one chapter: number, title, `core_claim` as a
  pulled-out/emphasized line, `key_points` as a bullet list. Used in a loop
  on the book page.
- Book page itself can be `src/pages/books/[slug].astro` directly rather than
  a separate component, since it's not reused elsewhere — it composes
  `ChapterBlock` in a loop.

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
- No dark-mode requirement for v1 — though if the design system already
  supports a dark theme (common in shadcn-based systems), wiring it up may be
  nearly free; treat as a nice-to-have, not a requirement.

## Explicitly out of scope for v1

- Search (Pagefind or similar) — see Part 5, add once there are enough books
  that browsing by tag stops being sufficient.
- Any client-side interactivity on these routes — review mode (Part 4) is the
  only page that needs a JS island; everything in this part should ship zero
  client JS despite being built from React components.

## Acceptance check for this part

- With the example book JSON from Part 1 in place, `/`, `/books/[slug]`, and
  `/tags/[tag]` all render correctly with real content, not placeholder text.
- Adding a second example book (different tag, different chapter count)
  confirms the templates hold up across varying input shapes — don't sign off
  on this part against a single example book only.
