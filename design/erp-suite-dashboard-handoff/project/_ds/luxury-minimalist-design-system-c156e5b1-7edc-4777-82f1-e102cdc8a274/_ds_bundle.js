/* @ds-bundle: {"format":3,"namespace":"KALMRDesignSystem_c156e5","components":[{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"Separator","sourcePath":"components/core/Separator.jsx"},{"name":"FloatingInput","sourcePath":"components/forms/FloatingInput.jsx"},{"name":"Footer","sourcePath":"components/navigation/Footer.jsx"},{"name":"Header","sourcePath":"components/navigation/Header.jsx"}],"sourceHashes":{"components/core/Badge.jsx":"53d8589cb6ec","components/core/Button.jsx":"356f754dbe82","components/core/Card.jsx":"8c2d29a507d4","components/core/Separator.jsx":"27112ca70335","components/forms/FloatingInput.jsx":"a2f4d220639a","components/navigation/Footer.jsx":"53e4a5135079","components/navigation/Header.jsx":"e81ea7c9bd97","ui_kits/maison/AccessScreen.jsx":"7f0c7ec4a52f","ui_kits/maison/ProductDetail.jsx":"17fa9a9b25fb","ui_kits/maison/Storefront.jsx":"bb13bb4a9faa","ui_kits/maison/data.jsx":"fea7734b2518"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.KALMRDesignSystem_c156e5 = window.KALMRDesignSystem_c156e5 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Badge / Tag — caption-scale label with wide tracking.
 * Variants: "outline" (hairline), "accent" (accent text/border), "solid".
 */
function Badge({
  children,
  variant = "outline",
  // "outline" | "accent" | "solid"
  className = "",
  ...rest
}) {
  const classes = ["luxury-badge", variant === "accent" ? "luxury-badge--accent" : "", variant === "solid" ? "luxury-badge--solid" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("span", _extends({
    className: classes
  }, rest), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Button — primary action primitive.
 * Two state systems: "ghost" (transparent → solid fill on hover) and
 * "solid" (filled → fades to 50–60% on hover). Sizes md (40px) / sm (35px).
 */
function Button({
  children,
  variant = "ghost",
  // "ghost" | "solid"
  size = "md",
  // "md" | "sm"
  accent = "primary",
  // "primary" | "secondary"
  iconLeft,
  iconRight,
  disabled = false,
  as = "button",
  className = "",
  ...rest
}) {
  const Tag = as;
  const classes = ["luxury-btn", `luxury-btn--${size}`, `luxury-btn--${variant}`, accent === "secondary" ? "luxury-btn--secondary" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement(Tag, _extends({
    className: classes,
    disabled: Tag === "button" ? disabled : undefined,
    "aria-disabled": disabled || undefined
  }, rest), iconLeft, children, iconRight);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Card — content container with locked editorial rhythm.
 * Title (H3 Cormorant) → 15px → description (Body Normal) → 30px → small button.
 * 30px symmetrical inset, paper surface, hairline edge.
 */
function Card({
  title,
  children,
  action,
  // string label → renders a small ghost Button
  onAction,
  actionNode,
  // OR pass a fully custom node
  surface = "light",
  // "light" (bordered) | "accent" | "secondary" | "dark" (filled, no border)
  className = "",
  ...rest
}) {
  const surfaceClass = surface && surface !== "light" ? `luxury-card--${surface}` : "";
  return /*#__PURE__*/React.createElement("article", _extends({
    className: ["luxury-card", surfaceClass, className].filter(Boolean).join(" ")
  }, rest), title && /*#__PURE__*/React.createElement("h3", {
    className: "luxury-card__title"
  }, title), children && /*#__PURE__*/React.createElement("div", {
    className: "luxury-card__body"
  }, children), (action || actionNode) && /*#__PURE__*/React.createElement("div", {
    className: "luxury-card__actions"
  }, actionNode || /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "ghost",
    size: "sm",
    onClick: onAction
  }, action)));
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/Separator.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Separator — 0.5px hairline rule, horizontal or vertical. */
function Separator({
  orientation = "horizontal",
  className = "",
  style,
  ...rest
}) {
  const dir = orientation === "vertical" ? "v" : "h";
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "separator",
    "aria-orientation": orientation,
    className: ["luxury-separator", `luxury-separator--${dir}`, className].filter(Boolean).join(" "),
    style: style
  }, rest));
}
Object.assign(__ds_scope, { Separator });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Separator.jsx", error: String((e && e.message) || e) }); }

// components/forms/FloatingInput.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  useId
} = React;
/**
 * FloatingInput — borderless minimalist field with a 0.5px underline and a
 * label that floats up + scales to Body Small on focus / fill.
 * Error text is empathetic (Caption, accent @ 60% opacity), never alarmist.
 */
