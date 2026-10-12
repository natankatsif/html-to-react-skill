# Converting by hand (no Node, or a small snippet)

Same goals as the pipeline, applied by you. Work section by section; never paste
the whole page into one answer.

## Order of work

1. **Inventory first, cheaply**: list landmarks/sections, repeated blocks (same structure ≥2 times → one component or a `.map`), inline SVGs (→ icon components), and every script/handler. For big files use `grep -n` on `<section`, `<header`, `<nav`, `<footer`, `class="`, `<script`, `<svg` instead of reading everything.
2. **Plan** component names and files before writing code (same rules as the plan in SKILL.md).
3. **Convert one section per step**, writing each file once. For a repeated block write the item once plus a data array.
4. **Behavior last**, with the patterns in behavior-patterns.md.

## Must-do JSX rules

- `class`→`className`, `for`→`htmlFor`, `tabindex`→`tabIndex`, `readonly`→`readOnly`, `maxlength`→`maxLength`, `colspan`→`colSpan`, `srcset`→`srcSet`, `autocomplete`→`autoComplete`, `crossorigin`→`crossOrigin`; `aria-*`/`data-*` unchanged.
- SVG: hyphenated attributes to camelCase (`stroke-width`→`strokeWidth`, `fill-rule`→`fillRule`, `clip-path`→`clipPath`, `xlink:href`→`href`); drop `xmlns`, `version`, `data-name`.
- `style="a: b; --x: 1"` → `style={{ a: "b", "--x": "1" } as React.CSSProperties}`; keep values as strings.
- Void elements self-close: `<img />`, `<br />`, `<input />`, `<hr />`, `<source />`.
- Uncontrolled forms: `value`→`defaultValue` (text inputs/textarea content), `checked`→`defaultChecked`, `<option selected>` → `defaultValue` on `<select>`.
- Text: escape `{ } < >` and, for eslint, `'` → `&apos;` and `"` → `&quot;`.
- Whitespace: HTML renders one space between inline siblings; JSX drops whitespace that contains a newline. Write `{" "}` where a space is visible (between inline elements/text), never between block elements or inside flex/grid containers.
- Remove: `<script>`, comments, inline `on*` handlers (rebuild as React handlers), analytics/animation attributes (`data-aos`, `data-wow-*`), ids and classes used only by scripts, classes with no CSS rule, empty or attribute-less wrapper `div`s.
- `<img>` without `alt` gets `alt=""`.

## CSS → Tailwind by hand

- Only for small CSS. Resolve the cascade per element first (specificity, then order), then write utilities; use arbitrary values (`p-[18px]`) instead of rounding to the scale.
- Media queries become variants; if any breakpoint is non-standard use arbitrary `min-[Npx]:` for **all** of them (Tailwind v4 sorts arbitrary breakpoints before named ones).
- `:hover` → `hover:`, `::before` → `before:content-['']`, `.card:hover .title` → `group` on the card + `group-hover:` on the title, `.x.active` toggled by JS → `[&.active]:`.
- Keep `@keyframes`, `@font-face`, `:root` variables and scrollbar styles as CSS.
- Plain-CSS pages relied on browser defaults that Preflight removes: re-add bold/size on headings, list bullets, `inline` images without `max-width`, `line-height: normal` on the page root, unless the page's CSS sets them.
- For heavy CSS (hundreds of rules, many variables) keep it as a stylesheet with the original class names instead (`styling: "css"`): faster, safer, and still clean React.
