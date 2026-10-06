// Fiverr Dark Mode
//
// Works on Fiverr's stylesheets rather than on individual elements: for every stylesheet on
// the page it builds a companion sheet with the same selectors and dark colors, and inserts
// it right after the original so the cascade order stays the same. Hover, focus and pressed
// states and ::before/::after then work natively, and nothing has to run while you move the
// mouse or scroll. Converted sheets are cached, so repeat visits are dark from the first frame.
//
// Fiverr defines most colors as CSS variables that are used both as backgrounds and as text,
// so every color variable gets dark variants per use (--fdm-bg--x, --fdm-fg--x, ...) and each
// var() is pointed at the variant that fits the property it's used in.

(() => {
  const ROOT = document.documentElement;
  if (!ROOT || ROOT.hasAttribute("data-fdm")) return;
  ROOT.setAttribute("data-fdm", "");

  // Bump the version whenever the color conversion changes, so old cached output is dropped.
  const CACHE_PREFIX = "fdm-css-v1:";
  const CACHE_MAX_ENTRIES = 80;
  // The page stays hidden until its stylesheets are converted, but never longer than this.
  const REVEAL_TIMEOUT_MS = 2500;

  let enabled = true;
  let revealed = false;
  let pending = 0; // stylesheets still being fetched or converted

  const overrides = new Map(); // site <link>/<style> -> our generated <style>
  const ownerOf = new WeakMap(); // our generated <style> -> site <link>/<style>
  const linkHrefs = new WeakMap(); // <link> -> href its override was built for
  const styleSigs = new WeakMap(); // <style> -> { len, text } its override was built for
  const seenStyles = new Set(); // <style> elements to re-check for rules added through CSSOM
  const inlineState = new WeakMap(); // element -> { sig, props } of its converted inline colors

  ROOT.classList.add("fdm-on", "fdm-loading");

  // ---------- colors ----------

  const NOT_COLORS = new Set(["currentcolor", "inherit", "initial", "unset", "revert", "revert-layer", "none", "auto"]);
  const canvas = document.createElement("canvas").getContext("2d");
  const parsedColors = new Map();

  // Any CSS color -> { r, g, b, a } with channels in 0..1, or null if it isn't a color.
  function parseColor(str) {
    const key = str.toLowerCase();
    let c = parsedColors.get(key);
    if (c !== undefined) return c;
    c = null;
    if (!NOT_COLORS.has(key)) {
      // An invalid value leaves fillStyle unchanged, so parse from two different starting colors.
      canvas.fillStyle = "#000";
      canvas.fillStyle = str;
      const first = canvas.fillStyle;
      canvas.fillStyle = "#fff";
      canvas.fillStyle = str;
      if (first === canvas.fillStyle) c = fromCanvas(first);
    }
    parsedColors.set(key, c);
    return c;
  }

  function fromCanvas(s) {
    if (s[0] === "#") {
      const n = parseInt(s.slice(1), 16);
      return { r: (n >> 16) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
    }
    if (!s.startsWith("rgb")) return null;
    const p = s.slice(s.indexOf("(") + 1, -1).split(",").map(parseFloat);
    return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
  }

  function toHsl({ r, g, b, a }) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h, s, l, a };
  }

  function hslString(h, s, l, a) {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    let r = l;
    let g = l;
    let b = l;
    if (s > 0) {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    const c = (v) => Math.round(v * 255);
    return a < 1 ? `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${a})` : `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
  }

  // WCAG relative luminance, used to tell readable colored text from too-dark text.
  function luminance({ r, g, b }) {
    const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  // Each mapper returns the dark-mode color, or null when the color can stay as it is.

  // Light backgrounds become dark surfaces (white -> #171717); dark and brand colors stay.
  // Faint black tints (hover highlights on white rows) become equally faint white tints.
  function darkBg(c) {
    const { h, s, l, a } = toHsl(c);
    if (a < 0.02) return null;
    if (l < 0.2 && s < 0.2 && a <= 0.15) return `rgba(255, 255, 255, ${a})`;
    if (l < 0.45 || (s > 0.35 && l < 0.8)) return null;
    return hslString(h, Math.min(s, 0.3), Math.min(0.09 + (1 - l) * 0.5, 0.3), a);
  }

  // Dark text becomes light; colored text (green links etc.) only when it's too dark to read.
  function lightFg(c) {
    const { h, s, l, a } = toHsl(c);
    if (a < 0.02) return null;
    if (s > 0.35) return luminance(c) < 0.2 ? hslString(h, Math.min(s, 0.9), Math.max(0.7, 1 - l * 0.5), a) : null;
    return l < 0.5 ? hslString(h, Math.min(s, 0.12), 0.93 - l * 0.65, a) : null;
  }

  // Light grey borders become dark grey; near-black ones (outline buttons, focused inputs) light.
  function darkBorder(c) {
    const { h, s, l, a } = toHsl(c);
    if (a < 0.02 || s > 0.35) return null;
    if (l > 0.6) return hslString(h, s, 0.12 + (1 - l) * 0.5, a);
    if (l < 0.3) return hslString(h, s, 0.85 - l, a);
    return null;
  }

  // Shadows keep their dark colors; light ones (often used as 1px borders) are darkened.
  function darkShadow(c) {
    const { s, l } = toHsl(c);
    return l > 0.6 && s <= 0.35 ? darkBorder(c) : null;
  }

  const MAPPERS = { bg: darkBg, fg: lightFg, bd: darkBorder, sh: darkShadow };
  const KINDS = Object.keys(MAPPERS);

  // ---------- CSS values ----------

  // Which mapper each property uses. Shorthands are only used when their longhands come
  // back empty, which happens when the shorthand contains var().
  const KIND = {
    color: "fg",
    fill: "fg",
    stroke: "fg",
    "caret-color": "fg",
    "text-decoration-color": "fg",
    "text-decoration": "fg",
    "text-emphasis-color": "fg",
    "-webkit-text-fill-color": "fg",
    "-webkit-text-stroke-color": "fg",
    "background-color": "bg",
    "background-image": "bg",
    background: "bg",
    "box-shadow": "sh",
    "outline-color": "bd",
    outline: "bd",
    "column-rule-color": "bd",
    border: "bd",
    "border-color": "bd",
  };
  const SHORTHANDS = {
    "background-color": ["background"],
    "background-image": ["background"],
    "outline-color": ["outline"],
    "text-decoration-color": ["text-decoration"],
  };
  for (const side of ["top", "right", "bottom", "left"]) {
    KIND[`border-${side}-color`] = "bd";
    KIND[`border-${side}`] = "bd";
    SHORTHANDS[`border-${side}-color`] = [`border-${side}`, "border-color", "border"];
  }
  for (const side of ["block-start", "block-end", "inline-start", "inline-end"]) KIND[`border-${side}-color`] = "bd";

  const COLOR_TOKEN = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|\b[a-z]+\b/gi;
  const COLORISH = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(|var\(|gradient\(/i;
  const mappedValues = new Map();

  // Rewrites a CSS value for one kind of use ("bg", "fg", "bd", "sh"): converts its colors,
  // points var(--x) at the matching dark variant, and makes relative url()s absolute so the
  // value still works when it's moved into our own <style>.
  function mapValue(value, kind, base) {
    const key = kind + "|" + (value.includes("url(") ? base + "|" : "") + value;
    let out = mappedValues.get(key);
    if (out === undefined) {
      out = rewrite(value, kind, base);
      mappedValues.set(key, out);
    }
    return out;
  }

  function rewrite(value, kind, base) {
    let out = "";
    let plain = 0;
    for (let i = 0; i < value.length; i++) {
      const fn = value.slice(i, i + 4).toLowerCase();
      if ((fn !== "var(" && fn !== "url(") || /[\w-]/.test(value[i - 1] || "")) continue;
      out += mapColors(value.slice(plain, i), kind);
      const end = closingParen(value, i + 3);
      const inner = value.slice(i + 4, end);
      out += fn === "var(" ? mapVar(inner, kind, base) : mapUrl(inner, base);
      i = end;
      plain = end + 1;
    }
    return out + mapColors(value.slice(plain), kind);
  }

  function mapColors(text, kind) {
    if (!text) return text;
    return text.replace(COLOR_TOKEN, (token) => {
      const c = parseColor(token);
      return (c && MAPPERS[kind](c)) || token;
    });
  }

  function mapVar(inner, kind, base) {
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    if (!name.startsWith("--") || name.startsWith("--fdm-")) return `var(${inner})`;
    const fallback = comma < 0 ? "" : "," + mapValue(inner.slice(comma + 1), kind, base);
    // If the variable isn't a color there's no dark variant, and the original is used.
    return `var(--fdm-${kind}${name}, var(${name}${fallback}))`;
  }

  function mapUrl(inner, base) {
    const raw = inner.trim().replace(/^(['"])(.*)\1$/s, "$2");
    if (/^(?:[a-z][\w+.-]*:|#)/i.test(raw)) return `url(${inner})`;
    try {
      return `url("${new URL(raw, base).href}")`;
    } catch {
      return `url(${inner})`;
    }
  }

  function closingParen(s, open) {
    let depth = 0;
    let quote = "";
    for (let i = open; i < s.length; i++) {
      const ch = s[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return i;
    }
    return s.length - 1;
  }

  function topLevelComma(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      else if (s[i] === "," && depth === 0) return i;
    }
    return -1;
  }

  // A color variable -> [name, value] pairs for its dark variants, or [] if it isn't a color.
  function mapCustomProperty(name, value, base) {
    if (name.startsWith("--fdm-")) return [];
    const v = value.trim();
    if (!v) return [];
    const single = parseColor(v);
    if (!single && !COLORISH.test(v)) return [];
    // Variants are written even when unchanged, so they override variants inherited from an
    // outer definition of the same variable.
    return KINDS.map((kind) => [`--fdm-${kind}${name}`, single ? MAPPERS[kind](single) || v : mapValue(v, kind, base)]);
  }

  // ---------- stylesheets -> dark companion sheets ----------

  // Keeps only the color declarations of a rule, converted. Unchanged ones are kept too,
  // otherwise an earlier converted rule could win over a later one it used to lose to.
  function mapDeclarations(style, base) {
    let out = "";
    const done = new Set();
    for (let i = 0; i < style.length; i++) {
      const name = style[i];
      const important = style.getPropertyPriority(name) ? " !important" : "";
      if (name.startsWith("--")) {
        for (const [prop, value] of mapCustomProperty(name, style.getPropertyValue(name), base)) {
          out += `${prop}:${value}${important};`;
        }
        continue;
      }
      if (!KIND[name]) continue;
      let prop = name;
      let value = style.getPropertyValue(name);
      if (!value) {
        prop = (SHORTHANDS[name] || []).find((s) => style.getPropertyValue(s));
        if (!prop || done.has(prop)) continue;
        value = style.getPropertyValue(prop);
      }
      done.add(prop);
      out += `${prop}:${mapValue(value, KIND[prop], base)}${important};`;
    }
    return out;
  }

  function mapRules(rules, base) {
    let out = "";
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        const body = mapDeclarations(rule.style, base) + (rule.cssRules?.length ? mapRules(rule.cssRules, base) : "");
        if (body) out += `${rule.selectorText}{${body}}`;
      } else if (rule instanceof CSSKeyframesRule) {
        out += mapKeyframes(rule, base);
      } else if (rule instanceof CSSGroupingRule) {
        const body = mapRules(rule.cssRules, base);
        if (body) out += `${groupHeader(rule)}{${body}}`;
      } else if (rule.constructor.name === "CSSNestedDeclarations") {
        out += mapDeclarations(rule.style, base);
      }
    }
    return out;
  }

  function groupHeader(rule) {
    if (rule instanceof CSSMediaRule) return `@media ${rule.media.mediaText}`;
    if (rule instanceof CSSSupportsRule) return `@supports ${rule.conditionText}`;
    if (self.CSSLayerBlockRule && rule instanceof CSSLayerBlockRule) return `@layer ${rule.name}`;
    const text = rule.cssText;
    return text.slice(0, text.indexOf("{"));
  }

  // Keyframes are replaced as a whole (the last definition of a name wins), so every
  // declaration is copied, with the colors converted.
  function mapKeyframes(rule, base) {
    let body = "";
    let hasColor = false;
    for (const frame of rule.cssRules) {
      let decls = "";
      for (let i = 0; i < frame.style.length; i++) {
        const name = frame.style[i];
        const value = frame.style.getPropertyValue(name);
        if (!value) return ""; // a var() shorthand we can't copy safely; leave the animation alone
        if (KIND[name]) hasColor = true;
        decls += `${name}:${KIND[name] ? mapValue(value, KIND[name], base) : value};`;
      }
      body += `${frame.keyText}{${decls}}`;
    }
    return hasColor ? `@keyframes ${CSS.escape(rule.name)}{${body}}` : "";
  }

  function convertRules(rules, base) {
    try {
      return mapRules(rules, base);
    } catch (e) {
      console.warn("[Fiverr Dark Mode] could not convert a stylesheet", e);
      return "";
    }
  }

  function convertText(text, href) {
    const sheet = new CSSStyleSheet({ baseURL: href });
    try {
      sheet.replaceSync(text);
    } catch {
      return "";
    }
    return convertRules(sheet.cssRules, href);
  }

  function attachOverride(owner, css) {
    let style = overrides.get(owner);
    if (!css) {
      if (style) {
        overrides.delete(owner);
        style.remove();
      }
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.setAttribute("data-fdm-for", "");
      overrides.set(owner, style);
      ownerOf.set(style, owner);
    }
    if (style.textContent !== css) style.textContent = css;
    syncPlacement(owner, style);
  }

  function syncPlacement(owner, style) {
    if (owner.media) style.media = owner.media;
    else style.removeAttribute("media");
    if (owner.nextSibling !== style) owner.after(style);
    if (style.sheet) style.sheet.disabled = !enabled;
  }

  async function handleLink(link) {
    const rel = link.rel.toLowerCase();
    const href = link.href;
    if (!/\bstylesheet\b/.test(rel) || /\balternate\b/.test(rel) || !/^https?:/.test(href)) {
      linkHrefs.delete(link);
      attachOverride(link, "");
      return;
    }
    if (linkHrefs.get(link) === href) {
      const style = overrides.get(link);
      if (style) syncPlacement(link, style);
      return;
    }
    linkHrefs.set(link, href);
    pending++;
    try {
      let css = await cacheGet(href);
      if (css == null) {
        const text = await fetchText(href);
        if (text == null) return; // e.g. a third-party sheet we're not allowed to read
        css = convertText(text, href);
        cacheSet(href, css);
      }
      if (link.isConnected && linkHrefs.get(link) === href) attachOverride(link, css);
    } finally {
      pending--;
      maybeReveal();
    }
  }

  async function fetchText(href) {
    try {
      const res = await fetch(href, { credentials: "omit" });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  function handleStyle(style) {
    if (style.hasAttribute("data-fdm-for")) return;
    let rules;
    try {
      rules = style.sheet?.cssRules;
    } catch {
      return;
    }
    if (!rules) return;
    const text = style.textContent;
    const prev = styleSigs.get(style);
    if (prev && prev.len === rules.length && prev.text === text) {
      const own = overrides.get(style);
      if (own) syncPlacement(style, own);
      return;
    }
    styleSigs.set(style, { len: rules.length, text });
    attachOverride(style, convertRules(rules, document.baseURI));
  }

  // CSS-in-JS libraries can add rules through insertRule(), which doesn't touch the DOM.
  function recheckStyles() {
    for (const style of seenStyles) {
      if (!style.isConnected) {
        seenStyles.delete(style);
        continue;
      }
      let len;
      try {
        len = style.sheet?.cssRules.length;
      } catch {
        continue;
      }
      if (len !== undefined && len !== styleSigs.get(style)?.len) handleStyle(style);
    }
  }

  // ---------- inline styles and SVG color attributes ----------

  // [property, mapper kind, token]; dark.css applies var(--fdm-<token>) for each token
  // listed in the element's data-fdm-i attribute.
  const INLINE = [
    ["background-color", "bg", "ibg"],
    ["background-image", "bg", "iimg"],
    ["color", "fg", "ifg"],
    ["border-top-color", "bd", "ibt"],
    ["border-right-color", "bd", "ibr"],
    ["border-bottom-color", "bd", "ibb"],
    ["border-left-color", "bd", "ibl"],
    ["fill", "fg", "ifill"],
    ["stroke", "fg", "istroke"],
    ["box-shadow", "sh", "ish"],
  ];
  const INLINE_PROPS = new Set(INLINE.map(([prop]) => prop));

  function processElement(el) {
    const style = el.style;
    if (!style) return;

    // Our own writes are --fdm-* properties, which are left out of the signature,
    // so the mutations they cause end here.
    let sig = "";
    const customProps = [];
    for (let i = 0; i < style.length; i++) {
      const name = style[i];
      if (name.startsWith("--fdm-")) continue;
      if (name.startsWith("--")) customProps.push(name);
      else if (!INLINE_PROPS.has(name)) continue;
      sig += `${name}:${style.getPropertyValue(name)};`;
    }
    const fill = el.getAttribute("fill");
    const stroke = el.getAttribute("stroke");
    if (fill) sig += `@fill:${fill};`;
    if (stroke) sig += `@stroke:${stroke};`;

    const prev = inlineState.get(el);
    if ((prev ? prev.sig : "") === sig) return;

    if (prev) for (const prop of prev.props) style.removeProperty(prop);
    const props = [];
    const tokens = [];
    const base = document.baseURI;
    const set = (prop, value) => {
      style.setProperty(prop, value);
      props.push(prop);
    };

    for (const [prop, kind, token] of INLINE) {
      const value = style.getPropertyValue(prop);
      if (!value) continue;
      const mapped = mapValue(value, kind, base);
      if (mapped === value) continue;
      set(`--fdm-${token}`, mapped);
      tokens.push(token);
    }
    for (const name of customProps) {
      for (const [prop, value] of mapCustomProperty(name, style.getPropertyValue(name), base)) set(prop, value);
    }
    for (const [value, token] of [[fill, "afill"], [stroke, "astroke"]]) {
      if (!value) continue;
      const mapped = mapValue(value, "fg", base);
      if (mapped === value) continue;
      set(`--fdm-${token}`, mapped);
      tokens.push(token);
    }

    if (tokens.length) el.setAttribute("data-fdm-i", tokens.join(" "));
    else el.removeAttribute("data-fdm-i");
    inlineState.set(el, { sig, props });
  }

  // ---------- watching the page ----------

  const WATCHED = "link, style, [style], [fill], [stroke]";

  function visit(el) {
    const tag = el.localName;
    if (tag === "link") handleLink(el);
    else if (tag === "style") {
      if (el.hasAttribute("data-fdm-for")) return;
      seenStyles.add(el);
      handleStyle(el);
    } else if (el.hasAttribute("style") || el.hasAttribute("fill") || el.hasAttribute("stroke")) {
      processElement(el);
    }
  }

  function scan(node) {
    if (node.nodeType !== 1) return;
    visit(node);
    if (node.firstElementChild) for (const el of node.querySelectorAll(WATCHED)) visit(el);
  }

  function unscan(node) {
    if (node.nodeType !== 1 || node.isConnected) return;
    // Our own sheet was removed by the page: put it back.
    const owner = ownerOf.get(node);
    if (owner) {
      if (owner.isConnected && overrides.get(owner) === node) syncPlacement(owner, node);
      return;
    }
    const owners = node.localName === "link" || node.localName === "style" ? [node] : node.firstElementChild ? node.querySelectorAll("link, style") : [];
    for (const el of owners) {
      linkHrefs.delete(el);
      styleSigs.delete(el);
      seenStyles.delete(el);
      attachOverride(el, "");
    }
  }

  function onMutations(records) {
    for (const r of records) {
      if (r.type === "childList") {
        for (const n of r.removedNodes) unscan(n);
        for (const n of r.addedNodes) scan(n);
        if (r.target.localName === "style") handleStyle(r.target);
      } else if (r.type === "characterData") {
        const parent = r.target.parentNode;
        if (parent && parent.localName === "style") handleStyle(parent);
      } else if (r.attributeName === "style" || r.attributeName === "fill" || r.attributeName === "stroke") {
        processElement(r.target);
      } else if (r.target.localName === "link") {
        handleLink(r.target);
      } else if (r.target.localName === "style") {
        handleStyle(r.target);
      }
    }
    recheckStyles();
    maybeReveal();
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    ROOT.classList.remove("fdm-loading");
  }

  function maybeReveal() {
    if (!revealed && pending === 0 && document.body) reveal();
  }

  function setEnabled(on) {
    enabled = on;
    ROOT.classList.toggle("fdm-on", on);
    if (!on) reveal();
    for (const style of overrides.values()) if (style.sheet) style.sheet.disabled = !on;
  }

  // ---------- cache ----------

  function cacheGet(href) {
    const key = CACHE_PREFIX + href;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (items) => resolve(chrome.runtime.lastError ? null : (items?.[key]?.css ?? null)));
      } catch {
        resolve(null); // extension was reloaded; this page's script is orphaned
      }
    });
  }

  function cacheSet(href, css) {
    try {
      chrome.storage.local.get(null, (items) => {
        if (chrome.runtime.lastError) return;
        const keys = Object.keys(items).filter((k) => k.startsWith("fdm-css-"));
        const outdated = keys.filter((k) => !k.startsWith(CACHE_PREFIX));
        const current = keys.filter((k) => k.startsWith(CACHE_PREFIX)).sort((a, b) => items[a].t - items[b].t);
        const drop = outdated.concat(current.slice(0, Math.max(0, current.length - CACHE_MAX_ENTRIES + 1)));
        if (drop.length) chrome.storage.local.remove(drop);
        chrome.storage.local.set({ [CACHE_PREFIX + href]: { css, t: Date.now() } }, () => void chrome.runtime.lastError);
      });
    } catch {
      // extension was reloaded; nothing to cache into
    }
  }

  // ---------- start ----------

  new MutationObserver(onMutations).observe(ROOT, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style", "fill", "stroke", "rel", "href", "media"],
  });
  // Some pages rewrite <html>'s class list; keep ours on it.
  new MutationObserver(() => {
    if (enabled && !ROOT.classList.contains("fdm-on")) ROOT.classList.add("fdm-on");
    if (!revealed && !ROOT.classList.contains("fdm-loading")) ROOT.classList.add("fdm-loading");
  }).observe(ROOT, { attributes: true, attributeFilter: ["class"] });

  scan(ROOT);
  document.addEventListener("DOMContentLoaded", maybeReveal);
  setTimeout(reveal, REVEAL_TIMEOUT_MS);

  try {
    chrome.storage.sync.get({ enabled: true }, ({ enabled: on }) => {
      if (!on) setEnabled(false);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.enabled) setEnabled(changes.enabled.newValue !== false);
    });
  } catch {
    // extension was reloaded; keep the defaults
  }
})();