function FloatingInput({
  label,
  type = "text",
  value,
  defaultValue,
  onChange,
  error,
  // string → renders empathetic error line
  id,
  className = "",
  ...rest
}) {
  const autoId = useId();
  const fieldId = id || autoId;
  return /*#__PURE__*/React.createElement("div", {
    className: ["luxury-field", error ? "luxury-field--error" : "", className].filter(Boolean).join(" ")
  }, /*#__PURE__*/React.createElement("input", _extends({
    id: fieldId,
    type: type,
    className: "luxury-field__input",
    placeholder: " " /* keeps :placeholder-shown logic intact */,
    value: value,
    defaultValue: defaultValue,
    onChange: onChange,
    "aria-invalid": !!error,
    "aria-describedby": error ? `${fieldId}-error` : undefined
  }, rest)), /*#__PURE__*/React.createElement("label", {
    htmlFor: fieldId,
    className: "luxury-field__label"
  }, label), error && /*#__PURE__*/React.createElement("span", {
    id: `${fieldId}-error`,
    className: "luxury-field__error"
  }, error));
}
Object.assign(__ds_scope, { FloatingInput });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/FloatingInput.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Footer.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Footer — editorial multi-column footer.
 * Column 1: brand (35px) + description/contact text.
 * Columns 2–N: titled link groups. Type ceiling is Body Normal (16px).
 * Base bar: copyright (Caption, left) + social icons (right), split by a hairline.
 */
function Footer({
  brand = "Logo",
  logoSrc,
  address = [],
  // array of strings or { label, href }
  social = [],
  // [{ label, href, icon }]  icon = node (20×20)
  columns = [],
  // [{ title, links: [{ label, href }] }]
  copyright,
  // string; if omitted, built from brand + roman year
  className = "",
  ...rest
}) {
  const year = new Date().getFullYear();
  const copy = copyright || `© ${year} ${brand}. All rights reserved.`;
  return /*#__PURE__*/React.createElement("footer", _extends({
    className: ["luxury-footer", className].filter(Boolean).join(" ")
  }, rest), /*#__PURE__*/React.createElement("div", {
    className: "luxury-footer__inner"
  }, /*#__PURE__*/React.createElement("div", {
    className: "luxury-footer__brand-col"
  }, logoSrc ? /*#__PURE__*/React.createElement("img", {
    className: "luxury-footer__logo-img",
    src: logoSrc,
    alt: brand
  }) : /*#__PURE__*/React.createElement("span", {
    className: "luxury-footer__logo"
  }, brand), address.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "luxury-footer__address"
  }, address.map((row, i) => {
    const item = typeof row === "string" ? {
      label: row
    } : row;
    if (item.meta) return /*#__PURE__*/React.createElement("p", {
      key: i,
      className: "luxury-footer__meta"
    }, item.label);
    return item.href ? /*#__PURE__*/React.createElement("a", {
      key: i,
      href: item.href
    }, item.label) : /*#__PURE__*/React.createElement("span", {
      key: i
    }, item.label);
  }))), columns.map((col, i) => /*#__PURE__*/React.createElement("nav", {
    key: i,
    className: "luxury-footer__col",
    "aria-label": col.title
  }, /*#__PURE__*/React.createElement("span", {
    className: "luxury-footer__col-title"
  }, col.title), /*#__PURE__*/React.createElement("div", {
    className: "luxury-footer__links"
  }, col.links.map((l, j) => /*#__PURE__*/React.createElement("a", {
    key: j,
    className: "luxury-footer__link",
    href: l.href || "#"
  }, l.label)))))), /*#__PURE__*/React.createElement("div", {
    className: "luxury-footer__base"
  }, /*#__PURE__*/React.createElement("span", {
    className: "luxury-footer__copy"
  }, copy), social.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "luxury-footer__social"
  }, social.map((s, i) => /*#__PURE__*/React.createElement("a", {
    key: i,
    className: "luxury-icon-btn",
    href: s.href || "#",
    "aria-label": s.label
  }, /*#__PURE__*/React.createElement("span", {
    className: "luxury-icon"
  }, s.icon))))));
}
Object.assign(__ds_scope, { Footer });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Footer.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Header.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  useEffect,
  useRef,
  useState
} = React;
/**
 * Header — 80px navigation bar. Logo locked to 35px (matches small button),
 * nav items at Body Small with 50–60px rhythm, optional action slot.
 * The smart-scroll engine (sticky + overlay) toggles `.is-scrolled` past 20px.
 * At ≤1024px the horizontal menu collapses into a right-side slide-out drawer
 * with a hamburger trigger, dimming overlay, and a close button pinned to the
 * exact coordinate of the trigger.
 */
