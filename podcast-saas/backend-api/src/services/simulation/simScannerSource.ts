/**
 * The simulation control scanner — ONE implementation, two consumers.
 *
 * This ES5 source is embedded verbatim into BOTH the rAF gate (which posts its result to the
 * parent as `simControlsList`) and the serve-time authoring script (which uses the result to
 * anchor picker badges). It is a shared constant rather than a copy because a scanner that
 * disagrees with itself produces selectors that hide the wrong control in one surface and the
 * right one in the other — and the repo has already paid for duplicated rules twice this week
 * (the seven copies of the selector safety filter; the two hardcoded migration lists).
 *
 * WHAT IT GUARANTEES, and where that is proven: every emitted selector parses and resolves to
 * EXACTLY ONE element — a clean, document-unique `#id`, else a document-unique `[name]`, else a
 * child-combinator structural path anchored at a proven-unique ancestor id. Escaping is not
 * available as a strategy: a backslash-bearing selector is dropped by the `/[{}<\\]/` filter
 * enforced at seven independent sites, so the fall-through IS the fix. Behaviour is pinned by
 * `__tests__/rafGateRuntimeScanner.test.ts`, which executes the gate against the controls fixture
 * and is the safety net for this extraction — it must pass unmodified.
 *
 * `collectSimControls()` RETURNS `{controls, truncated}`. It does not post: the gate wraps it in a
 * one-line poster, and the authoring script needs the array in hand.
 *
 * ES5 ONLY, and no interpolation. This string is spliced into a template literal in two places
 * and into a document that may predate every modern feature.
 */
