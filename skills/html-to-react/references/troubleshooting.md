# Troubleshooting visual and build differences

Read the visual-diff line first: `% differ`, heights, `first difference at y=`.
A height mismatch means layout drift; everything below the first differing row
shifts, so fix from the top down and re-run - one cause often explains most of the %.

## Contents
- Differences from the very top (y≈0)
- Text looks different (fonts, weights, line-height)
- Element sizes differ (images, widths at one breakpoint)
- Something is missing or invisible
- Build / type errors
- Pages that depend on a CSS framework from a CDN

## Differences from the very top (y≈0)

- **Host app chrome**: the app's layout adds a header/footer the original page did not have. Pass `--hide "body > header"` (any selector list) to visual-diff.
- **Background stops at the content**: body styles were moved to the page wrapper `div` (the app owns `<body>`); the generator adds `min-h-screen flow-root`. If the app's layout puts the page inside a padded container, the wrapper cannot reach the edges - tell the user, or use a route group with its own layout.
- **Margins collapsing through the wrapper**: the wrapper needs `flow-root` (generator adds it when it has a background). Add it by hand if you moved the background.

## Text looks different (fonts, weights, line-height)

- **Font not loaded**: analyze lists the page's web fonts; React 19 hoists the generated `<link rel="stylesheet" precedence="default">`. On React 18 add the link to the root layout. If you switch to `next/font`, the CSS still names the family literally (`'Poppins'`), so expose it under that name or update the utilities.
- **Weights/sizes of headings, line spacing, list bullets**: Tailwind Preflight resets browser defaults. For plain-CSS sources the generator re-adds them (lowest priority); if you hand-write markup, remember `h1-h6` are not bold and `line-height` is 1.5 under Preflight.
- **Cascade layers**: Tailwind v4 puts Preflight and utilities in `@layer`s; any unlayered CSS (the app's `globals.css`) beats every layered rule regardless of specificity. A global `body {}` or `a {}` in the app can override the converted page - target the specific element with a utility instead of adding more global CSS.

## Element sizes differ (images, widths at one breakpoint)

- **Images shrink/stretch**: Preflight sets `img { max-width:100%; height:auto; display:block }`. Plain-CSS pages get `inline max-w-none` back automatically; Tailwind sources were designed with it.
- **One breakpoint wrong**: Tailwind v4 emits arbitrary breakpoints (`min-[1250px]:`) before named ones (`lg:`) regardless of value, so `lg:w-[950px] min-[1250px]:w-auto` lets `lg` win. The generator writes all breakpoints of a page as arbitrary values when any is non-standard; keep that consistent when editing (do not mix `lg:` with `min-[...]` for the same property).
- **Shorthand vs longhand**: arbitrary-property classes (`[font:inherit]`) sort after normal utilities, so they override longhands like `text-sm`. The generator splits partially-overridden shorthands; if you add one by hand, use longhands.

## Something is missing or invisible

- **Content hidden until JS runs**: reveal libraries (AOS/WOW) start elements at `opacity:0`; their attributes are dropped, so content shows - re-add animation per behavior-patterns.
- **State class not applied initially**: the static HTML had `class="active"` on the first tab/panel; keep that initial state in `useState`.
- **Icons missing**: icon fonts must be mapped in `plan.iconFonts` (e.g. `lucide:Mail`); unmapped `<ion-icon>`/`<i class="fa ...">` stay as markup and need their CDN script/CSS.
- **Broken images**: `report.json` → `missingAssets`. The original paths were not found next to the HTML; ask the user for the asset folder and re-run (generate copies them to `public/<slug>/`).

## Build / type errors

- `Property 'ion-icon' does not exist on type JSX.IntrinsicElements`: map the icon font in the plan, or declare the custom element in a `.d.ts`.
- `Type ... is not assignable` on item component spread props: a field is missing in some list items; make the prop optional in the generated type or give the item a value.
- Hooks in a server component: the component needs `"use client"` - add its name to `plan.client` (or add the directive) and keep the state as low as possible.

## Pages that depend on a CSS framework from a CDN

Bootstrap/Bulma/Foundation pages keep their framework classes when `report.json`
lists `externalCss`. Converting framework classes to Tailwind is a redesign, not
a conversion. Default: `styling: "css"`, install the framework from npm and import
its CSS once in the layout. Offer a Tailwind rewrite as a separate step only if the user wants it.