function Header({
  brand = "Logo",
  // wordmark text fallback when no logo image
  logoSrc,
  // optional image; falls back to --brand-logo-source
  links = [],
  // [{ label, href, current }]
  actions,
  // node (e.g. a Button)
  sticky = false,
  // stick to top + run the scroll engine
  overlay = false,
  // transparent light-contrast bar over an immersive hero
  className = "",
  ...rest
}) {
  const ref = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!sticky && !overlay) return undefined;
    const onScroll = () => {
      const el = ref.current;
      if (el) el.classList.toggle("is-scrolled", window.scrollY > 20);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, {
      passive: true
    });
    return () => window.removeEventListener("scroll", onScroll);
  }, [sticky, overlay]);

  // Lock body scroll while the drawer is open, and re-sync the header's
  // contrast state to the real scroll position on open/close. body{overflow}
  // toggling can suppress the scroll event, otherwise leaving the header stuck
  // in its transparent overlay state over a light section (it "disappears").
  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    const el = ref.current;
    if (el && (sticky || overlay)) el.classList.toggle("is-scrolled", window.scrollY > 20);
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen, sticky, overlay]);
  const resolvedLogo = logoSrc;
  const classes = ["luxury-header", sticky ? "luxury-header--sticky" : "", overlay ? "luxury-header--overlay" : "", menuOpen ? "is-menu-open" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("header", _extends({
    ref: ref,
    className: classes
  }, rest), /*#__PURE__*/React.createElement("div", {
    className: "luxury-header__inner"
  }, /*#__PURE__*/React.createElement("a", {
    className: "luxury-header__brand",
    href: "#"
  }, resolvedLogo ? /*#__PURE__*/React.createElement("img", {
    className: "luxury-header__logo-img",
    src: resolvedLogo,
    alt: brand
  }) : /*#__PURE__*/React.createElement("span", {
    className: "luxury-header__logo-word"
  }, brand)), /*#__PURE__*/React.createElement("nav", {
    className: "luxury-header__nav",
    "aria-label": "Primary"
  }, links.map((l, i) => /*#__PURE__*/React.createElement("a", {
    key: i,
    className: "luxury-header__link",
    href: l.href || "#",
    "aria-current": l.current ? "page" : undefined
  }, l.label))), actions && /*#__PURE__*/React.createElement("div", {
    className: "luxury-header__actions"
  }, actions), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "luxury-header__burger",
    "aria-label": "Open menu",
    "aria-expanded": menuOpen,
    onClick: () => setMenuOpen(true)
  }, /*#__PURE__*/React.createElement("span", {
    className: "luxury-header__burger-bars",
    "aria-hidden": "true"
  })))), /*#__PURE__*/React.createElement("div", {
    className: ["luxury-nav-overlay", menuOpen ? "is-open" : ""].filter(Boolean).join(" "),
    hidden: !menuOpen,
    onClick: () => setMenuOpen(false)
  }), /*#__PURE__*/React.createElement("aside", {
    className: ["luxury-nav-drawer", menuOpen ? "is-open" : ""].filter(Boolean).join(" "),
    "aria-hidden": !menuOpen
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "luxury-nav-drawer__close",
    "aria-label": "Close menu",
    onClick: () => setMenuOpen(false)
  }, /*#__PURE__*/React.createElement("span", {
    className: "luxury-nav-drawer__close-mark",
    "aria-hidden": "true"
  })), /*#__PURE__*/React.createElement("nav", {
    className: "luxury-nav-drawer__links",
    "aria-label": "Mobile"
  }, links.map((l, i) => /*#__PURE__*/React.createElement("a", {
    key: i,
    className: "luxury-nav-drawer__link",
    href: l.href || "#",
    "aria-current": l.current ? "page" : undefined,
    onClick: () => setMenuOpen(false)
  }, l.label))), actions && /*#__PURE__*/React.createElement("div", {
    className: "luxury-nav-drawer__actions"
  }, actions)));
}
Object.assign(__ds_scope, { Header });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Header.jsx", error: String((e && e.message) || e) }); }

