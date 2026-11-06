/* Owns: the site's optional behaviour (reveal, header, menu, live release info, the visitor's platform,
   the home animations, /pair/). Never: content; the full content is in the HTML.
   Animations only run while visible and respect reduced motion. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

  // Runs `fn` only while `el` is on screen; `fn` gets a live `alive()` check.
  function whileVisible(el, fn, margin = '0px') {
    if (!el) return;
    let on = false; let running = false;
    const alive = () => on;
    new IntersectionObserver(async ([e]) => {
      on = e.isIntersecting;
      if (on && !running) { running = true; try { await fn(alive); } finally { running = false; } }
    }, { rootMargin: margin }).observe(el);
  }

  /* ── header: solid after scroll, light text over dark sections ── */
  const hdr = $('#hdr');
  const darkZones = $$('.dark, .night, .ftr');
  let ticking = false;
  function onScroll() {
    ticking = false;
    const y = scrollY;
    hdr.classList.toggle('is-solid', y > 8);
    const mid = 32;
    hdr.classList.toggle('is-dark', darkZones.some((z) => { const r = z.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; }));
  }
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  onScroll();

  /* ── mobile menu ── */
  const menuBtn = $('.menu-btn');
  menuBtn?.addEventListener('click', () => {
    const open = document.body.classList.toggle('menu-open');
    menuBtn.setAttribute('aria-expanded', String(open));
    document.documentElement.style.overflow = open ? 'hidden' : '';
  });
  $$('.mnav a').forEach((a) => a.addEventListener('click', () => { document.body.classList.remove('menu-open'); document.documentElement.style.overflow = ''; }));

  /* ── reveal on scroll ── */
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.01 });
  $$('[data-reveal]').forEach((el) => io.observe(el));

  /* ── giant word ── */
  const ready = () => $$('.hero, .ftr__giant').forEach((h) => h.classList.add('is-ready'));
  (document.fonts?.ready || Promise.resolve()).then(() => setTimeout(ready, 60));
  setTimeout(ready, 1200);
  const ftrWord = $('.ftr__giant');
  if (ftrWord) { ftrWord.classList.remove('is-ready'); new IntersectionObserver(([e], o) => { if (e.isIntersecting) { ftrWord.classList.add('is-ready'); o.disconnect(); } }, { threshold: 0.3 }).observe(ftrWord); }

  /* ── live release info (GitHub API allows browser calls) ── */
  const REL = window.__REL;
  async function releaseInfo() {
    if (!REL) return;
    try {
      const r = await fetch(`${REL.api}/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) return;
      const j = await r.json();
      const v = String(j.tag_name || '').replace(/^v/, '');
      const exe = (j.assets || []).find((a) => a.name === REL.windowsFile);
      if (!v) return;
      const mb = exe ? Math.round(exe.size / 1e6) : REL.fallback.windows.sizeMb;
      const date = j.published_at ? new Date(j.published_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Vienna' }) : '';
      $$('[data-rel="windows-version"]').forEach((el) => { el.textContent = `Version ${v}`; });
      $$('[data-rel="windows-v"]').forEach((el) => { el.textContent = v; });
      $$('[data-rel="windows-meta"]').forEach((el) => { el.textContent = `v${v} · ${mb} MB`; });
      $$('[data-rel="windows-size"]').forEach((el) => { el.textContent = `${mb} MB`; });
      if (date) $$('[data-rel="windows-date"]').forEach((el) => { el.textContent = el.dataset.prefix === 'none' ? date : `Released ${date}`; });
    } catch { /* offline or rate-limited: the built-in values stay */ }
  }
  releaseInfo();

  /* ── which system is the visitor on: mark its tile, point the main button at its page ── */
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1; // iPadOS reports a Mac
  const os = /Android/i.test(ua) ? 'android' : /iPhone|iPad|iPod/i.test(ua) || touchMac ? 'iphone' : /Windows/i.test(ua) ? 'windows' : /Mac OS X|Macintosh/i.test(ua) ? 'mac' : /Linux/i.test(ua) ? 'linux' : 'other';
  document.documentElement.dataset.os = os;
  $$(`[data-plat="${os}"]`).forEach((c) => c.classList.add('is-you'));
  const mine = REL?.platforms?.find((p) => p.id === os);
  if (mine && os !== 'windows') $$('[data-dl-auto]').forEach((b) => {
    b.href = `${REL.base}download/${os}/`; b.removeAttribute('rel');
    const label = $('[data-dl-label]', b); if (label) label.textContent = os === 'iphone' ? 'Autark on iPhone' : `Download for ${mine.os}`;
    $('[data-rel="windows-meta"]', b)?.remove();
    const ic = $('.ic', b); if (ic) ic.outerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
  });

  /* ── /pair/: show the Remote ID the PC's QR code carries (#<id>) ── */
  const pairId = $('[data-pair-id]');
  if (pairId) {
    const id = decodeURIComponent(location.hash.slice(1)).replace(/[^0-9A-Za-z -]/g, '').trim().slice(0, 32);
    const copy = $('[data-pair-copy]');
    if (id) {
      pairId.textContent = id; pairId.classList.add('is-on');
      if (copy) { copy.hidden = false; copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(id); $('span', copy).textContent = 'Copied'; } catch { /* clipboard blocked */ } }); }
      // Android: hand the same address to the app (the ID as ?id=, since # ends an intent link); no app → the Android page.
      // iPhone: the Camera opened Safari, whose storage is not the Home Screen app's – the ID belongs in the app.
      const ios = $('[data-pair-ios]');
      if (ios && os === 'iphone') ios.hidden = false;
      const open = $('[data-pair-open]');
      if (open && os === 'android') {
        open.href = `intent://${location.host}${location.pathname}?id=${encodeURIComponent(id)}#Intent;scheme=https;package=${open.dataset.package};S.browser_fallback_url=${encodeURIComponent(open.dataset.fallback)};end`;
        open.hidden = false;
      }
    }
  }

  /* ── hero: the company at work ── */
  const org = $('[data-org-stage]');
  if (org) {
    const svg = $('[data-org-lines]', org);
    const N = Object.fromEntries($$('[data-node]', org).map((n) => [n.dataset.node, n]));
    const edges = [['you', 'mara'], ['mara', 'theo'], ['mara', 'ana'], ['mara', 'ivo'], ['mara', 'lena'], ['mara', 'noa'], ['mara', 'kai'], ['noa', 'ana'], ['ana', 'you'], ['theo', 'you']];
    const paths = {};
    function center(n) { const a = $('.node__av', n).getBoundingClientRect(); const s = org.getBoundingClientRect(); return [a.left - s.left + a.width / 2, a.top - s.top + a.height / 2]; }
    function draw() {
      const w = org.clientWidth; const h = org.clientHeight;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      let out = '';
      for (const [a, b] of edges) {
        const [x1, y1] = center(N[a]); const [x2, y2] = center(N[b]);
        let d;
        if (Math.abs(y1 - y2) < 4) d = `M${x1} ${y1}H${x2}`;
        else if ((a === 'noa' && b === 'ana') || (a === 'ana' && b === 'you') || (a === 'theo' && b === 'you')) {
          const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2; d = `M${x1} ${y1}Q${x1 + (x2 - x1) * 0.1} ${my} ${mx} ${my}T${x2} ${y2}`;
        } else { const my = y1 + (y2 - y1) * 0.5; d = `M${x1} ${y1}V${my}H${x2}V${y2}`; }
        const id = `${a}-${b}`;
        const quiet = (a === 'noa' && b === 'ana') || (a === 'ana' && b === 'you') || (a === 'theo' && b === 'you');
        out += `${quiet ? '' : `<path class="org__edge" d="${d}"/>`}<path class="org__flow" data-e="${id}" d="${d}"/>`;
      }
      svg.innerHTML = out;
      $$('[data-e]', svg).forEach((p) => { paths[p.dataset.e] = p; });
    }
    draw();
    let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(draw, 120); });
    document.fonts?.ready.then(draw);

    const chip = (id, html) => { const c = $('[data-chip]', N[id]); if (html) { c.innerHTML = html; c.classList.add('is-on'); } else c.classList.remove('is-on'); };
    const st = (id, s) => { const n = N[id]; n.classList.remove('is-busy', 'is-ask', 'is-done'); if (s) n.classList.add(`is-${s}`); };
    const flow = (id, on = true) => paths[id]?.classList.toggle('is-on', on);
    const clock = $('[data-org-clock]');
    const setClock = (t) => { clock.textContent = `Tue ${t}`; };
    const reset = () => { Object.keys(N).forEach((k) => { st(k); chip(k); }); Object.values(paths).forEach((p) => p.classList.remove('is-on')); };

    const script = [
      ['09:00', () => { st('you', 'busy'); chip('you', 'New task: <b>launch the autumn offer</b>'); flow('you-mara'); }, 1900],
      ['09:01', () => { chip('you'); st('you'); flow('you-mara', false); st('mara', 'busy'); chip('mara', 'splitting into <b>4 tasks</b>'); ['mara-ivo', 'mara-lena', 'mara-noa', 'mara-kai'].forEach((e) => flow(e)); }, 1900],
      ['09:03', () => { chip('mara'); st('mara'); ['ivo', 'lena', 'noa', 'kai'].forEach((k) => st(k, 'busy')); chip('ivo', 'researching 6 competitors'); chip('kai', 'updating the website'); }, 1700],
      ['09:20', () => { chip('lena', 'drafting the landing copy'); chip('noa', 'planning the ad budget'); ['mara-ivo', 'mara-lena', 'mara-kai'].forEach((e) => flow(e, false)); }, 1800],
      ['09:41', () => { flow('mara-noa', false); flow('noa-ana'); st('ana', 'busy'); chip('ana', 'Noa asks: <b>which ad account?</b>'); chip('ivo'); }, 1900],
      ['09:42', () => { flow('noa-ana', false); flow('ana-you'); st('ana', 'ask'); chip('ana', 'answers in the chat'); st('you', 'busy'); chip('you', 'reads along · <b>adds one line</b>'); chip('kai'); }, 2000],
      ['10:05', () => { flow('ana-you', false); st('ana'); chip('ana'); chip('you'); st('you'); st('noa', 'done'); chip('noa', 'budget planned'); st('theo', 'busy'); chip('theo', 'moved your 3 pm call'); flow('theo-you'); }, 2000],
      ['11:30', () => { flow('theo-you', false); st('theo', 'done'); chip('theo'); chip('noa'); st('ivo', 'done'); chip('ivo', 'report ready'); st('lena', 'done'); chip('lena', 'draft in your chat'); st('kai', 'done'); }, 2000],
      ['12:00', () => { chip('ivo'); chip('lena'); st('mara', 'busy'); chip('mara', 'briefing sent to <b>you</b>'); flow('you-mara'); }, 2400],
    ];
    if (reduce) { st('mara', 'busy'); chip('mara', 'splitting into <b>4 tasks</b>'); ['ivo', 'lena', 'noa', 'kai'].forEach((k) => st(k, 'busy')); }
    else whileVisible(org, async (alive) => {
      while (alive()) {
        reset();
        for (const [t, fn, ms] of script) { if (!alive()) break; setClock(t); fn(); await wait(ms); }
        await wait(600);
      }
    });
  }

  /* ── problem story ──
     Wide screens: the stage stays beside the text and its scene follows the step in view.
     Under 900px the stage is an ordinary block under the four steps (no pinning, nothing that travels
     along); while it is on screen it plays the four scenes one after another. */
  const story = $('[data-story]');
  const narrow = matchMedia('(max-width: 900px)');
  if (story) {
    const steps = $$('[data-step]', story);
    const scenes = $$('[data-scene]', story);
    const title = $('[data-screen-title]', story);
    const titles = ['chat — new conversation', 'chat — new conversation', 'your screen, every day', 'usage — this week'];
    let current = -1; let token = 0;
    const play = {
      0: async (my) => {
        const t = $('[data-wait-time]'); const s = $('[data-wait-sub]');
        let min = 9 * 60;
        while (my() && min < 24 * 60 - 1) { min = Math.min(24 * 60 - 1, min + 7); t.textContent = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; s.textContent = '0 tasks started'; await wait(40); }
      },
      1: async (my) => { const f = $('[data-forget]'); f.classList.remove('is-gone'); await wait(1800); if (my()) f.classList.add('is-gone'); },
      2: async (my) => {
        const g = $('[data-glue]'); const c = $('[data-glue-cursor]'); const n = $('[data-glue-n]');
        const wins = $$('.win', g); let k = 0; let count = 0;
        while (my()) {
          const w = wins[[0, 1, 2, 3, 1, 0][k % 6]]; const gr = g.getBoundingClientRect(); const r = w.getBoundingClientRect();
          c.style.transform = `translate(${r.left - gr.left + r.width * 0.55}px, ${r.top - gr.top + r.height * 0.6}px)`;
          await wait(1050); count += 1; n.textContent = String(count); k += 1;
        }
      },
      3: async () => {},
    };
    function activate(i) {
      if (i === current) return;
      current = i; const my = ++token;
      steps.forEach((s, j) => s.classList.toggle('is-active', j === i));
      scenes.forEach((s, j) => s.classList.toggle('is-on', j === i));
      if (title) title.textContent = titles[i] || titles[0];
      if (!reduce) play[i]?.(() => my === token);
    }
    const so = new IntersectionObserver((es) => {
      if (narrow.matches) return;
      es.forEach((e) => { if (e.isIntersecting) activate(Number(e.target.dataset.step)); });
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach((s) => so.observe(s));
    activate(0);
    const stage = $('.story__stage', story);
    if (!reduce) whileVisible(stage, async (alive) => {
      let i = current;
      while (alive() && narrow.matches) { activate(i); await wait(4200); i = (i + 1) % scenes.length; }
    });
  }

  /* ── statement: words light up while scrolling through ── */
  const stmt = $('[data-statement]');
  if (stmt) {
    const words = $$('.w', stmt);
    const tick = () => {
      const r = stmt.getBoundingClientRect(); const vh = innerHeight;
      const p = reduce ? 1 : clamp((vh * 0.85 - r.top) / (r.height + vh * 0.35));
      const lit = Math.round(p * words.length);
      words.forEach((w, i) => w.classList.toggle('is-on', i < lit));
    };
    whileVisible(stmt, async (alive) => { while (alive()) { tick(); await new Promise(requestAnimationFrame); } });
    tick();
  }

  /* ── step 1: a dictated sentence splits into tasks ── */
  const split = $('[data-split]');
  if (split) {
    const text = $('[data-split-text]', split); const tasks = $$('.split__task', split);
    const line = 'Find out what the three closest competitors charge, get the newsletter ready for Friday, and remind me to call the printer.';
    if (reduce) { text.textContent = line; tasks.forEach((t) => t.classList.add('is-on')); }
    else whileVisible(split, async (alive) => {
      while (alive()) {
        tasks.forEach((t) => t.classList.remove('is-on')); text.textContent = '';
        for (let i = 0; i <= line.length && alive(); i += 2) { text.textContent = line.slice(0, i); await wait(28); }
        await wait(500);
        for (const t of tasks) { if (!alive()) break; t.classList.add('is-on'); await wait(520); }
        await wait(3200);
      }
    });
  }

  /* ── step 2: the run journal ── */
  const log = $('[data-log]');
  if (log) {
    const lines = [
      ['09:03', 'mara', 'agents.delegate → ivo'], ['09:03', 'ivo', 'web.search "pricing"'], ['09:04', 'ivo', 'browser.open 3 sites'], ['09:06', 'lena', 'skills.load writing-style'],
      ['09:06', 'lena', 'app.notion.search brief'], ['09:08', 'kai', 'files.write index.html'], ['09:09', 'noa', 'skills.load money'], ['09:10', 'ivo', 'chat.send report.md'],
      ['09:11', 'theo', 'calendar.move 15:00'], ['09:12', 'mara', 'tasks.complete 3 of 4'],
    ];
    const add = (l) => { const d = document.createElement('div'); d.className = 'log__line'; d.innerHTML = `<span class="t">${l[0]}</span><span class="who">${l[1]}</span><span>${l[2]}</span><span class="ok">✓</span>`; log.appendChild(d); while (log.children.length > 9) log.firstChild.remove(); };
    if (reduce) lines.slice(0, 8).forEach(add);
    else whileVisible(log, async (alive) => { let i = 0; while (alive()) { add(lines[i % lines.length]); i += 1; await wait(900); } });
  }

  /* ── step 3: the first question ── */
  const askCard = $('[data-ask]');
  if (askCard && !reduce) whileVisible(askCard, async (alive) => { while (alive()) { askCard.classList.remove('is-pressed'); await wait(2600); if (!alive()) break; askCard.classList.add('is-pressed'); await wait(1800); } });

  /* ── night shift: scroll drives the clock ── */
  const night = $('[data-night]');
  if (night) {
    const stars = $('[data-stars]', night);
    if (stars) { let h = ''; let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; for (let i = 0; i < 90; i++) { h += `<i style="left:${(rnd() * 100).toFixed(2)}%;top:${(rnd() * 70).toFixed(2)}%;opacity:${(0.15 + rnd() * 0.6).toFixed(2)};transform:scale(${(0.6 + rnd()).toFixed(2)})"></i>`; } stars.innerHTML = h; }
    const time = $('[data-night-time]', night); const track = $('[data-night-track]', night);
    const tasks = $$('.ntask', night); const brief = $('[data-brief]', night);
    const bDone = $('[data-brief-done]', night); const bAsk = $('[data-brief-ask]', night); const bT = $('[data-brief-t]', night); const bH = $('[data-brief-h]', night); const bP = $('[data-brief-p]', night);
    const start = 22 * 60; const end = 31 * 60 + 30; // 22:00 → 07:30 next day
    const toMin = (s) => { const [h, m] = s.split(':').map(Number); return (h < 12 ? h + 24 : h) * 60 + m; };
    const fmt = (m) => { const mm = Math.round(m) % (24 * 60); return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`; };
    const render = (p) => {
      const now = start + (end - start) * p;
      time.textContent = fmt(now);
      night.style.setProperty('--dawn', String(clamp((p - 0.72) / 0.28) * 0.32));
      track.style.setProperty('--p', String(p));
      tasks.forEach((t) => {
        const at = toMin(t.dataset.at);
        t.classList.remove('is-run', 'is-done', 'is-ask');
        if (now >= at + 25) t.classList.add(t.dataset.end === 'ask' ? 'is-ask' : 'is-done');
        else if (now >= at - 20) t.classList.add('is-run');
      });
      const done = tasks.filter((t) => t.classList.contains('is-done')).length; const asks = tasks.filter((t) => t.classList.contains('is-ask')).length;
      const morning = p > 0.9;
      bDone.textContent = String(done); bAsk.textContent = String(asks); bT.textContent = morning ? '07:30' : fmt(now);
      bH.textContent = morning ? 'Good morning. Here is what happened while you slept.' : 'Writing your briefing…';
      bP.style.opacity = morning ? '1' : '0';
      brief.classList.toggle('is-live', p > 0.04); brief.classList.toggle('is-on', morning);
    };
    if (reduce) render(1);
    else whileVisible(night, async (alive) => {
      while (alive()) {
        const r = night.getBoundingClientRect();
        render(clamp(-r.top / (r.height - innerHeight)));
        await new Promise(requestAnimationFrame);
      }
    }, '100px');
  }

  /* ── engines: agents ride their lane ── */
  const setRide = () => $$('[data-ride]').forEach((a) => { const t = a.parentElement; a.style.setProperty('--w', `${t.clientWidth}px`); });
  setRide(); addEventListener('resize', setRide);
  if (!reduce) $$('[data-ride]').forEach((a) => whileVisible(a, async () => { a.classList.add('is-on'); }));
  else $$('[data-ride]').forEach((a) => { a.classList.add('is-on'); });

  /* ── reach: what an agent can touch, nothing in between ── */
  const reach = $('[data-reach]');
  if (reach) {
    const acts = [
      ['Search Documents', 'pc'], ['Run a build', 'pc'], ['Open a site in this chat’s tabs', 'web'], ['Sign in with secret://github', 'web'],
      ['Read the money skill first', 'word'], ['Buy a domain · €12', 'web'], ['Install a tool', 'pc'], ['Ask you: how far may I go?', 'word'],
      ['Send the offer', 'web'], ['Keep your answer in memory', 'word'],
    ];
    const lanes = { pc: 0, web: 1, word: 2 };
    const spawn = async (a, alive) => {
      const el = document.createElement('div'); el.className = 'act'; el.textContent = a[0];
      const gh = reach.clientHeight;
      const y0 = 64 + Math.random() * (gh - 120);
      el.style.transform = `translate(0, ${y0}px)`; el.style.opacity = '0';
      reach.appendChild(el);
      await wait(30); el.style.opacity = '1';
      await wait(900); if (!alive()) { el.remove(); return; }
      const laneEl = $$('.reach__lane', reach)[lanes[a[1]]]; const lr = laneEl.getBoundingClientRect(); const gr = reach.getBoundingClientRect();
      el.classList.add(`is-${a[1]}`);
      const tx = lr.left - gr.left + 10 - 18;
      const ty = lr.top - gr.top + lr.height / 2 - el.offsetHeight / 2 + 10;
      el.style.transform = `translate(${Math.max(0, tx)}px, ${ty}px)`;
      await wait(1700);
      el.style.opacity = '0'; await wait(600); el.remove();
    };
    if (!reduce) whileVisible(reach, async (alive) => { let i = 0; while (alive()) { spawn(acts[i % acts.length], alive); i += 1; await wait(1100); } });
  }

  /* ── doc pages: highlight the section in view ── */
  const toc = $$('.toc a');
  if (toc.length) {
    const map = new Map(toc.map((a) => [a.getAttribute('href').slice(1), a]));
    const to = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { toc.forEach((a) => a.classList.remove('is-on')); map.get(e.target.id)?.classList.add('is-on'); } }), { rootMargin: '-30% 0px -60% 0px' });
    map.forEach((_, id) => { const el = document.getElementById(id); if (el) to.observe(el); });
  }

  /* ── copy buttons ── */
  $$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = t; }, 1400); } catch { /* clipboard blocked */ }
  }));
})();
