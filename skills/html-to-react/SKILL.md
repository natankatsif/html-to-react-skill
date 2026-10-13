---
name: html-to-react
description: Converts static HTML + CSS or HTML + Tailwind pages (landing pages, HTML templates, Webflow/Framer/ThemeForest exports, saved web pages, Tailwind UI snippets) into clean React / Next.js components while spending few tokens - scripts parse, clean, convert CSS to Tailwind and write the JSX; the model only reads a compact outline, picks component boundaries and names, and rebuilds the page's JavaScript as React state. Use whenever the user wants HTML, CSS or Tailwind markup turned into React, JSX, TSX or Next.js components, wants to port or migrate a static site, template or landing page to React, or says things like "convert this html to react", "переделай вёрстку в компоненты", "сделай из html реакт", even for a single pasted file. Also when the user has separate desktop and mobile exports of the same page - they are merged into one responsive component set.
---

# HTML → React, token-lean

The expensive way to do this is to read the whole page and retype it as JSX: the
model pays for every byte twice (input and output), drifts on long files, and
copies junk (wrappers, dead classes, scripts) into React. This skill splits the
work instead:

- **Scripts** (deterministic, free): parse HTML+CSS+JS, delete what React must
  not get, turn CSS into Tailwind utilities through a real cascade, detect
  repeated blocks and turn them into data + `.map()`, write every file, copy
  assets, verify.
- **You** (judgment only): read a ~1-2k token outline, decide component
  boundaries and names in a small JSON plan, then re-implement the page's
  JavaScript behavior with React state using small edits.

Never read the source HTML/CSS files and never type markup by hand: the outline
has what you need, and the generator carries every class and attribute over
verbatim.

`<skill>` below is the directory of this file. All commands go through
`<skill>/scripts/h2r.mjs`, which installs its npm dependencies on first run
(needs Node 18+ and network access once).

## Workflow

Copy this checklist into your reply and tick it off:

```
- [ ] 1 analyze   - run analyze.mjs, read outline.txt (+ behavior.md if ⚡)
- [ ] 2 plan      - edit plan.json: components, names, lists, icons, client
- [ ] 3 generate  - run generate.mjs, fix plan errors until it writes
- [ ] 4 behavior  - resolve every TODO(h2r) in todo.md with React state
- [ ] 5 check     - run check.mjs --tsc --lint until ✓
- [ ] 6 visual    - run visual-diff.mjs if the app can be served
```

### 1. Analyze

```bash
node <skill>/scripts/h2r.mjs analyze path/to/index.html --project .   # add --css x.css for stylesheets the HTML does not link
```

It detects the target project (TS/JS, Next app router, Tailwind version, `@/`
alias, indentation) and writes `.h2r/<slug>/`: `outline.txt`, `behavior.md`,
`plan.json` (pre-filled), `report.json`, `scripts/` (the page JS, for lookup
only). Read `outline.txt`; read `behavior.md` only if the outline shows ⚡.
Re-running analyze never overwrites an edited `plan.json` (it writes
`plan.suggested.json`; `--force` replaces it).

**Several layouts of one page** (a desktop export and a mobile export from
Figma/Pencil/Framer, `home-1440.html` + `home-390.html`, ...) are ONE page:
pass all files to a single analyze run, in any order.

```bash
node <skill>/scripts/h2r.mjs analyze desktop.html mobile.html --project .   # --widths 1440,390 if not detectable
```

The smallest layout becomes the base and each wider one applies from the
Tailwind breakpoint between them (390 + 1278 → `lg:`). Elements are matched
by layer name, text and SVG, so shared parts become one element with responsive
classes; only what really differs is rendered twice with `lg:hidden` /
`max-lg:hidden`. Never generate a second component set (`mobile/`,
`*Mobile.tsx`) and never hand-merge two outputs. If the user sends the second
layout later, re-run analyze with **both** files and `--force`, carry your
component names over to the new plan, and regenerate into the same `outDir`.
In the outline, `[<lg only]` / `[lg+ only]` mark one-layout elements and
`[wrapper <lg]` a box that exists in one layout only (it becomes
`display: contents` in the other) - prefer component boundaries on shared
elements.

