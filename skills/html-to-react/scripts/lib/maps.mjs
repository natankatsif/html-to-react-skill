// Static lookup tables shared by the pipeline. Pure data, no logic.

// HTML attribute -> React prop. Anything not listed keeps its name, except
// hyphenated SVG presentation attributes, which are camelCased (see jsx.mjs).
export const ATTR_RENAME = {
  class: "className",
  for: "htmlFor",
  tabindex: "tabIndex",
  readonly: "readOnly",
  maxlength: "maxLength",
  minlength: "minLength",
  colspan: "colSpan",
  rowspan: "rowSpan",
  cellpadding: "cellPadding",
  cellspacing: "cellSpacing",
  crossorigin: "crossOrigin",
  autocomplete: "autoComplete",
  autofocus: "autoFocus",
  autoplay: "autoPlay",
  enctype: "encType",
  contenteditable: "contentEditable",
  srcset: "srcSet",
  srcdoc: "srcDoc",
  frameborder: "frameBorder",
  allowfullscreen: "allowFullScreen",
  "accept-charset": "acceptCharset",
  "http-equiv": "httpEquiv",
  novalidate: "noValidate",
  spellcheck: "spellCheck",
  datetime: "dateTime",
  inputmode: "inputMode",
  usemap: "useMap",
  playsinline: "playsInline",
  referrerpolicy: "referrerPolicy",
  fetchpriority: "fetchPriority",
  formaction: "formAction",
  formmethod: "formMethod",
  formnovalidate: "formNoValidate",
  formtarget: "formTarget",
  hreflang: "hrefLang",
  marginheight: "marginHeight",
  marginwidth: "marginWidth",
  accesskey: "accessKey",
  enterkeyhint: "enterKeyHint",
  itemprop: "itemProp",
  itemscope: "itemScope",
  itemtype: "itemType",
  itemid: "itemID",
  itemref: "itemRef",
  nomodule: "noModule",
  charset: "charSet",
  "xlink:href": "href",
  "xml:space": "xmlSpace",
  "xml:lang": "xmlLang",
  "xmlns:xlink": "xmlnsXlink",
};

// Attributes whose mere presence means `true`.
export const BOOLEAN_ATTRS = new Set([
  "allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls", "default", "defer",
  "disabled", "formnovalidate", "hidden", "inert", "ismap", "itemscope", "loop", "multiple", "muted",
  "nomodule", "novalidate", "open", "playsinline", "readonly", "required", "reversed", "selected",
]);

export const NUMERIC_ATTRS = new Set(["tabindex", "colspan", "rowspan", "maxlength", "minlength", "span", "start", "size", "cols", "rows"]);

export const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

// Elements that are inline-level by default. Used to decide whether whitespace
// between siblings is visible (HTML keeps it, JSX drops it across newlines).
export const INLINE_ELEMENTS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "button", "cite", "code", "data", "dfn", "em", "i", "img", "input",
  "kbd", "label", "mark", "q", "s", "samp", "select", "small", "span", "strong", "sub", "sup", "svg", "textarea",
  "time", "u", "var", "wbr", "del", "ins", "picture", "video", "audio", "iframe", "object", "output", "meter",
  "progress", "font", "big", "tt", "strike", "nobr", "ion-icon",
]);

// Attributes that never survive into React output.
export const DROP_ATTRS = new Set([
  "xmlns", "version", "xml:space", "xmlns:xlink", "data-name", "data-aos", "data-aos-delay", "data-aos-duration",
  "data-aos-offset", "data-aos-easing", "data-aos-once", "data-wow-delay", "data-wow-duration", "data-wow-offset",
  "data-sr-id", "data-reactroot", "data-testid",
]);

// Pseudo-classes that become Tailwind variants instead of static matches.
export const STATE_PSEUDOS = {
  hover: "hover",
  focus: "focus",
  "focus-visible": "focus-visible",
  "focus-within": "focus-within",
  active: "active",
  visited: "visited",
  target: "target",
  disabled: "disabled",
  enabled: "enabled",
  checked: "checked",
  indeterminate: "indeterminate",
  required: "required",
  optional: "optional",
  valid: "valid",
  invalid: "invalid",
  "read-only": "read-only",
  "placeholder-shown": "placeholder-shown",
  autofill: "autofill",
  open: "open",
};