export const SIM_SCANNER_SOURCE = `
  // ── Minimal-UI control picker: runtime scan (v3) ────────────────────────────
  // Mirrors the static scanner's kind/selector derivation (SimUiControls.ts) — duplicated
  // inline because the gate must stay self-contained. The label LADDER below is richer
  // than the static one (it sees the live DOM); keep kind/selector policy in sync.
  function prettyName(raw) {
    return String(raw).replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\\s+/g, ' ').trim().toLowerCase()
      .replace(/(^|\\s)\\S/g, function (c) { return c.toUpperCase(); });
  }
  function controlKind(el) {
    var tag = el.tagName.toLowerCase();
    var role = (el.getAttribute('role') || '').toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input') {
      if (type === 'range') return 'slider';
      if (type === 'checkbox' || type === 'radio') return 'toggle';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    }
    if (role === 'slider') return 'slider';
    if (role === 'switch') return 'toggle';
    if (tag === 'button' || role === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'input' || tag === 'textarea') return 'input';
    return 'other';
  }
  // Every ladder result goes through cleanLabel: collapsed whitespace, trimmed, ONE
  // trailing ':' stripped ("Speed:" -> "Speed"), capped at 60 chars.
  function cleanLabel(raw) {
    var s = String(raw == null ? '' : raw).replace(/\\s+/g, ' ').trim();
    s = s.replace(/\\s*:$/, '').trim();
    if (s.length > 60) s = s.slice(0, 60).replace(/\\s+$/, '');
    return s;
  }
  // Text of root's subtree EXCLUDING one element's subtree — a wrapping <label>'s own
  // words minus the control (and its value/options) living inside it.
  function textOutside(root, exclude) {
    var t = '', kids = root.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n === exclude) continue;
      if (n.nodeType === 3) t += n.nodeValue + ' ';
      else if (n.nodeType === 1) t += textOutside(n, exclude) + ' ';
    }
    return t;
  }
  // A previous sibling that is itself a control (or wraps one) must never donate its
  // text as OUR label — "Reset" must not inherit the neighbouring "Pause" button's text.
  function isControlish(node) {
    var t = node.tagName ? node.tagName.toLowerCase() : '';
    if (t === 'button' || t === 'input' || t === 'select' || t === 'textarea' || t === 'a') return true;
    try { return !!node.querySelector('button, input, select, textarea'); } catch (err) { return false; }
  }
  function kindName(kind) {
    if (kind === 'slider') return 'Slider';
    if (kind === 'toggle') return 'Toggle';
    if (kind === 'button') return 'Button';
    if (kind === 'select') return 'Select';
    if (kind === 'input') return 'Input';
    return 'Control';
  }
  // Label ladder (v3) — first non-empty rung wins:
  //  (a) aria-label                (b) aria-labelledby (ids resolved, texts joined)
  //  (c) <label for=ID>            (d) el.closest('label') minus the control's own subtree
  //  (e) sibling label BEFORE el (a <label> or class*="label") among the parent's children
  //  (f) previous element sibling's short text (<= 40 chars, non-control)
  //  (g) parent's direct text nodes joined, when short (<= 40 chars)
  //  (h) button/link own text      (i) title            (j) placeholder
  //  (k) name prettified           (l) id prettified
  //  (m) "<Kind> N" (e.g. "Slider 2") — never the bare tag name.
  function controlLabel(el, kind, nth) {
    var v, i, t;
    v = cleanLabel(el.getAttribute('aria-label'));                              // (a)
    if (v) return v;
    t = el.getAttribute('aria-labelledby');                                     // (b)
    if (t) {
      var ids = t.replace(/\\s+/g, ' ').trim().split(' ');
      t = '';
      for (i = 0; i < ids.length; i++) {
        var ref = document.getElementById(ids[i]);
        if (ref && ref.textContent) t += ref.textContent + ' ';
      }
      v = cleanLabel(t);
      if (v) return v;
    }
    if (el.id) {                                                                // (c)
      var lab = null;
      try { lab = document.querySelector('label[for="' + el.id + '"]'); } catch (err) { /* odd id */ }
      if (lab) { v = cleanLabel(lab.textContent); if (v) return v; }
    }
    var wrap = el.closest ? el.closest('label') : null;                         // (d)
    if (wrap && wrap !== el) { v = cleanLabel(textOutside(wrap, el)); if (v) return v; }
    if (el.parentElement) {                                                     // (e)
      var kids = el.parentElement.children;
      for (i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k === el) break;
        if (k.tagName.toLowerCase() === 'label' ||
            (k.getAttribute('class') || '').toLowerCase().indexOf('label') !== -1) {
          v = cleanLabel(k.textContent);
          if (v) return v;
        }
      }
    }
    var prev = el.previousElementSibling;                                       // (f)
    if (prev && !isControlish(prev)) {
      v = cleanLabel(prev.textContent);
      if (v && v.length <= 40) return v;
    }
    if (el.parentElement) {                                                     // (g)
      var pk = el.parentElement.childNodes;
      t = '';
      for (i = 0; i < pk.length; i++) { if (pk[i].nodeType === 3) t += pk[i].nodeValue + ' '; }
      v = cleanLabel(t);
      if (v && v.length <= 40) return v;
    }
    if (kind === 'button') { v = cleanLabel(el.textContent); if (v) return v; } // (h)
    v = cleanLabel(el.getAttribute('title'));                                   // (i)
    if (v) return v;
    v = cleanLabel(el.getAttribute('placeholder'));                             // (j)
    if (v) return v;
    v = cleanLabel(prettyName(el.getAttribute('name') || ''));                  // (k)
    if (v) return v;
    v = cleanLabel(prettyName(el.id || ''));                                    // (l)
    if (v) return v;
    return kindName(kind) + ' ' + nth;                                          // (m)
  }
  function nthOfType(el) {
    var n = 1, sib = el.previousElementSibling;
    while (sib) { if (sib.tagName === el.tagName) n++; sib = sib.previousElementSibling; }
    return el.tagName.toLowerCase() + ':nth-of-type(' + n + ')';
  }
  // A selector fragment this scanner may emit must survive TWO consumers that cannot complain:
  // querySelector (throws or silently mis-matches on an unescaped special character) and the
  // hide-list <style> blocks, whose /[{}<\\]/ safety filter — enforced at SEVEN independent
  // sites — drops anything carrying a backslash. So escaping is not available here: a correctly
  // escaped selector is exactly what the filters delete, which converts "the wrong control was
  // hidden" into "the control is not offered at all" (measured, 2026-08-25). The only shape that
  // satisfies both consumers is a fragment that NEEDS no escaping — hence cleanIdent, and the
  // structural fall-through for everything else.
  function cleanIdent(s) {
    // A CSS ident that is safe to concatenate raw: starts with a letter or underscore (a leading
    // digit makes '#123' invalid CSS even though it is a legal HTML id), then word chars/hyphens.
    return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s);
  }
  function uniqueMatch(sel, el) {
    // Provably THIS element, not merely "one match": for a duplicate id the second element gets
    // length 2, but for subtler collisions m[0] === el is the check that cannot be fooled.
    try {
      var m = document.querySelectorAll(sel);
      return m.length === 1 && m[0] === el;
    } catch (err) { return false; }
  }
  function controlSelector(el) {
    // #id and [name] are shortcuts, taken ONLY when provably clean and unique. HTML happily
    // permits duplicate ids, ids querySelector cannot parse, and names shared by a whole radio
    // group — each of which used to produce a selector that silently hid nothing, the wrong
    // control, or an entire group (ledger, 2026-08-25). Anything that fails the proof falls
    // through to the structural path, which is single-match by construction and, containing only
    // tag names, digits and ' > ', is accepted by every filter unchanged.
    if (el.id && cleanIdent(el.id)) {
      var idSel = '#' + el.id;
      if (uniqueMatch(idSel, el)) return idSel;
    }
    var name = el.getAttribute('name');
    if (name && cleanIdent(name)) {
      var nameSel = '[name="' + name + '"]';
      if (uniqueMatch(nameSel, el)) return nameSel;
    }
    // Unambiguous structural path: CHILD-combinator hops from the nearest ancestor with a
    // PROVEN-unique clean id (or document.body) down to the element — tag:nth-of-type(i) per
    // level, i counted among same-TAG siblings. The anchor is gated by the same proof as the
    // shortcut above: an ancestor with a duplicate or unparseable id would poison every path
    // anchored on it, so such an ancestor is climbed past rather than trusted.
    var parts = [];
    var node = el;
    var anchor = null;
    while (node && !anchor) {
      parts.unshift(nthOfType(node));
      var parent = node.parentElement;
      if (!parent) break;
      if (parent.id && cleanIdent(parent.id) && uniqueMatch('#' + parent.id, parent)) anchor = '#' + parent.id;
      else if (parent === document.body) anchor = 'body';
      else if (parent === document.documentElement) anchor = 'html';
      else node = parent;
    }
    return (anchor ? anchor + ' > ' : '') + parts.join(' > ');
  }
  function collectSimControls() {
    var vis = [];   // visible controls — these fill the 100 cap FIRST
    var hid = [];   // hidden controls (collapsed menus / display:none groups) — flagged hidden:true
    var seen = {};
    var counts = {};
    var nodes = document.querySelectorAll('button, input, select, textarea, [role="button"], [role="slider"], [role="switch"]');
    for (var i = 0; i < nodes.length; i++) {
      if (vis.length >= 100) break;   // visible alone can fill the cap — hidden never displaces visible
      var el = nodes[i];
      if (el.tagName.toLowerCase() === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') continue;
      // The authoring overlay draws badges INTO this document. Without this, opening the picker
      // and rescanning would report its own pills as controls of the simulation.
      if (el.closest && el.closest('[data-sim-authoring-overlay]')) continue;
      var fixed = false;
      try { fixed = getComputedStyle(el).position === 'fixed'; } catch (err) { /* detached */ }
      // hidden = not laid out (display:none subtree) and not position:fixed. Such controls
      // ARE included — sims hide whole groups behind an "Advanced" toggle — just flagged.
      var isHidden = !(el.offsetParent !== null || fixed);
      var selector = controlSelector(el);
      // The wrap templates (and the backend schema) reject selectors containing { } <
      // or backslash — never emit them. Cap length to the schema's selector max (300).
      // '>' is allowed: it is the child combinator the structural paths above rely on.
      if (/[{}<\\\\]/.test(selector) || selector.length > 300) continue;
      if (seen['s:' + selector]) continue;                // dedupe by selector
      seen['s:' + selector] = true;
      var kind = controlKind(el);
      counts[kind] = (counts[kind] || 0) + 1;             // per-kind index for the "<Kind> N" fallback
      var c = { selector: selector, kind: kind, label: controlLabel(el, kind, counts[kind]) };
      if (isHidden) { c.hidden = true; if (hid.length < 100) hid.push(c); }
      else { vis.push(c); }
    }
    // TRUNCATION travels with the result. A caller that acts on this list — "hide everything the
    // script did not touch" — would otherwise hide controls it never saw, which is exactly the
    // case the ADR requires to fall back to no-suggestion.
    var truncated = (vis.length + hid.length) > 100 || nodes.length > vis.length + hid.length;
    return { controls: vis.concat(hid).slice(0, 100), truncated: truncated };
  }
`;