// ui_kits/maison/AccessScreen.jsx
try { (() => {
/* global React */
const {
  useState: useAccessState
} = React;
function AccessScreen({
  onBack
}) {
  const {
    Button,
    FloatingInput
  } = window.KALMRDesignSystem_c156e5;
  const [email, setEmail] = useAccessState("");
  const [name, setName] = useAccessState("");
  const [done, setDone] = useAccessState(false);
  const [err, setErr] = useAccessState("");
  function submit(e) {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setErr("We'll only write to confirm your invitation — a reachable address helps.");
      return;
    }
    setErr("");
    setDone(true);
  }
  return /*#__PURE__*/React.createElement("section", {
    className: "kit-section kit-access"
  }, /*#__PURE__*/React.createElement("button", {
    className: "kit-back",
    onClick: onBack
  }, "\u2190 Return"), /*#__PURE__*/React.createElement("div", {
    className: "kit-access__inner"
  }, /*#__PURE__*/React.createElement("span", {
    className: "type-eyebrow"
  }, "By Invitation"), done ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h1", {
    className: "type-h2"
  }, "Your request is with us"), /*#__PURE__*/React.createElement("p", {
    className: "type-body-md"
  }, "Thank you, ", name || "friend", ". A member of the maison will write to you within two days. There is no need to do anything further."), /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    size: "md",
    onClick: onBack
  }, "Back to the collection")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h1", {
    className: "type-h2"
  }, "Request access to the edition"), /*#__PURE__*/React.createElement("p", {
    className: "type-body-md"
  }, "Acquisitions are made by introduction. Leave your details and we will be in touch quietly."), /*#__PURE__*/React.createElement("form", {
    className: "kit-form",
    onSubmit: submit
  }, /*#__PURE__*/React.createElement(FloatingInput, {
    label: "Full name",
    value: name,
    onChange: e => setName(e.target.value)
  }), /*#__PURE__*/React.createElement(FloatingInput, {
    label: "Email address",
    type: "email",
    value: email,
    onChange: e => setEmail(e.target.value),
    error: err || undefined
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "solid",
    size: "md",
    as: "button",
    type: "submit"
  }, "Submit request")))));
}
window.AccessScreen = AccessScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/maison/AccessScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/maison/ProductDetail.jsx
try { (() => {
/* global React */
function ProductDetail({
  product,
  onBack,
  onRequestAccess
}) {
  const {
    Button,
    Badge,
    Separator
  } = window.KALMRDesignSystem_c156e5;
  const p = product || {
    name: "The Marlowe Coat",
    line: "Outerwear",
    price: "€4,200",
    tag: "Limited"
  };
  return /*#__PURE__*/React.createElement("section", {
    className: "kit-section kit-pdp"
  }, /*#__PURE__*/React.createElement("button", {
    className: "kit-back",
    onClick: onBack
  }, "\u2190 The Collection"), /*#__PURE__*/React.createElement("div", {
    className: "kit-pdp__grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "kit-pdp__plate",
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("div", {
    className: "kit-pdp__info"
  }, /*#__PURE__*/React.createElement("span", {
    className: "type-eyebrow"
  }, p.line), /*#__PURE__*/React.createElement("h1", {
    className: "type-h2"
  }, p.name), /*#__PURE__*/React.createElement("div", {
    className: "kit-pdp__price"
  }, /*#__PURE__*/React.createElement("span", {
    className: "type-body-lg"
  }, p.price), p.tag && /*#__PURE__*/React.createElement(Badge, {
    variant: p.tag === "New" ? "accent" : "outline"
  }, p.tag)), /*#__PURE__*/React.createElement("p", {
    className: "type-body-md"
  }, "Cut from a single bolt of double-faced cashmere and finished by hand over forty hours. One of an edition of fourteen, each numbered and recorded."), /*#__PURE__*/React.createElement(Separator, null), /*#__PURE__*/React.createElement("dl", {
    className: "kit-spec"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("dt", {
    className: "type-caption kit-muted"
  }, "Material"), /*#__PURE__*/React.createElement("dd", {
    className: "type-body-sm"
  }, "100% Mongolian cashmere")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("dt", {
    className: "type-caption kit-muted"
  }, "Origin"), /*#__PURE__*/React.createElement("dd", {
    className: "type-body-sm"
  }, "Atelier, Paris")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("dt", {
    className: "type-caption kit-muted"
  }, "Edition"), /*#__PURE__*/React.createElement("dd", {
    className: "type-body-sm"
  }, "14 pieces"))), /*#__PURE__*/React.createElement("div", {
    className: "kit-pdp__cta"
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "solid",
    size: "md",
    onClick: onRequestAccess
  }, "Reserve \xB7 ", p.price), /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    size: "md",
    onClick: onRequestAccess
  }, "Enquire")))));
}
window.ProductDetail = ProductDetail;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/maison/ProductDetail.jsx", error: String((e && e.message) || e) }); }

// ui_kits/maison/Storefront.jsx
try { (() => {
/* global React */
const {
  useState: useStorefrontState
} = React;
function Storefront({
  onOpenProduct,
  onRequestAccess
}) {
  const {
    Button,
    Card,
    Badge
  } = window.KALMRDesignSystem_c156e5;
  const {
    PRODUCTS
  } = window.DS_KIT;
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("section", {
    className: "kit-hero section-tone--dark"
  }, /*#__PURE__*/React.createElement("div", {
    className: "kit-hero__inner"
  }, /*#__PURE__*/React.createElement("span", {
    className: "type-eyebrow"
  }, "Autumn Collection \xB7 2026"), /*#__PURE__*/React.createElement("h1", {
    className: "type-h1"
  }, "The Weight of Permanence"), /*#__PURE__*/React.createElement("p", {
    className: "type-body-lg"
  }, "Fourteen pieces, made once and never repeated. Reserve yours before the atelier closes the edition."), /*#__PURE__*/React.createElement("div", {
    className: "kit-hero__cta"
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "solid",
    size: "md",
    onClick: onRequestAccess
  }, "Reserve a piece"), /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    size: "md",
    onClick: () => onOpenProduct(PRODUCTS[0])
  }, "View lookbook")))), /*#__PURE__*/React.createElement("div", {
    className: "luxury-sections-below"
  }, /*#__PURE__*/React.createElement("section", {
    className: "section-tone--paper"
  }, /*#__PURE__*/React.createElement("div", {
    className: "kit-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "kit-section__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "type-eyebrow"
  }, "The Collection"), /*#__PURE__*/React.createElement("span", {
    className: "type-caption kit-muted"
  }, "Six of fourteen shown")), /*#__PURE__*/React.createElement("div", {
    className: "luxury-card-grid",
    style: {
      "--cols": 3
    }
  }, PRODUCTS.map(p => /*#__PURE__*/React.createElement(Card, {
    key: p.id,
    title: p.name,
    action: "View piece",
    onAction: () => onOpenProduct(p)
  }, /*#__PURE__*/React.createElement("span", {
    className: "kit-product__line"
  }, p.line), /*#__PURE__*/React.createElement("div", {
    className: "kit-product__meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "kit-product__price"
  }, p.price), p.tag && /*#__PURE__*/React.createElement(Badge, {
    variant: p.tag === "New" ? "accent" : "outline"
  }, p.tag))))))), /*#__PURE__*/React.createElement("section", {
    className: "section-tone--tint"
  }, /*#__PURE__*/React.createElement("div", {
    className: "kit-section kit-editorial"
  }, /*#__PURE__*/React.createElement("div", {
    className: "kit-editorial__text"
  }, /*#__PURE__*/React.createElement("span", {
    className: "type-eyebrow"
  }, "The Atelier"), /*#__PURE__*/React.createElement("h2", {
    className: "type-h2"
  }, "Made by few hands, for very few owners"), /*#__PURE__*/React.createElement("p", {
    className: "type-body-md"
  }, "Every commission is recorded in the maison ledger and accompanied by a written account of its making. We restore and re-home each object, in perpetuity."), /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    size: "md",
    onClick: onRequestAccess
  }, "Request an introduction")), /*#__PURE__*/React.createElement("div", {
    className: "kit-editorial__plate",
    "aria-hidden": "true"
  }))), /*#__PURE__*/React.createElement("section", {
    className: "section-tone--paper"
  }, /*#__PURE__*/React.createElement("div", {
    className: "kit-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "kit-section__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "type-eyebrow"
  }, "The Promise")), /*#__PURE__*/React.createElement("div", {
    className: "luxury-card-grid",
    style: {
      "--cols": 3
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Provenance",
    action: "Explore",
    onAction: onRequestAccess
  }, "Each piece is recorded, numbered, and accompanied by a written account of its origin."), /*#__PURE__*/React.createElement(Card, {
    title: "Stewardship",
    action: "Explore",
    onAction: onRequestAccess
  }, "We maintain, restore and re-home every object we have ever made, in perpetuity."), /*#__PURE__*/React.createElement(Card, {
    title: "Discretion",
    action: "Explore",
    onAction: onRequestAccess
  }, "Acquisitions are made quietly, by introduction, and never spoken of without consent."))))));
}
window.Storefront = Storefront;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/maison/Storefront.jsx", error: String((e && e.message) || e) }); }