export const STRUCTURAL_PSEUDOS = {
  "first-child": "first",
  "last-child": "last",
  "only-child": "only",
  "first-of-type": "first-of-type",
  "last-of-type": "last-of-type",
  "only-of-type": "only-of-type",
  empty: "empty",
};

export const PSEUDO_ELEMENTS = {
  before: "before",
  after: "after",
  placeholder: "placeholder",
  selection: "selection",
  marker: "marker",
  "first-letter": "first-letter",
  "first-line": "first-line",
  "file-selector-button": "file",
  backdrop: "backdrop",
};

// Tailwind breakpoints (identical in v3 and v4 defaults).
export const BREAKPOINTS = [
  ["sm", 640],
  ["md", 768],
  ["lg", 1024],
  ["xl", 1280],
  ["2xl", 1536],
];

// Shorthand -> longhand "slots" it resets. Used by the cascade so a later
// shorthand correctly beats an earlier longhand (and vice versa).
export const SHORTHAND_SLOTS = {
  margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  inset: ["top", "right", "bottom", "left"],
  gap: ["row-gap", "column-gap"],
  overflow: ["overflow-x", "overflow-y"],
  "border-radius": ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"],
  border: [
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
    "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
    "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  ],
  "border-width": ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"],
  "border-style": ["border-top-style", "border-right-style", "border-bottom-style", "border-left-style"],
  "border-color": ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"],
  "border-top": ["border-top-width", "border-top-style", "border-top-color"],
  "border-right": ["border-right-width", "border-right-style", "border-right-color"],
  "border-bottom": ["border-bottom-width", "border-bottom-style", "border-bottom-color"],
  "border-left": ["border-left-width", "border-left-style", "border-left-color"],
  background: [
    "background-color", "background-image", "background-position", "background-size", "background-repeat",
    "background-attachment", "background-origin", "background-clip",
  ],
  font: ["font-style", "font-variant", "font-weight", "font-stretch", "font-size", "line-height", "font-family"],
  flex: ["flex-grow", "flex-shrink", "flex-basis"],
  "flex-flow": ["flex-direction", "flex-wrap"],
  transition: ["transition-property", "transition-duration", "transition-timing-function", "transition-delay"],
  animation: [
    "animation-name", "animation-duration", "animation-timing-function", "animation-delay",
    "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state",
  ],
  outline: ["outline-width", "outline-style", "outline-color"],
  "list-style": ["list-style-type", "list-style-position", "list-style-image"],
  "text-decoration": ["text-decoration-line", "text-decoration-style", "text-decoration-color", "text-decoration-thickness"],
  "place-items": ["align-items", "justify-items"],
  "place-content": ["align-content", "justify-content"],
  "place-self": ["align-self", "justify-self"],
  "grid-area": ["grid-row-start", "grid-column-start", "grid-row-end", "grid-column-end"],
  "grid-row": ["grid-row-start", "grid-row-end"],
  "grid-column": ["grid-column-start", "grid-column-end"],
  "grid-template": ["grid-template-rows", "grid-template-columns", "grid-template-areas"],
  columns: ["column-width", "column-count"],
  // logical properties, assuming a left-to-right page
  "margin-block": ["margin-top", "margin-bottom"],
  "margin-inline": ["margin-left", "margin-right"],
  "margin-inline-start": ["margin-left"],
  "margin-inline-end": ["margin-right"],
  "padding-block": ["padding-top", "padding-bottom"],
  "padding-inline": ["padding-left", "padding-right"],
  "padding-inline-start": ["padding-left"],
  "padding-inline-end": ["padding-right"],
  "inset-inline": ["left", "right"],
  "inset-block": ["top", "bottom"],
};

// Tailwind v1-v3 class -> v4 class. Applied when the source page used an older
// Tailwind (or when css-to-tailwindcss, which speaks v3, produced the class)
// and the target project runs v4.
export const TW4_RENAMES = {
  "shadow-sm": "shadow-xs",
  shadow: "shadow-sm",
  "drop-shadow-sm": "drop-shadow-xs",
  "drop-shadow": "drop-shadow-sm",
  "blur-sm": "blur-xs",
  blur: "blur-sm",
  "backdrop-blur-sm": "backdrop-blur-xs",
  "backdrop-blur": "backdrop-blur-sm",
  "rounded-sm": "rounded-xs",
  rounded: "rounded-sm",
  "outline-none": "outline-hidden",
  ring: "ring-3",
  "flex-grow": "grow",
  "flex-grow-0": "grow-0",
  "flex-shrink": "shrink",
  "flex-shrink-0": "shrink-0",
  "overflow-ellipsis": "text-ellipsis",
  "decoration-slice": "box-decoration-slice",
  "decoration-clone": "box-decoration-clone",
  "whitespace-no-wrap": "whitespace-nowrap",
  "flex-no-wrap": "flex-nowrap",
  "list-reset": "list-none p-0",
  "focus:shadow-outline": "focus:ring-3 focus:ring-blue-500/50",
  "shadow-outline": "ring-3 ring-blue-500/50",
};
for (const side of ["t", "r", "b", "l", "tl", "tr", "br", "bl", "s", "e", "ss", "se", "es", "ee"]) {
  TW4_RENAMES[`rounded-${side}-sm`] = `rounded-${side}-xs`;
  TW4_RENAMES[`rounded-${side}`] = `rounded-${side}-sm`;
}

// Classes that were required by old Tailwind versions and are no-ops since v3.
export const TW_NOOP_CLASSES = new Set(["transform", "filter", "backdrop-filter"]);

// Browser (UA) defaults that Tailwind's Preflight removes. A page written in
// plain CSS silently relies on them (bold headings, list bullets, inline
// images, line-height: normal), so when it is moved into a Tailwind project
// they are re-added at the lowest cascade priority: any author rule wins.
const H = (size, margin) => [["font-size", size], ["font-weight", "bold"], ["margin-block", `${margin}em`]];
export const UA_DEFAULTS = {
  h1: H("2em", 0.67),
  h2: H("1.5em", 0.83),
  h3: H("1.17em", 1),
  h4: H("1em", 1.33),
  h5: H("0.83em", 1.67),
  h6: H("0.67em", 2.33),
  p: [["margin-block", "1em"]],
  dl: [["margin-block", "1em"]],
  blockquote: [["margin-block", "1em"], ["margin-inline", "40px"]],
  figure: [["margin-block", "1em"], ["margin-inline", "40px"]],
  ul: [["margin-block", "1em"], ["padding-inline-start", "40px"], ["list-style-type", "disc"]],
  ol: [["margin-block", "1em"], ["padding-inline-start", "40px"], ["list-style-type", "decimal"]],
  menu: [["margin-block", "1em"], ["padding-inline-start", "40px"], ["list-style-type", "disc"]],
  dd: [["margin-inline-start", "40px"]],
  img: [["display", "inline"], ["vertical-align", "baseline"], ["max-width", "none"]],
  video: [["display", "inline"], ["vertical-align", "baseline"], ["max-width", "none"]],
  svg: [["display", "inline"], ["vertical-align", "baseline"]],
  canvas: [["display", "inline"], ["vertical-align", "baseline"]],
  iframe: [["display", "inline"], ["vertical-align", "baseline"]],
  a: [["color", "LinkText"], ["text-decoration-line", "underline"]],
  table: [["border-collapse", "separate"], ["border-spacing", "2px"]],
  // plain generic `monospace` triggers the browser's 13px monospace sizing by itself
  pre: [["font-family", "monospace"], ["margin-block", "1em"]],
  code: [["font-family", "monospace"]],
  kbd: [["font-family", "monospace"]],
  samp: [["font-family", "monospace"]],
  body: [["line-height", "normal"], ["margin", "8px"]],
};
// Inheritable properties an `html {}` rule passes down; copied onto the page
// root because the host app owns <html>.
export const INHERITED_FROM_HTML = new Set(["font-family", "color", "line-height", "letter-spacing", "font-weight", "font-style", "text-rendering", "-webkit-font-smoothing", "-moz-osx-font-smoothing", "font-feature-settings", "word-spacing", "text-transform"]);