Outline syntax:

```
n12 section#features.services [~1.2kt]          id · tag · #id · .semantic-class · subtree size in tokens
  n15 li.service-item ×4 list{image, title, text} first item of a repeated list (will become .map)
    n17 h4 {title} "Web design"                  field bound to the list data, sample text
  n30 button ⚡ ion:chevron-down                   ⚡ = page JS touches it, icon font in use
  i3                                              an inline SVG (unique icon #3)
  n40 div ≈n12                                    same structure as n12 elsewhere (shared component?)
```

### 2. Plan

Edit `.h2r/<slug>/plan.json`. analyze pre-fills it (paths, top-level sections,
icon names); you mostly rename and add. Fields:

| field | what you decide |
|---|---|
| `outDir`, `page.file`, `page.name` | where files go. Use a new folder: generate overwrites files there. |
| `components` | `{"n12": "Services"}` - each id becomes its own file. Pick a **list's first item** (`×N`) to make an item component; its fields become typed props. |
| `lists` | `{"n15": "services"}` or `{"n15": {"name": "services", "fields": {"text": "description"}}}` to rename the data array and fields. |
| `unroll` | `["n19"]` - write that list out literally instead of `.map()` (e.g. two unrelated buttons). |
| `icons` | per svg: `"MenuIcon"` (component in icons.tsx), `"lucide:Menu"`, `"file"` (big illustration → `<img>`), `"inline"`. |
| `iconFonts` | `{"fa:envelope": "lucide:Mail", "ion:logo-github": "lucide:Github"}` - replaces icon-font tags. |
| `client` | names of components that will hold state/handlers (get `"use client"`). Only those - keep the rest server components. |
| `drop` | ids to delete (cookie banners, template credits, dead markup). Ask the user before dropping visible content. |
| `styling` | `"tailwind"` (default when the project has Tailwind) or `"css"` (keep original class names + purged stylesheet). |
| `image`, `link` | `"next"` to use `next/image` (only for imgs with width+height) / `next/link` (internal paths). Default plain tags. |

Good boundaries:
- One component per landmark/section (`nav`, `header`, hero, each `section`, `footer`), named by role (`Hero`, `Pricing`), not by content text.
- A list item becomes its own component when it is big (≳15 lines) or the same shape appears elsewhere (`≈`). Small lists (nav links, footer links) stay inline maps.
- Aim for files of 30-200 lines. Do not split below that; extra files cost tokens on every later read.
- Components the page JS touches (⚡) are the ones that need `client`; put the state at the lowest common parent (e.g. tabs: the component holding both buttons and panels).

### 3. Generate

```bash
node <skill>/scripts/h2r.mjs generate .h2r/<slug>/plan.json
```

It validates the plan first (unknown ids, ids inside list items, bad names) and
explains each problem; fix plan.json and rerun. Then it writes the components,
`icons.tsx`, the page (with `metadata` for Next app router), a page CSS file
only for what utilities cannot express (`@keyframes`, `:root` variables,
`::selection`, scrollbar styles), copies local assets to `public/<slug>/`, and
writes `todo.md`.

Re-running generate overwrites the output files. Settle the plan **before**
hand-editing; if you must regenerate later, re-apply your edits.

### 4. Behavior

`todo.md` lists every `TODO(h2r)` marker with file:line and what the old JS did
(selectors, events, toggled classes). For each one:

1. Read only ~20 lines around the marker (not the whole file), plus the original
   script in `.h2r/<slug>/scripts/` if the note is not enough.
2. Rebuild the behavior with React (patterns: [references/behavior-patterns.md](references/behavior-patterns.md)).
3. Delete the marker.