// ui_kits/maison/data.jsx
try { (() => {
/* global React */
const {
  useState
} = React;
const {
  Header,
  Button,
  Card,
  Badge,
  Separator,
  FloatingInput
} = window.KALMRDesignSystem_c156e5;

/* Shared product data ------------------------------------------------ */
const PRODUCTS = [{
  id: "p1",
  name: "The Marlowe Coat",
  line: "Outerwear",
  price: "€4,200",
  tag: "Limited"
}, {
  id: "p2",
  name: "Cashmere Roll-Neck",
  line: "Knitwear",
  price: "€1,150",
  tag: null
}, {
  id: "p3",
  name: "Calfskin Weekender",
  line: "Leather",
  price: "€3,600",
  tag: "New"
}, {
  id: "p4",
  name: "Merino Trouser",
  line: "Tailoring",
  price: "€980",
  tag: null
}, {
  id: "p5",
  name: "Silk Opera Scarf",
  line: "Accessory",
  price: "€420",
  tag: null
}, {
  id: "p6",
  name: "Vicuña Throw",
  line: "Maison",
  price: "€6,800",
  tag: "Limited"
}];
window.DS_KIT = {
  PRODUCTS
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/maison/data.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Separator = __ds_scope.Separator;

__ds_ns.FloatingInput = __ds_scope.FloatingInput;

__ds_ns.Footer = __ds_scope.Footer;

__ds_ns.Header = __ds_scope.Header;

})();
