# Rebuilding page JavaScript in React

## Contents
- Ground rules
- Toggle a state class (menu, sidebar, accordion)
- Tabs / "pages" switched by nav buttons
- Close on outside click / Escape
- Header that changes on scroll
- Modal filled from the clicked item
- Filter a list (buttons or select)
- Form: enable submit when valid
- Carousels, reveal-on-scroll, counters, typed text
- jQuery / Bootstrap / Alpine equivalents

## Ground rules

- State lives in the lowest component that contains every element the old script touched. If that is the page, make a small client wrapper instead of turning the whole page into a client component.
- Keep the generated utilities. Toggle the kept state class (`active`, `open`, `show`) and let the `[&.active]:...` / `group-[.active]:...` variants do the styling.
- No `document.querySelector`, `getElementById`, `classList`: use state, props, refs.
- Anything touching `window`/`document`/`localStorage` goes in `useEffect` (server components and SSR have no DOM).
- Use `clsx`/`cn` if the project already has it; otherwise a template literal: ``className={`base ${on ? "active" : ""}`}``.

## Toggle a state class (menu, sidebar, accordion)

Old: `btn.addEventListener("click", () => sidebar.classList.toggle("active"))`

```tsx
const [open, setOpen] = useState(false);
<aside className={`group ... ${open ? "active" : ""}`}>
  <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
```

Tailwind-sourced pages often toggle a utility instead (`hidden`): render it conditionally.
`<div className={`... ${open ? "" : "hidden"} lg:flex`}>` - keep the responsive classes that override it.

## Tabs / "pages" switched by nav buttons

Old: buttons with `data-nav-link`, panels with `data-page`, script compares text and toggles `active` on both.

```tsx
const [page, setPage] = useState("about");
{navItems.map((item) => (
  <button key={item.label} className={`... ${page === item.label.toLowerCase() ? "active" : ""}`} onClick={() => setPage(item.label.toLowerCase())}>
))}
<About className={page === "about" ? "active" : ""} />
```

Panels that are separate components receive `active` (or `className`) as a prop; keep the
first panel active initially, like the static HTML did. If several panels are siblings in
one file, render only the active one instead when the CSS just hides the others
(`display: none` → conditional rendering is equivalent and simpler).

## Close on outside click / Escape

```tsx
const ref = useRef<HTMLDivElement>(null);
useEffect(() => {
  if (!open) return;
  const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
  document.addEventListener("pointerdown", onDown);
  document.addEventListener("keydown", onKey);
  return () => (document.removeEventListener("pointerdown", onDown), document.removeEventListener("keydown", onKey));
}, [open]);
```

## Header that changes on scroll

Old: `scroll` listener adding `bg-white shadow` past N px.

```tsx
const [scrolled, setScrolled] = useState(false);
useEffect(() => {
  const onScroll = () => setScrolled(window.scrollY > 10);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
  return () => window.removeEventListener("scroll", onScroll);
}, []);
<nav className={`fixed ... ${scrolled ? "bg-white shadow-sm text-gray-800" : "text-white"}`}>
```

behavior.md lists the utility equivalent of custom classes the script toggled (`.gradient = bg-[...]`): use those strings.

## Modal filled from the clicked item

Old: click on a card copies its image/title/text into a modal and adds `active` to modal + overlay.

```tsx
const [selected, setSelected] = useState<Testimonial | null>(null);
{testimonials.map((t) => <TestimonialCard key={t.title} {...t} onOpen={() => setSelected(t)} />)}
<TestimonialModal item={selected} onClose={() => setSelected(null)} />
```

The modal keeps its markup; replace the copied fields with `item.*` and add `active` when `item` is set.
Item components get an `onOpen?: () => void` prop; put it on the clickable root (make it a `<button>` or add `role="button"` + `onKeyDown` for accessibility).

## Filter a list (buttons or select)

Old: filter buttons/select items set `active` on items whose `data-category` matches.

```tsx
const [category, setCategory] = useState("all");
const visible = projects.filter((p) => category === "all" || p.category.toLowerCase() === category);
```

Render `visible.map(...)`; if the CSS shows items via `[&.active]:block`, either keep passing `active` to all rendered items or drop the hiding classes. A custom dropdown (`data-select`) is a boolean `open` state plus the same `category` state.

## Form: enable submit when valid

Old: on `input`, `form.checkValidity()` toggles the button's `disabled`.

```tsx
const [valid, setValid] = useState(false);
<form onInput={(e) => setValid(e.currentTarget.checkValidity())} onSubmit={handleSubmit}>
  <button type="submit" disabled={!valid}>
```

Inputs stay uncontrolled (`defaultValue`) unless the user wants controlled state. Wire submit to a server action or route handler only if the user asks; otherwise leave a clear placeholder handler.

## Carousels, reveal-on-scroll, counters, typed text

- Carousel (Swiper, Slick, Owl): if the project has `embla-carousel-react` or `swiper`, use it; otherwise a small `scroll-snap` row (`flex overflow-x-auto snap-x snap-mandatory` + `snap-start` children) often reproduces simple sliders without JS.
- Reveal on scroll (AOS, WOW, ScrollReveal): with `framer-motion`/`motion` installed use `motion.div initial={{opacity:0,y:20}} whileInView={{opacity:1,y:0}} viewport={{once:true}}`; otherwise an `IntersectionObserver` hook adding a class. Never leave content invisible: the old library's `opacity:0` start state was removed with its attributes.
- Counters / typed text: `useEffect` + `requestAnimationFrame`/`setInterval`, cleaned up on unmount; respect `prefers-reduced-motion`.

## jQuery / Bootstrap / Alpine equivalents

| old | React |
|---|---|
| `$(x).toggleClass("open")` / `addClass` | boolean state + class in `className` |
| `$(x).slideToggle()` / `fadeIn()` | conditional render, or a `grid-rows-[0fr]`→`[1fr]` transition / `motion` |
| `$(window).scroll(fn)` | scroll effect above |
| `$.ajax` / `fetch` on submit | server action or route handler (ask first) |
| Bootstrap `data-bs-toggle="collapse"` | accordion state; `<details>/<summary>` when no animation is needed |
| Bootstrap modal / dropdown / tab | the modal / outside-click / tabs patterns above |
| Alpine `x-data="{open:false}"`, `@click`, `x-show` | `useState`, `onClick`, conditional render |
| smooth-scroll plugin for `#anchors` | `scroll-behavior: smooth` on `html` (global CSS) - no JS |
| back-to-top button | scroll state for visibility + `window.scrollTo({top: 0, behavior: "smooth"})` |
| theme toggle + `localStorage` | `next-themes` if installed; else state + effect syncing a class on `<html>` |