State classes are already wired: classes the old JS toggled (`active`, `open`)
are kept on elements, and their CSS became variants such as `[&.active]:block`
or `group-[.active]:visible`. So the React side is usually just
``className={`... ${isOpen ? "active" : ""}`}`` - do not rewrite those utilities.

Remove what only existed for the old JS: `id`s and `data-*` used as hooks are
already gone; replace `href="#"` buttons with `<button type="button">` when they
do not navigate.

### 5. Check

```bash
node <skill>/scripts/h2r.mjs check .h2r/<slug>/plan.json --tsc --lint
```

Reports leftover TODOs, HTML-isms in JSX (`class=`, `style="..."`, inline
handlers, DOM queries), classes unknown to the project's Tailwind, repeated JSX
blocks (a missed component/map), and tsc/eslint errors in the generated files
only. Fix until it prints ✓. `<img>` lint warnings are expected unless the plan
used `"image": "next"`.

### 6. Visual check

If the project can run (`npm run dev`), compare the original page and the route:

```bash
node <skill>/scripts/h2r.mjs visual-diff path/to/index.html http://localhost:3000/<route> --hide "body > header"
```

analyze prints the page's breakpoints (`responsive: ... breakpoints 600, 900px`);
pass `--widths` with one width on each side of every breakpoint (e.g.
`--widths 1280,880,620,390`) so responsive rules are actually compared.
It prints one line per width: % of differing pixels,
page heights, first differing row. `--hide` hides the host app's own chrome
(site header, cookie bar). Under 1% is done. Open `diff-<w>.png` only when a
number is high; causes and fixes: [references/troubleshooting.md](references/troubleshooting.md).

Finish by telling the user what was created, what still differs, and that
`.h2r/` is a scratch folder (delete it or add it to `.gitignore`).

## What the scripts already handle

Do not redo these by hand - it wastes tokens and usually breaks something:

- head/meta/scripts/comments/analytics attributes removed; title/description → Next `metadata`; web-font `<link>`s kept (React 19 hoists them).
- `class`→`className`, `for`→`htmlFor`, SVG attribute casing, boolean/numeric attrs, `style` strings → objects, `value`/`checked`/`selected` → `defaultValue`/`defaultChecked`, entities escaped, `<br>`/`<img>` self-closed, `alt=""` added.
- HTML whitespace semantics made explicit (`{" "}` only where the browser would render a space).
- Dead classes, unused ids and `data-*`, empty and pass-through wrapper `div`s removed.
- CSS → Tailwind through a real cascade (specificity, source order, shorthands, `!important`, media queries, `:hover`/`::before`, ancestor states → `group-*`, sibling states → `peer-*`); output validated against the project's Tailwind, invalid classes fall back to arbitrary properties.
- Tailwind Preflight vs. plain-CSS pages: such pages rely on browser defaults (bold headings, list bullets, inline images, form-control looks, `line-height: normal`) that Preflight erases. tailwind styling re-adds them as lowest-priority utilities; css styling scopes the page under a root class and undoes Preflight there with `all: revert-layer`.
- css styling scopes every selector under the page root (`:where(.slug-page)`, no added specificity) and maps `body {}` to it, so the page's CSS cannot leak into the rest of the app.
- Tailwind v4 ordering traps: arbitrary breakpoints (`min-[1250px]:`) sort before named ones, and arbitrary properties (`[font:inherit]`) after normal utilities; the generator writes classes so the original cascade still holds.
- Old Tailwind (v1-v3) classes renamed for v4, legacy no-op classes dropped, v3 default border colors restored.
- Repeated siblings → data array + `.map()` with keys; nested runs → nested lists; state-class differences → boolean props.
- Inline SVGs deduped into icon components (optimized with svgo); big illustrations become files.
- Local images/fonts/CSS `url()`s copied to `public/<slug>/` and rewritten.

## When scripts cannot run

No Node, or the user only pastes a snippet: convert by hand following
[references/manual-conversion.md](references/manual-conversion.md) (the same rules, applied section by section).
For a snippet under ~150 lines that is cheaper than the pipeline; above that, set up Node.
