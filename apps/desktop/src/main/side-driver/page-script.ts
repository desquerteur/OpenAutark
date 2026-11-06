// The script the side driver puts into every document of a side tab – in its own isolated
// world (DevTools Page.addScriptToEvaluateOnNewDocument with a world name), so the page can neither see
// nor call it. It
//   • reports the person's own mouse moves, clicks, wheel and key presses (trusted events only, moves
//     at most every 100 ms, with role and name of the control under the pointer) through a binding that
//     exists only in this world (Runtime.addBinding with executionContextName);
//   • draws each agent's named cursor in a closed shadow root over the page (pointer-events none, the
//     top z-index) and animates it along the same path the driver moves the mouse; hidden after 4 s idle;
//   • watches the document for changes while a wait asks for them; reads the page's text and the facts
//     for a human check (captcha frames, "Verify you are human" pages) and password fields.
// Only DOM APIs (no innerHTML, no style elements), so strict page policies do not block it.
// Owns: the in-page part of the driver. Never: reads field values, cookies or storage, or acts for an agent.

/** Hosts and paths of human checks (captcha widgets and challenge pages). */
export const CHALLENGE_URL = /(?:^|[/.])(?:hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs\.com|funcaptcha\.com|captcha-delivery\.com|geetest\.com|mtcaptcha\.com|friendlycaptcha\.(?:com|eu))(?:[/:?#]|$)|\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)|\/cdn-cgi\/challenge-platform\//i;
/** Words of a human-check page (short pages only). */
export const CHALLENGE_TEXT = /verify (?:that )?you(?:'re| are) (?:a )?human|are you a robot|i(?:'| a)?m not a robot|press (?:and|&) hold|checking (?:if the site connection is secure|your browser)|complete the security check|confirm you(?:'re| are) (?:a )?human|bestätigen sie, dass sie ein mensch sind|ich bin kein roboter|just a moment\.\.\./i;

/** Is this address a human check (a captcha frame or a challenge page)? */
export function isChallengeUrl(url: string): boolean {
  return CHALLENGE_URL.test(url) && !/[?&#](?:size=invisible|frame=checkbox-invisible)/i.test(url);
}

export function pageScript(binding: string): string {
  return `(() => {
  if (globalThis.__wfSide) return;
  const top = window === window.top;
  const send = (data) => { try { const fn = globalThis[${JSON.stringify(binding)}]; if (typeof fn === 'function') fn(JSON.stringify(data)); } catch {} };
  const clip = (s, n) => { s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const ROLE = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', SUMMARY: 'button', OPTION: 'option', LABEL: 'label',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading' };
  const INPUT = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox', number: 'spinbutton' };
  const CONTROL = 'a[href],button,input,select,textarea,summary,option,label,h1,h2,h3,h4,h5,h6,img,[contenteditable=""],[contenteditable="true"],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[role=slider],[role=treeitem],[role=gridcell]';
  const roleOf = (el) => (el.getAttribute('role') || '').split(' ')[0] || (el.tagName === 'INPUT' ? INPUT[el.type] || 'textbox' : el.isContentEditable ? 'textbox' : ROLE[el.tagName] || '');
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' '); if (t.trim()) return t; }
    if (el.labels && el.labels.length) return el.labels[0].textContent;
    if (el.tagName === 'IMG') return el.alt || el.title;
    if (el.tagName === 'INPUT') return /^(submit|button|reset)$/.test(el.type) ? el.value : el.placeholder || el.title || '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return el.placeholder || el.title || '';
    return el.title || (el.textContent || '').slice(0, 200);
  };
  const target = (el) => {
    if (!el || el.nodeType !== 1) return undefined;
    const hit = el.closest(CONTROL);
    if (!hit) { const t = clip(el.textContent, 120); return t && t.length < 120 ? { name: clip(t, 80) } : undefined; }
    const role = roleOf(hit), name = clip(nameOf(hit), 80);
    return role || name ? { role: role || undefined, name: name || undefined } : undefined;
  };
  // ---- the person's input (moves at most every 100 ms; clicks at once)
  let last = 0, timer = 0, pending = null;
  const flush = () => {
    timer = 0; if (!pending) return;
    const p = pending; pending = null; last = Date.now();
    const out = { k: 'in', e: p.e };
    if (top && p.x !== undefined) { out.x = Math.round(p.x); out.y = Math.round(p.y); }
    if (!top) out.frame = 1;
    if (p.key) out.key = p.key;
    if (top && p.el) { const t = target(p.el); if (t) out.target = t; }
    send(out);
  };
  const queue = (p, now) => { pending = p; const wait = 100 - (Date.now() - last); if (now || wait <= 0) { clearTimeout(timer); flush(); } else if (!timer) timer = setTimeout(flush, wait); };
  const opts = { capture: true, passive: true };
  addEventListener('mousemove', (e) => { if (e.isTrusted && (e.movementX || e.movementY)) queue({ e: 'move', x: e.clientX, y: e.clientY, el: e.target }); }, opts);
  addEventListener('mousedown', (e) => { if (e.isTrusted) queue({ e: 'click', x: e.clientX, y: e.clientY, el: e.target }, true); }, opts);
  addEventListener('wheel', (e) => { if (e.isTrusted) queue({ e: 'scroll', x: e.clientX, y: e.clientY, el: e.target }); }, opts);
  addEventListener('keydown', (e) => { if (e.isTrusted) queue({ e: 'type', key: e.key.length === 1 ? 'char' : e.key, el: document.activeElement }); }, opts);
  // ---- document changes, only while a wait asks
  let observer = null, mutLast = 0, mutTimer = 0;
  const changed = () => {
    const now = Date.now();
    if (now - mutLast >= 150) { mutLast = now; send({ k: 'mut' }); }
    else if (!mutTimer) mutTimer = setTimeout(() => { mutTimer = 0; mutLast = Date.now(); send({ k: 'mut' }); }, 150);
  };
  const watch = (on) => {
    if (on && !observer) { observer = new MutationObserver(changed); observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); }
    else if (!on && observer) { observer.disconnect(); observer = null; }
    return Boolean(observer);
  };
  // ---- named cursors
  const NS = 'http://www.w3.org/2000/svg';
  let host = null, root = null;
  const cursors = new Map();
  const ensure = () => {
    if (host && host.isConnected) return root;
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict;';
    root = host.attachShadow({ mode: 'closed' });
    (document.documentElement || document.body).appendChild(host);
    cursors.clear();
    return root;
  };
  const make = (name, color) => {
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:0;top:0;transform:translate(-200px,-200px);transition:opacity .3s;opacity:0;will-change:transform;';
    const ring = document.createElement('div');
    ring.style.cssText = 'position:absolute;left:-14px;top:-14px;width:28px;height:28px;box-sizing:border-box;border-radius:50%;border:2px solid ' + color + ';opacity:0;';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '18'); svg.setAttribute('height', '22'); svg.setAttribute('viewBox', '0 0 18 22');
    svg.style.cssText = 'position:absolute;left:-2px;top:-2px;overflow:visible;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));';
    const arrow = document.createElementNS(NS, 'path');
    arrow.setAttribute('d', 'M2 2 L2 18 L6.5 13.8 L9.6 20.4 L12.4 19.2 L9.4 12.8 L15.4 12.8 Z');
    arrow.setAttribute('fill', color); arrow.setAttribute('stroke', '#fff'); arrow.setAttribute('stroke-width', '1.4'); arrow.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(arrow);
    const label = document.createElement('div');
    label.textContent = name;
    label.style.cssText = 'position:absolute;left:15px;top:19px;padding:2px 7px;border-radius:9px;background:' + color + ';color:#fff;font:600 12px/16px system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.3);';
    box.append(ring, svg, label);
    root.appendChild(box);
    return { box, ring, label, x: -200, y: -200, raf: 0, hide: 0 };
  };
  const place = (c, x, y) => { c.x = x; c.y = y; c.box.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)'; };
  const cursor = (id, name, color, path, click) => {
    ensure();
    let c = cursors.get(id);
    if (!c || !c.box.isConnected) { c = make(name, color); cursors.set(id, c); }
    if (c.label.textContent !== name) c.label.textContent = name;
    clearTimeout(c.hide); cancelAnimationFrame(c.raf);
    c.box.style.opacity = '1';
    const steps = Array.isArray(path) ? path : [];
    if (!steps.length) return;
    const from = c.x < -100 ? { x: steps[0].x, y: steps[0].y, t: 0 } : { x: c.x, y: c.y, t: 0 };
    const end = steps[steps.length - 1].t, start = performance.now();
    const done = () => {
      place(c, steps[steps.length - 1].x, steps[steps.length - 1].y);
      if (click && c.ring.animate) c.ring.animate([{ opacity: 0.9, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(1.5)' }], { duration: 450, easing: 'ease-out' });
      c.hide = setTimeout(() => { c.box.style.opacity = '0'; }, 4000);
    };
    const frame = () => {
      const t = performance.now() - start;
      if (t >= end) { done(); return; }
      let i = 0; while (i < steps.length && steps[i].t < t) i++;
      const a = i === 0 ? from : steps[i - 1], b = steps[i], f = (t - a.t) / Math.max(1, b.t - a.t);
      place(c, a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
      c.raf = requestAnimationFrame(frame);
    };
    if (from.x !== steps[0].x || from.y !== steps[0].y || end > 0) place(c, from.x, from.y);
    frame();
  };
  const state = () => [...cursors].map(([id, c]) => ({ id, x: Math.round(c.x), y: Math.round(c.y), shown: c.box.isConnected && c.box.style.opacity === '1' }));
  // ---- page facts
  const CHALLENGE = new RegExp(${JSON.stringify(CHALLENGE_URL.source)}, 'i');
  const WORDS = new RegExp(${JSON.stringify(CHALLENGE_TEXT.source)}, 'i');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 400) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const facts = () => {
    let human = false;
    for (const f of document.querySelectorAll('iframe')) {
      const src = f.src || '';
      if (src && CHALLENGE.test(src) && !/[?&#](?:size=invisible|frame=checkbox-invisible)/i.test(src) && visible(f)) { human = true; break; }
    }
    if (!human && document.querySelector('#challenge-running,#challenge-stage,#cf-challenge-running,.cf-browser-verification')) human = true;
    if (!human) {
      const body = document.body ? document.body.innerText || '' : '';
      if (body.length < 6000 && WORDS.test((document.title || '') + ' ' + body)) human = true;
    }
    return { human, passwords: document.querySelectorAll('input[type=password]').length };
  };
  const text = (max) => { const b = document.body || document.documentElement; return b ? String(b.innerText || '').slice(0, max) : ''; };
  globalThis.__wfSide = { cursor, state, watch, facts, text, passwords: () => [...document.querySelectorAll('input[type=password]')].slice(0, 20) };
})();`;
}
