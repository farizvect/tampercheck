'use strict';
// tampercheck client. Photos are prepared in the browser (bounded edge, re-encode, EXIF stripped)
// and quality-checked before the run, so a photo that cannot be judged is caught locally instead
// of costing a round trip. The run itself streams: the page shows the model working.
(() => {
  const MAX_EDGE = 2576, MAX_PIXELS = 3.5e6, SMALL_EDGE = 1024;
  const $ = (s) => document.querySelector(s);

  // The shots worth taking. Front is the one that carries the verdict.
  const SLOTS = [
    { id: 'front', name: 'front', req: true, what: 'the whole board, flat, filling the frame' },
    { id: 'back', name: 'back', req: false, what: 'the other side of the board' },
    { id: 'detail', name: 'close-up', req: false, what: 'the big chip and the secure element, markings legible' },
  ];

  // Progress is driven by which JSON fields have actually arrived, not by a guessed percentage.
  const STEPS = [
    { id: 'send', label: 'sending the photos', when: (s) => s.phase != null },
    { id: 'read', label: 'model is reading the board', when: (s) => s.connected },
    { id: 'chips', label: 'reading the chip markings', when: (s) => s.keys.includes('chips') },
    { id: 'parts', label: 'checking for added parts', when: (s) => s.keys.includes('anomalies') || s.keys.includes('components') },
    { id: 'write', label: 'writing up the findings', when: (s) => s.keys.includes('summary') },
  ];

  // Quality thresholds. Below these the model tends to come back with "unusable" or "closer look".
  const T = { brightBad: 50, brightWarn: 75, sharpBad: 120, sharpWarn: 200, minEdge: 300, lowPixels: 1e6, lowEdge: 1200 };

  let devices = null, brand = null, model = null, busy = false;
  const photos = new Map(); // slot id -> prepared photo

  // ---------- dom helpers ----------
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const fmt = (n, d = 0) => Number(n).toFixed(d);

  // ---------- device ----------
  async function loadDevices() {
    devices = await (await fetch('/api/devices')).json();
    const b = $('#brand');
    b.replaceChildren(h('option', { value: '', text: 'select brand' }),
      ...devices.brands.map((x) => h('option', { value: x.id, text: x.name })));
    b.addEventListener('change', () => {
      brand = devices.brands.find((x) => x.id === b.value) || null;
      model = null;
      const m = $('#model');
      m.disabled = !brand;
      m.replaceChildren(h('option', { value: '', text: brand ? 'select model' : '-' }),
        ...(brand ? brand.models.map((x) => h('option', { value: x.id, text: x.name })) : []));
      renderSpec(); renderSlots(); sync();
    });
    $('#model').addEventListener('change', () => {
      model = (brand && brand.models.find((x) => x.id === $('#model').value)) || null;
      $('#shot-hint').textContent = model ? shotHint() : 'Pick a device above and this tells you which shots to take.';
      renderSpec(); renderSlots(); sync();
    });
  }

  function renderSpec() {
    const box = $('#spec');
    if (!model) { box.hidden = true; box.replaceChildren(); return; }
    const chips = model.chips.map((c) => h('div', {},
      h('dt', { text: (c.role || c.id) + (c.qty ? ` ×${c.qty}` : '') }),
      h('dd', {}, c.part ? h('span', { class: 'chipname', text: c.part }) : h('span', { class: 'unknown', text: 'part number not published' }))));
    box.replaceChildren(
      h('dl', { class: 'kv' }, chips),
      h('p', { class: 'fine', text: `A genuine unit carries: ${model.expect.join(', ')}.` }),
      h('p', { class: 'fine', text: `Must never be present: ${model.forbid.join(', ')}.` }),
      brand.officialCheck ? h('p', { class: 'fine', text: `Also run the manufacturer's own check: ${brand.officialCheck}.` }) : null);
    box.hidden = false;
  }

  // ---------- image prep ----------
  async function decode(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      return new Promise((res, rej) => {
        const u = URL.createObjectURL(file), img = new Image();
        img.onload = () => { URL.revokeObjectURL(u); res(img); };
        img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('decode')); };
        img.src = u;
      });
    }
  }

  // Brightness and focus, measured on a fixed 512-wide greyscale copy so the numbers are
  // comparable between photos of different sizes.
  function measure(src) {
    const w = 512, hh = Math.max(1, Math.round((src.height * w) / src.width));
    const c = document.createElement('canvas'); c.width = w; c.height = hh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, hh);
    const px = ctx.getImageData(0, 0, w, hh).data;
    const g = new Float32Array(w * hh);
    let sum = 0;
    for (let i = 0, j = 0; i < px.length; i += 4, j++) { g[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; sum += g[j]; }
    let n = 0, s1 = 0, s2 = 0;
    for (let y = 1; y < hh - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      s1 += l; s2 += l * l; n++;
    }
    return { brightness: sum / g.length, sharpness: n ? s2 / n - (s1 / n) ** 2 : 0 };
  }

  function scaled(src, edge, q, maxPixels = Infinity) {
    const s = Math.min(1, edge / Math.max(src.width, src.height), Math.sqrt(maxPixels / (src.width * src.height)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * s)); c.height = Math.max(1, Math.round(src.height * s));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return { canvas: c, url: c.toDataURL('image/jpeg', q) };
  }

  function judge(p) {
    const issues = [];
    if (p.pixels < T.lowPixels || p.maxEdge < T.lowEdge) issues.push({ level: 'bad', text: 'low resolution — the chip markings will not be readable' });
    if (p.brightness < T.brightBad) issues.push({ level: 'bad', text: 'very dark — shoot in brighter, even light' });
    else if (p.brightness < T.brightWarn) issues.push({ level: 'warn', text: 'a bit dark — more light would help' });
    if (p.sharpness < T.sharpBad) issues.push({ level: 'bad', text: 'out of focus — hold still and let the camera focus on the chip' });
    else if (p.sharpness < T.sharpWarn) issues.push({ level: 'warn', text: 'slightly soft — brace the phone against something' });
    return issues;
  }

  async function prepare(file) {
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) throw new Error('not an image');
    const bmp = await decode(file);
    const w = bmp.width, hh = bmp.height;
    if (Math.min(w, hh) < T.minEdge) throw new Error(`too small — under ${T.minEdge} px on the short edge`);
    const full = scaled(bmp, MAX_EDGE, 0.86, MAX_PIXELS);
    const q = measure(full.canvas);
    if (bmp.close) bmp.close();
    const p = {
      data: full.url, small: scaled(full.canvas, SMALL_EDGE, 0.8).url,
      w: full.canvas.width, h: full.canvas.height, pixels: w * hh, maxEdge: Math.max(w, hh),
      brightness: q.brightness, sharpness: q.sharpness,
    };
    p.issues = judge(p);
    return p;
  }

  async function addFiles(files) {
    $('#error').hidden = true;
    for (const f of Array.from(files || [])) {
      const free = SLOTS.find((s) => !photos.has(s.id));
      if (!free) { showError('all three slots are full — remove one first'); break; }
      const p = { slot: free.id, loading: true };
      photos.set(free.id, p); renderSlots();
      try {
        const prepared = await prepare(f);
        Object.assign(p, prepared, { loading: false });
        if (model) $('#shot-hint').textContent = shotHint();
      } catch (e) {
        photos.delete(free.id);
        showError(`${free.name}: ${e.message}`);
      }
      renderSlots(); sync();
    }
  }

  function showError(msg) { const e = $('#error'); e.hidden = false; e.textContent = msg; }

  // ---------- slots ----------
  function meter(label, value, max, bad, warn) {
    const pct = Math.max(0, Math.min(100, (value / max) * 100));
    const level = value < bad ? 'bad' : value < warn ? 'warn' : 'ok';
    const bar = h('div', { class: 'bar ' + level }, h('i', { style: `width:${pct}%` }));
    if (warn < max) bar.append(h('u', { style: `left:${(warn / max) * 100}%` }));
    return h('div', { class: 'meter' }, h('span', { class: 'mlabel', text: label }), bar, h('span', { class: 'mval', text: fmt(value) }));
  }

  function renderSlots() {
    const box = $('#slots');
    box.replaceChildren(...SLOTS.map((s) => {
      const p = photos.get(s.id);
      const head = h('div', { class: 'slot-head' },
        h('span', { class: 'slot-name', text: s.name }),
        s.req ? h('span', { class: 'slot-req', text: 'required' }) : null,
        h('span', { class: 'slot-what', text: s.what }));

      let body;
      if (!p) {
        body = h('div', { class: 'slot-empty', text: 'empty — choose a photo, drop it here, or paste it' });
      } else if (p.loading) {
        body = h('div', { class: 'slot-empty', text: 'preparing…' });
      } else {
        const issues = p.issues || [];
        body = h('div', {},
          h('div', { class: 'slot-body' },
            h('img', { src: p.small, alt: `${s.name} photo` }),
            h('div', {},
              meter('brightness', p.brightness, 255, T.brightBad, T.brightWarn),
              meter('sharpness', p.sharpness, 600, T.sharpBad, T.sharpWarn),
              h('div', { class: 'meter' },
                h('span', { class: 'mlabel', text: 'size' }),
                h('span', { class: 'mval', text: `${p.w}×${p.h}` }),
                h('span', { class: 'mval', text: p.pixels >= T.lowPixels ? 'ok' : 'small' })))),
          ...issues.map((i) => h('div', { class: 'warn-line ' + i.level, text: '! ' + i.text })));
      }

      const actions = h('div', { class: 'row' },
        h('button', { type: 'button', class: 'tiny', text: p ? 'replace' : 'add', onclick: () => { photos.delete(s.id); renderSlots(); sync(); $('#file').click(); } }),
        p && !p.loading ? h('button', { type: 'button', class: 'tiny', text: 'remove', onclick: () => { photos.delete(s.id); renderSlots(); sync(); } }) : null);

      const el = h('div', { class: 'slot' + (p && !p.loading ? ' filled' : '') }, head, body, actions);
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag'));
      el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drag'); const f = e.dataTransfer.files; if (f && f.length) { photos.delete(s.id); renderSlots(); addFiles(f); } });
      return el;
    }));
  }

  function shotHint() {
    if (!model) return 'Pick a device above and this tells you which shots to take.';
    const bits = [`Photograph the ${model.name} board flat in bright, even light.`];
    if (model.forbid.includes('second PCB')) bits.push('Include the whole inside of the case so an extra board cannot hide out of frame.');
    if (model.forbid.includes('battery')) bits.push('This model has no battery — a battery would be an addition.');
    if (model.forbid.includes('radio module')) bits.push('This model has no radio — any antenna or shielded module would be an addition.');
    return bits.join(' ');
  }

  $('#pick').addEventListener('click', () => $('#file').click());
  $('#shoot').addEventListener('click', () => $('#cam').click());
  $('#file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#cam').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  document.addEventListener('paste', (e) => { const f = Array.from(e.clipboardData?.files || []); if (f.length) { e.preventDefault(); addFiles(f); } });

  // ---------- run ----------
  function sync() {
    const filled = SLOTS.filter((s) => photos.has(s.id) && !photos.get(s.id).loading);
    const ready = !!(brand && model && photos.has('front') && !photos.get('front').loading && !busy);
    $('#go').disabled = !ready;
    $('#go').textContent = busy ? 'inspecting…' : 'run inspection';
    if (busy) return;
    $('#error').hidden = true;
    const flag = filled.filter((s) => (photos.get(s.id).issues || []).some((i) => i.level === 'bad'));
    $('#estimate').textContent = !brand ? 'pick a brand to start'
      : !model ? 'pick a model to start'
      : !photos.has('front') ? 'the front photo is the one that decides the verdict'
      : flag.length ? `${flag.map((s) => s.name).join(' and ')} may be too weak to judge — you can still run it`
      : 'usually 10\u201320 s, about $0.02 of model usage';
  }

  function renderProgress(state, started) {
    const box = $('#progress');
    box.hidden = false;
    const now = Date.now();
    let active = null;
    const items = STEPS.map((st) => {
      const done = st.when(state);
      if (done) state.doneAt[st.id] = state.doneAt[st.id] || now - started;
      if (!done && !active) active = st.id;
      return { st, done, time: done ? state.doneAt[st.id] : null };
    });
    const head = h('div', { class: 'phead' },
      h('span', { text: state.label }),
      h('span', { class: 'clock', text: ((now - started) / 1000).toFixed(1) + 's' }));
    const list = h('ul', { class: 'steps' }, items.map(({ st, done, time }) => h('li', {
      class: done ? 'done' : st.id === active ? 'active' : '',
    },
      h('span', { class: 'dot', text: done ? '✓' : st.id === active ? '›' : '·' }),
      h('span', { text: st.label }),
      time != null ? h('span', { class: 't', text: (time / 1000).toFixed(1) + 's' }) : null)));
    const live = h('div', { class: 'live', text: state.summary || '' });
    box.replaceChildren(head, list, live);
  }

  $('#go').addEventListener('click', async () => {
    if (busy || !brand || !model) return;
    busy = true; sync();
    const ordered = SLOTS.filter((s) => photos.has(s.id) && !photos.get(s.id).loading)
      .map((s) => ({ side: s.id, data: photos.get(s.id).data, small: photos.get(s.id).small }));
    const state = { phase: null, connected: false, keys: [], summary: null, label: 'starting', doneAt: {} };
    const started = Date.now();
    const clock = setInterval(() => renderProgress(state, started), 200);
    renderProgress(state, started);

    const ctl = new AbortController();
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ brand: brand.id, model: model.id, images: ordered }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `http ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (ev.phase === 'error') throw new Error(ev.error + (ev.detail ? ` (${ev.detail})` : ''));
            if (ev.phase === 'done') {
              clearInterval(clock);
              $('#progress').hidden = true;
              renderReport(ev.report);
              return;
            }
            state.phase = ev.phase;
            if (ev.phase === 'connected') state.connected = true;
            if (ev.keys) state.keys = ev.keys;
            if (ev.summary != null) state.summary = ev.summary;
            state.label = ev.phase === 'queued' ? 'queued'
              : ev.phase === 'sent' ? 'sending the photos'
              : ev.phase === 'connected' ? 'waiting for the model'
              : ev.phase === 'verdict' ? 'applying the rules'
              : 'model is writing';
            renderProgress(state, started);
          }
        }
      }
      throw new Error('the stream ended without a report');
    } catch (e) {
      clearInterval(clock);
      $('#progress').hidden = true;
      showError('check failed: ' + e.message);
    } finally {
      busy = false; sync();
    }
  });

  // ---------- report ----------
  function renderReport(r) {
    const box = $('#report');
    const quality = r.photo_quality_reason ? `${r.photo_quality} (${r.photo_quality_reason})` : r.photo_quality;

    const findings = r.findings.length
      ? h('ul', { class: 'findings' }, r.findings.map((f) => h('li', { 'data-sev': f.severity },
          h('div', {},
            h('span', { class: 'ftitle', text: f.title }),
            h('span', { class: 'tag sev-' + f.severity, text: f.severity }),
            h('span', { class: 'tag' + (f.source === 'rule' ? ' rule' : ''), text: f.source })),
          h('div', { class: 'fdetail', text: f.detail }),
          h('div', { class: 'fwhere', text: `photo ${f.image} · ${f.region}` }))))
      : h('p', { class: 'fine', text: 'No anomalies were listed for this board.' });

    const chipRows = r.chips.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'chip' }), h('th', { text: 'marking read' }), h('th', { text: 'legible' }), h('th', { text: 'where' }))),
      h('tbody', {}, r.chips.map((c) => h('tr', {},
        h('td', { text: c.id }),
        h('td', { text: c.part_marking || '—' }),
        h('td', { text: c.readable === false ? 'no' : 'yes' }),
        h('td', { text: c.region || '—' }))))) : h('p', { class: 'fine', text: 'No chip markings were read.' });

    const extras = [];
    if (r.components && r.components.length) {
      extras.push(h('h3', { text: 'parts seen' }),
        h('ul', { class: 'plain' }, r.components.map((c) => h('li', { text: `${c.name || c.marking || '?'}${c.status ? ' — ' + c.status : ''}` }))));
    }
    if (r.visible_text && r.visible_text.length) {
      extras.push(h('h3', { text: 'text visible in the photo' }),
        h('div', {}, r.visible_text.map((t) => h('blockquote', { text: typeof t === 'string' ? t : t.text }))));
    }

    const permalink = `/r/${r.id}`;
    const copy = h('button', {
      type: 'button', class: 'tiny', text: 'copy link',
      onclick: async (e) => {
        const url = location.origin + permalink;
        try { await navigator.clipboard.writeText(url); e.target.textContent = 'copied'; }
        catch { e.target.textContent = url; }
        setTimeout(() => { e.target.textContent = 'copy link'; }, 1600);
      },
    });

    box.replaceChildren(...[
      h('div', { class: 'verdict ' + r.tone },
        h('div', { class: 'stamp', text: r.stamp }),
        h('p', { text: r.meaning })),
      h('p', { class: 'meta' },
        h('b', { text: r.device.name }), ` · photo quality ${quality} · board identity ${r.board_identity}`
        + ` · ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}`
        + ` · ${(r.elapsed_ms / 1000).toFixed(1)}s${r.cached ? ' · cached' : ''}`),
      r.injection_suspected
        ? h('p', { class: 'error' }, 'Text in this photo tried to instruct the checker. That is recorded as an anomaly and was not obeyed.')
        : null,
      h('h3', { text: 'findings' }), findings,
      h('h3', { text: 'summary' }), h('p', { text: r.summary }),
      r.retake_tips.length ? h('h3', { text: 'for a better result' }) : null,
      r.retake_tips.length ? h('ul', { class: 'plain' }, r.retake_tips.map((t) => h('li', { text: t }))) : null,
      h('details', {},
        h('summary', { text: 'what the model read' }),
        h('h3', { text: 'main chips' }), chipRows, ...extras),
      h('div', { class: 'report-actions' },
        h('a', { href: permalink, target: '_blank', rel: 'noopener', text: 'permalink' }),
        copy,
        h('span', { class: 'fine', text: `model ${r.model}` })),
    ].filter(Boolean));
    box.hidden = false;
    box.setAttribute('tabindex', '-1');
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    box.focus({ preventScroll: true });
  }

  loadDevices()
    .then(() => { renderSlots(); renderSpec(); sync(); })
    .catch((e) => showError('could not load the device list: ' + e.message));
})();
