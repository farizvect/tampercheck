'use strict';
// tampercheck client. Photos are prepared in the browser (bounded edge, re-encode, EXIF stripped)
// and quality-checked before the run, so a photo that cannot be judged is caught locally instead
// of costing a round trip. The run itself streams: the page shows the model working.
(() => {
  const MAX_EDGE = 2576, MAX_PIXELS = 3.5e6, SMALL_EDGE = 1024;
  const $ = (s) => document.querySelector(s);

  // A silent script error is the worst failure mode for a page like this: nothing happens and
  // there is no clue why. Surface it where the user is already looking.
  window.addEventListener('error', (e) => {
    const el = document.getElementById('error');
    if (el) { el.hidden = false; el.textContent = 'error: ' + (e.message || 'script failed'); }
  });

  // Quality thresholds. Below these the model tends to come back with "unusable" or "closer look".
  const T = { brightBad: 50, brightWarn: 75, sharpBad: 120, sharpWarn: 200, minEdge: 300, lowPixels: 1e6, lowEdge: 1200 };

  // ---- language -----------------------------------------------------------------------------
  // Only the wording the user reads lives here. The verdict and the findings are re-worded by
  // the server from the stored report, so switching language never costs a model call.
  const L10N = {
    en: {
      language: 'language',
      lede: 'Open your hardware wallet, photograph the board, and see whether anything was added that should not be there.',
      fine_selfhosted: 'Self-hosted. Photos go to the vision model you configured and are not stored. The verdict is decided by rules in code, not by the model.',
      step_device: 'device', step_photos: 'photos', step_check: 'check',
      brand: 'brand', model: 'model', select_brand: 'select brand', select_model: 'select model',
      hint_default: 'Pick a device above and this tells you which shots to take.',
      slot_front: 'front', slot_back: 'back', slot_detail: 'close-up',
      what_front: 'the whole board, flat, filling the frame',
      what_back: 'the other side of the board',
      what_detail: 'the big chip and the secure element, markings legible',
      required: 'required', slot_empty: 'empty — choose a photo, drop it here, or paste it', preparing: 'preparing…',
      add: 'add', replace: 'replace', remove: 'remove',
      change: 'change',
      try_sample: 'try a sample photo',
      sample_busy: 'loading the sample…',
      sample_ready: 'Sample loaded. Run it to see what a real implant looks like.',
      choose_photos: 'choose photos', take_photo: 'take a photo',
      or_drag: 'or drag and drop, or paste from the clipboard',
      resized_note: 'Photos are resized to 2576 px and re-encoded in your browser, which also strips EXIF (including GPS).',
      run_inspection: 'run inspection', run_again: 'run again', inspecting: 'inspecting…',
      step_of: (d, n) => `step ${d} of ${n}`,
      meter_brightness: 'brightness', meter_sharpness: 'sharpness', meter_size: 'size',
      size_ok: 'ok', size_small: 'too small',
      warn_lowres: 'low resolution — the chip markings will not be readable',
      warn_dark: 'very dark — shoot in brighter, even light',
      warn_darkish: 'a bit dark — more light would help',
      warn_blur: 'out of focus — hold still and let the camera focus on the chip',
      warn_soft: 'slightly soft — brace the phone against something',
      err_not_image: 'not an image',
      err_small: (n) => `too small — under ${n} px on the short edge`,
      err_slots_full: 'all three slots are full — remove one first',
      err_decode: 'could not read that file',
      est_brand: 'pick a brand to start', est_model: 'pick a model to start',
      est_front: 'the front photo is the one that decides the verdict',
      est_weak: (names) => `${names} may be too weak to judge — you can still run it`,
      est_ready: 'usually 10–20 s, about $0.02 of model usage',
      est_ready_short: 'ready to check',
      starting: 'starting', phase_queued: 'queued', phase_sent: 'sending the photos',
      phase_connected: 'waiting for the model', phase_verdict: 'applying the rules', phase_writing: 'model is writing',
      step_send: 'sending the photos', step_read: 'model is reading the board',
      step_chips: 'reading the chip markings', step_parts: 'checking for added parts',
      step_write: 'writing up the findings',
      err_stream: 'the stream ended without a report',
      err_check: 'check failed: ',
      err_devices: 'could not load the device list: ',
      no_findings: 'No anomalies were listed for this board.',
      no_chips: 'No chip markings were read.',
      injection_note: 'Text in this photo tried to instruct the checker. That is recorded as an anomaly and was not obeyed.',
      findings: 'findings', summary: 'summary', better: 'for a better result',
      details: 'what the model read', details_note: 'model output, in English', main_chips: 'main chips', parts_seen: 'parts seen',
      visible_text: 'text visible in the photo', photos_based: 'photos this report is based on',
      photos_note: 'The photos themselves are not kept. The hash lets you prove which image a report was based on.',
      signature: 'signature',
      sig_note: (alg, key) => `This report is signed with ${alg}, key ${key}. Verify it with tools/verify.js or any Ed25519 implementation.`,
      permalink: 'permalink', copy_link: 'copy link', copied: 'copied',
      col_chip: 'chip', col_marking: 'marking read', col_legible: 'legible', col_where: 'where',
      col_side: 'side', col_bytes: 'bytes',
      yes: 'yes', no: 'no',
      quality_good: 'good', quality_limited: 'limited', quality_unusable: 'unusable',
      identity_match: 'match', identity_mismatch: 'mismatch', identity_unsure: 'unsure',
      sev_high: 'high', sev_medium: 'medium', sev_low: 'low',
      src_model: 'model', src_rule: 'rule',
      photo_word: 'photo', quality_word: 'photo quality', identity_word: 'board identity',
      finding_one: 'finding', finding_many: 'findings', cached_word: 'cached',
      gen_carries: (list) => `A genuine unit carries: ${list}.`,
      gen_never: (list) => `Must never be present: ${list}.`,
      gen_official: (what) => `Also run the manufacturer's own check: ${what}.`,
      not_published: 'part number not published',
      hint_photo: (name) => `Photograph the ${name} board flat in bright, even light.`,
      hint_case: 'Include the whole inside of the case so an extra board cannot hide out of frame.',
      hint_battery: 'This model has no battery — a battery would be an addition.',
      hint_radio: 'This model has no radio — any antenna or shielded module would be an addition.',
      footer: "Automated visual observations, not a certification. Photos cannot prove a device is safe: run the manufacturer's own genuine check as well.",
    },
    id: {
      language: 'bahasa',
      lede: 'Buka hardware wallet kamu, foto board-nya, dan lihat apakah ada sesuatu yang ditambahkan yang seharusnya tidak ada.',
      fine_selfhosted: 'Self-hosted. Foto dikirim ke model vision yang kamu konfigurasi dan tidak disimpan. Verdict ditentukan oleh aturan di kode, bukan oleh model.',
      step_device: 'perangkat', step_photos: 'foto', step_check: 'periksa',
      brand: 'merek', model: 'model', select_brand: 'pilih merek', select_model: 'pilih model',
      hint_default: 'Pilih perangkat di atas, nanti muncul panduan foto apa saja yang perlu diambil.',
      slot_front: 'depan', slot_back: 'belakang', slot_detail: 'close-up',
      what_front: 'seluruh board, rata, memenuhi frame',
      what_back: 'sisi lain dari board',
      what_detail: 'chip besar dan secure element, marking-nya terbaca',
      required: 'wajib', slot_empty: 'kosong — pilih foto, tarik ke sini, atau tempel', preparing: 'menyiapkan…',
      add: 'tambah', replace: 'ganti', remove: 'hapus',
      change: 'ubah',
      try_sample: 'coba foto contoh',
      sample_busy: 'memuat foto contoh…',
      sample_ready: 'Foto contoh dimuat. Jalankan untuk melihat bagaimana implant asli terlihat.',
      choose_photos: 'pilih foto', take_photo: 'ambil foto',
      or_drag: 'atau tarik dan lepas, atau tempel dari clipboard',
      resized_note: 'Foto diperkecil ke 2576 px dan di-encode ulang di browser kamu, sekaligus menghapus EXIF (termasuk GPS).',
      run_inspection: 'jalankan pemeriksaan', run_again: 'periksa lagi', inspecting: 'memeriksa…',
      step_of: (d, n) => `langkah ${d} dari ${n}`,
      meter_brightness: 'kecerahan', meter_sharpness: 'ketajaman', meter_size: 'ukuran',
      size_ok: 'cukup', size_small: 'terlalu kecil',
      warn_lowres: 'resolusi rendah — marking chip tidak akan terbaca',
      warn_dark: 'terlalu gelap — foto di cahaya yang lebih terang dan merata',
      warn_darkish: 'agak gelap — tambah cahaya akan membantu',
      warn_blur: 'tidak fokus — tahan diam dan biarkan kamera fokus ke chip',
      warn_soft: 'agak lembut — sandarkan HP ke sesuatu',
      err_not_image: 'bukan file gambar',
      err_small: (n) => `terlalu kecil — kurang dari ${n} px di sisi pendek`,
      err_slots_full: 'ketiga slot sudah terisi — hapus salah satu dulu',
      err_decode: 'file itu tidak bisa dibaca',
      est_brand: 'pilih merek dulu', est_model: 'pilih model dulu',
      est_front: 'foto depan adalah yang menentukan verdict',
      est_weak: (names) => `${names} mungkin terlalu lemah untuk dinilai — tetap bisa dijalankan`,
      est_ready: 'biasanya 10–20 detik, sekitar $0.02 pemakaian model',
      est_ready_short: 'siap diperiksa',
      starting: 'mulai', phase_queued: 'dalam antrean', phase_sent: 'mengirim foto',
      phase_connected: 'menunggu model', phase_verdict: 'menerapkan aturan', phase_writing: 'model sedang menulis',
      step_send: 'mengirim foto', step_read: 'model membaca board',
      step_chips: 'membaca marking chip', step_parts: 'memeriksa komponen tambahan',
      step_write: 'menyusun temuan',
      err_stream: 'stream berakhir tanpa laporan',
      err_check: 'pemeriksaan gagal: ',
      err_devices: 'tidak bisa memuat daftar perangkat: ',
      no_findings: 'Tidak ada anomali yang tercatat untuk board ini.',
      no_chips: 'Tidak ada marking chip yang terbaca.',
      injection_note: 'Ada teks di foto ini yang mencoba mengarahkan pemeriksa. Itu dicatat sebagai anomali dan tidak dituruti.',
      findings: 'temuan', summary: 'ringkasan', better: 'supaya hasilnya lebih baik',
      details: 'yang dibaca model', details_note: 'keluaran model, dalam bahasa Inggris', main_chips: 'chip utama', parts_seen: 'komponen terlihat',
      visible_text: 'teks yang terlihat di foto', photos_based: 'foto yang jadi dasar laporan ini',
      photos_note: 'Fotonya sendiri tidak disimpan. Hash-nya membuktikan gambar mana yang jadi dasar laporan.',
      signature: 'tanda tangan',
      sig_note: (alg, key) => `Laporan ini ditandatangani dengan ${alg}, kunci ${key}. Verifikasi pakai tools/verify.js atau implementasi Ed25519 mana pun.`,
      permalink: 'tautan permanen', copy_link: 'salin tautan', copied: 'tersalin',
      col_chip: 'chip', col_marking: 'marking terbaca', col_legible: 'terbaca', col_where: 'posisi',
      col_side: 'sisi', col_bytes: 'bita',
      yes: 'ya', no: 'tidak',
      quality_good: 'baik', quality_limited: 'terbatas', quality_unusable: 'tidak bisa dinilai',
      identity_match: 'cocok', identity_mismatch: 'tidak cocok', identity_unsure: 'belum pasti',
      sev_high: 'tinggi', sev_medium: 'sedang', sev_low: 'rendah',
      src_model: 'model', src_rule: 'aturan',
      photo_word: 'foto', quality_word: 'kualitas foto', identity_word: 'identitas board',
      finding_one: 'temuan', finding_many: 'temuan', cached_word: 'dari cache',
      gen_carries: (list) => `Unit asli membawa: ${list}.`,
      gen_never: (list) => `Tidak boleh ada: ${list}.`,
      gen_official: (what) => `Jalankan juga pengecekan resmi dari pabriknya: ${what}.`,
      not_published: 'nomor part tidak dipublikasikan',
      hint_photo: (name) => `Foto board ${name} rata di cahaya terang dan merata.`,
      hint_case: 'Sertakan seluruh bagian dalam casing supaya board tambahan tidak bisa bersembunyi di luar frame.',
      hint_battery: 'Model ini tidak punya baterai — adanya baterai berarti tambahan.',
      hint_radio: 'Model ini tidak punya radio — antena atau modul berpelindung apa pun berarti tambahan.',
      footer: 'Ini observasi visual otomatis, bukan sertifikasi. Foto tidak bisa membuktikan perangkat aman: jalankan juga pengecekan resmi dari pabriknya.',
    },
  };

  let lang = 'en';
  try {
    const saved = localStorage.getItem('tc-lang');
    const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    lang = saved || (L10N[nav] ? nav : 'en');
  } catch { /* storage may be unavailable */ }
  const t = (key, ...args) => {
    const table = L10N[lang] || L10N.en;
    const v = table[key] !== undefined ? table[key] : L10N.en[key];
    return typeof v === 'function' ? v(...args) : v;
  };
  // Enumerated values that come back from the server (severity, source, quality, identity) are
  // our own vocabulary, so they get translated too. Unknown values fall through unchanged.
  const enumLabel = (prefix, value) => {
    const key = `${prefix}_${String(value || '').toLowerCase()}`;
    const table = L10N[lang] || L10N.en;
    return table[key] !== undefined ? table[key] : L10N.en[key] !== undefined ? L10N.en[key] : value;
  };

  // The shots worth taking. Front is the one that carries the verdict.
  const SLOTS = [
    { id: 'front', nameKey: 'slot_front', req: true, whatKey: 'what_front' },
    { id: 'back', nameKey: 'slot_back', req: false, whatKey: 'what_back' },
    { id: 'detail', nameKey: 'slot_detail', req: false, whatKey: 'what_detail' },
  ];

  // Progress is driven by which JSON fields have actually arrived, not by a guessed percentage.
  const STEPS = [
    { id: 'send', labelKey: 'step_send', when: (s) => s.phase != null },
    { id: 'read', labelKey: 'step_read', when: (s) => s.connected },
    { id: 'chips', labelKey: 'step_chips', when: (s) => s.keys.includes('chips') },
    { id: 'parts', labelKey: 'step_parts', when: (s) => s.keys.includes('anomalies') || s.keys.includes('components') },
    { id: 'write', labelKey: 'step_write', when: (s) => s.keys.includes('summary') },
  ];

  let devices = null, brand = null, model = null, busy = false, lastReport = null;
  let photosOpen = false; // set when the user explicitly goes back to step 2
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

  // ---------- language plumbing ----------
  function applyStatic() {
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  }

  function setLang(next) {
    lang = L10N[next] ? next : 'en';
    try { localStorage.setItem('tc-lang', lang); } catch { /* ignore */ }
    applyStatic();
    renderSpec();
    renderSlots();
    sync();
    if (model) $('#shot-hint').textContent = shotHint();
    if (lastReport) refetchReport(lastReport.id);
  }

  // Re-word the displayed report from the server. No model call: the stored report holds the
  // facts and the wording is applied on the way out.
  async function refetchReport(id) {
    try {
      const res = await fetch(`/api/report/${id}?lang=${encodeURIComponent(lang)}`);
      if (res.ok) renderReport(await res.json());
    } catch { /* keep the current wording */ }
  }

  // ---------- device ----------
  async function loadDevices() {
    devices = await (await fetch('/api/devices')).json();
    const b = $('#brand');
    b.replaceChildren(h('option', { value: '', text: t('select_brand') }),
      ...devices.brands.map((x) => h('option', { value: x.id, text: x.name })));
    // if something already chose a device (the sample button, say), keep that choice visible
    if (brand) {
      b.value = brand.id;
      const m = $('#model');
      m.disabled = false;
      m.replaceChildren(h('option', { value: '', text: t('select_model') }),
        ...brand.models.map((x) => h('option', { value: x.id, text: x.name })));
      if (model) m.value = model.id;
    }
    b.addEventListener('change', () => {
      brand = devices.brands.find((x) => x.id === b.value) || null;
      model = null;
      lastReport = null;
      const m = $('#model');
      m.disabled = !brand;
      m.replaceChildren(h('option', { value: '', text: brand ? t('select_model') : '-' }),
        ...(brand ? brand.models.map((x) => h('option', { value: x.id, text: x.name })) : []));
      renderSpec(); renderSlots(); sync();
    });
    $('#model').addEventListener('change', () => {
      model = (brand && brand.models.find((x) => x.id === $('#model').value)) || null;
      lastReport = null;
      $('#shot-hint').textContent = model ? shotHint() : t('hint_default');
      renderSpec(); renderSlots(); sync();
    });
  }

  function renderSpec() {
    const box = $('#spec');
    if (!model) { box.hidden = true; box.replaceChildren(); return; }
    const chips = model.chips.map((c) => h('div', {},
      h('dt', { text: (c.role || c.id) + (c.qty ? ` ×${c.qty}` : '') }),
      h('dd', {}, c.part ? h('span', { class: 'chipname', text: c.part }) : h('span', { class: 'unknown', text: t('not_published') }))));
    box.replaceChildren(
      h('dl', { class: 'kv' }, chips),
      h('p', { class: 'fine', text: t('gen_carries', model.expect.join(', ')) }),
      h('p', { class: 'fine', text: t('gen_never', model.forbid.join(', ')) }),
      brand.officialCheck ? h('p', { class: 'fine', text: t('gen_official', brand.officialCheck) }) : null);
    box.hidden = false;
  }

  // ---------- image prep ----------
  async function decode(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      return new Promise((res, rej) => {
        const u = URL.createObjectURL(file), img = new Image();
        img.onload = () => { URL.revokeObjectURL(u); res(img); };
        img.onerror = () => { URL.revokeObjectURL(u); rej(new Error(t('err_decode'))); };
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
    if (p.pixels < T.lowPixels || p.maxEdge < T.lowEdge) issues.push({ level: 'bad', text: t('warn_lowres') });
    if (p.brightness < T.brightBad) issues.push({ level: 'bad', text: t('warn_dark') });
    else if (p.brightness < T.brightWarn) issues.push({ level: 'warn', text: t('warn_darkish') });
    if (p.sharpness < T.sharpBad) issues.push({ level: 'bad', text: t('warn_blur') });
    else if (p.sharpness < T.sharpWarn) issues.push({ level: 'warn', text: t('warn_soft') });
    return issues;
  }

  async function prepare(file) {
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) throw new Error(t('err_not_image'));
    const bmp = await decode(file);
    const w = bmp.width, hh = bmp.height;
    if (Math.min(w, hh) < T.minEdge) throw new Error(t('err_small', T.minEdge));
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

  // `target` names the slot to fill. Without it the first free slot is used, which is what the
  // global "choose photos" button and a clipboard paste want.
  async function addFiles(files, target) {
    $('#error').hidden = true;
    lastReport = null; // the inputs moved, so the previous result no longer describes them
    photosOpen = true;
    for (const f of Array.from(files || [])) {
      let slot;
      if (target) {
        slot = SLOTS.find((s) => s.id === target);
        target = null; // only the first file goes to the slot that was asked for
      } else {
        slot = SLOTS.find((s) => !photos.has(s.id));
      }
      if (!slot) { showError(t('err_slots_full')); break; }
      photos.delete(slot.id);
      const p = { slot: slot.id, loading: true };
      photos.set(slot.id, p); renderSlots();
      try {
        const prepared = await prepare(f);
        Object.assign(p, prepared, { loading: false });
        if (model) $('#shot-hint').textContent = shotHint();
      } catch (e) {
        photos.delete(slot.id);
        showError(`${t(slot.nameKey)}: ${e.message}`);
      }
      renderSlots(); sync();
    }
  }

  function showError(msg) { const e = $('#error'); e.hidden = false; e.textContent = msg; }

  // Which slot the next picked file should land in. null means "the first free one".
  let pendingSlot = null;
  function pickFor(slotId) { pendingSlot = slotId; $('#file').click(); }

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
        h('span', { class: 'slot-name', text: t(s.nameKey) }),
        s.req ? h('span', { class: 'slot-req', text: t('required') }) : null,
        h('span', { class: 'slot-what', text: t(s.whatKey) }));

      let body;
      if (!p) {
        body = h('button', { type: 'button', class: 'slot-empty-btn', text: t('slot_empty'), disabled: busy, onclick: () => pickFor(s.id) });
      } else if (p.loading) {
        body = h('div', { class: 'slot-empty', text: t('preparing') });
      } else {
        const issues = p.issues || [];
        const sizeOk = p.pixels >= T.lowPixels && p.maxEdge >= T.lowEdge;
        body = h('div', {},
          h('div', { class: 'slot-body' },
            h('img', { src: p.small, alt: `${t(s.nameKey)} photo` }),
            h('div', {},
              meter(t('meter_brightness'), p.brightness, 255, T.brightBad, T.brightWarn),
              meter(t('meter_sharpness'), p.sharpness, 600, T.sharpBad, T.sharpWarn),
              h('div', { class: 'meter' },
                h('span', { class: 'mlabel', text: t('meter_size') }),
                h('span', { class: 'mval', text: `${p.w}×${p.h}` }),
                h('span', { class: 'mval' + (sizeOk ? '' : ' bad'), text: sizeOk ? t('size_ok') : t('size_small') })))),
          ...issues.map((i) => h('div', { class: 'warn-line ' + i.level, text: '! ' + i.text })));
      }

      const actions = h('div', { class: 'row' },
        h('button', { type: 'button', class: 'tiny', text: p ? t('replace') : t('add'), disabled: busy, onclick: () => pickFor(s.id) }),
        p && !p.loading ? h('button', { type: 'button', class: 'tiny', text: t('remove'), disabled: busy, onclick: () => { lastReport = null; photos.delete(s.id); renderSlots(); sync(); } }) : null);

      const el = h('div', { class: 'slot' + (p && !p.loading ? ' filled' : '') }, head, body, actions);
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag'));
      el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drag'); const f = e.dataTransfer.files; if (f && f.length) { lastReport = null; addFiles(f, s.id); } });
      return el;
    }));
  }

  function shotHint() {
    if (!model) return t('hint_default');
    const bits = [t('hint_photo', model.name)];
    if (model.forbid.includes('second PCB')) bits.push(t('hint_case'));
    if (model.forbid.includes('battery')) bits.push(t('hint_battery'));
    if (model.forbid.includes('radio module')) bits.push(t('hint_radio'));
    return bits.join(' ');
  }

  $('#pick').addEventListener('click', () => pickFor(null));
  $('#shoot').addEventListener('click', () => { pendingSlot = null; $('#cam').click(); });
  $('#file').addEventListener('change', (e) => {
    const target = pendingSlot; pendingSlot = null;
    addFiles(e.target.files, target); e.target.value = '';
  });
  $('#cam').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  document.addEventListener('paste', (e) => { const f = Array.from(e.clipboardData?.files || []); if (f.length) { e.preventDefault(); addFiles(f); } });
  $('#lang').addEventListener('change', (e) => setLang(e.target.value));

  // ---------- navigation ----------
  // The rail is a way back to any step; the device panel reopens when you go to step 1.
  function gotoStep(n) {
    if (n === 1) {
      $('#p-device').classList.remove('collapsed');
      $('#sum-device').hidden = true;
      $('#edit-device').hidden = true;
      $('#p-device').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (n === 2) {
      photosOpen = true; // an explicit "change the photos" wins over the auto-collapse
      renderSlots(); sync();
      $('#p-photos').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      const target = lastReport ? $('#report') : $('#p-run');
      if (target && !target.hidden) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  for (const el of document.querySelectorAll('.rail-step')) {
    el.addEventListener('click', () => gotoStep(Number(el.dataset.goto)));
  }
  $('#edit-device').addEventListener('click', () => gotoStep(1));
  $('#edit-photos').addEventListener('click', () => gotoStep(2));

  // ---------- sample ----------
  // Lets someone see the whole flow without first opening their own device. The image is the
  // documented Ledger implant, so the result is a real one rather than a staged demo.
  $('#sample').addEventListener('click', async () => {
    if (busy) return;
    const btn = $('#sample');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('sample_busy');
    try {
      if (!devices) devices = await (await fetch('/api/devices')).json();
      if (!brand || !model) {
        const b = $('#brand'), m = $('#model');
        brand = devices.brands.find((x) => x.id === 'ledger') || devices.brands[0];
        b.value = brand.id;
        m.disabled = false;
        m.replaceChildren(h('option', { value: '', text: t('select_model') }),
          ...brand.models.map((x) => h('option', { value: x.id, text: x.name })));
        model = brand.models.find((x) => x.id === 'nano-x') || brand.models[0];
        m.value = model.id;
        renderSpec(); renderSlots(); sync();
      }
      const res = await fetch('/assets/demo/implant.jpg');
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      photos.delete('front');
      await addFiles([new File([blob], 'sample-implant.jpg', { type: 'image/jpeg' })]);
      setAction(t('sample_ready'), t('est_ready'));
      $('#p-photos').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      showError(t('err_check') + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  // ---------- run ----------
  // Where the user is in the flow. Drives the rail, the panel that is open, and the action bar.
  function currentStep() {
    if (!brand || !model) return 1;
    if (!(photos.has('front') && !photos.get('front').loading)) return 2;
    return 3;
  }

  function setAction(status, sub) {
    $('#ab-status').textContent = status || '';
    $('#ab-sub').textContent = sub || '';
  }

  function sync() {
    const filled = SLOTS.filter((s) => photos.has(s.id) && !photos.get(s.id).loading);
    const frontReady = photos.has('front') && !photos.get('front').loading;
    const deviceReady = !!(brand && model);
    const ready = deviceReady && frontReady && !busy;
    const step = busy ? 3 : currentStep();

    // rail
    for (const n of [1, 2, 3]) {
      const el = document.querySelector(`.rail-step[data-goto="${n}"]`);
      if (!el) continue;
      el.classList.toggle('done', n === 1 ? deviceReady : n === 2 ? filled.length > 0 : !!lastReport);
      el.setAttribute('aria-current', n === step ? 'step' : 'false');
      const mark = el.querySelector('.rs');
      if (mark) mark.textContent = el.classList.contains('done') ? '✓' : '';
    }

    // the device panel folds away once it is answered, so the photos are what you see next
    const dev = $('#p-device');
    const folded = deviceReady && !busy;
    dev.classList.toggle('collapsed', folded);
    $('#sum-device').hidden = !folded;
    $('#edit-device').hidden = !folded;
    if (folded) {
      const n = model.chips.length;
      $('#sum-device').replaceChildren(
        h('span', { class: 'who', text: `${brand.name} ${model.name}` }),
        document.createTextNode(` · ${n} chip${n === 1 ? '' : 's'}`));
    } else {
      $('#sum-device').replaceChildren();
    }

    // Once a report exists the photos panel folds away too, so the result is the main content
    // rather than something below a form that is no longer the point.
    const ph = $('#p-photos');
    const foldedPhotos = folded && !!lastReport && !photosOpen;
    ph.classList.toggle('collapsed', foldedPhotos);
    $('#sum-photos').hidden = !foldedPhotos;
    $('#edit-photos').hidden = !foldedPhotos;
    $('#sample').hidden = foldedPhotos;
    if (foldedPhotos) {
      const names = SLOTS.filter((s) => photos.has(s.id)).map((s) => t(s.nameKey)).join(', ');
      $('#sum-photos').replaceChildren(document.createTextNode(names));
    } else {
      $('#sum-photos').replaceChildren();
    }

    $('#go').disabled = !ready;
    $('#go').textContent = busy ? t('inspecting') : lastReport ? t('run_again') : t('run_inspection');

    // While a run is in flight the inputs are frozen: leaving them live makes it unclear whether
    // to wait or to change something.
    for (const id of ['#pick', '#shoot', '#sample', '#brand', '#model']) {
      const el = $(id);
      if (el) el.disabled = busy || (id === '#model' && !brand);
    }

    if (busy) return;
    $('#error').hidden = true;

    if (!deviceReady) { setAction(t('est_brand'), ''); return; }
    if (!frontReady) { setAction(t('est_front'), t('est_ready')); return; }
    // after a run, the bar reports the outcome rather than telling you to press the button again
    if (lastReport) {
      const n = lastReport.findings.length;
      setAction(lastReport.stamp, `${lastReport.device.name} · ${n} ${n === 1 ? t('finding_one') : t('finding_many')}`);
      return;
    }
    const flag = filled.filter((s) => (photos.get(s.id).issues || []).some((i) => i.level === 'bad'));
    if (flag.length) setAction(t('est_weak', flag.map((s) => t(s.nameKey)).join(' / ')), t('est_ready'));
    else setAction(t('est_ready_short'), t('est_ready'));
  }

  function renderProgress(state, started) {
    const box = $('#progress');
    $('#p-run').hidden = false;
    const now = Date.now();
    let active = null;
    const items = STEPS.map((st) => {
      const done = st.when(state);
      if (done) state.doneAt[st.id] = state.doneAt[st.id] || now - started;
      if (!done && !active) active = st.id;
      return { st, done, time: done ? state.doneAt[st.id] : null };
    });
    const doneCount = items.filter((i) => i.done).length;
    const elapsed = (now - started) / 1000;

    const list = h('ul', { class: 'steps' }, items.map(({ st, done, time }) => h('li', {
      class: done ? 'done' : st.id === active ? 'active' : '',
    },
      h('span', { class: 'dot', text: done ? '✓' : st.id === active ? '›' : '·' }),
      h('span', { text: t(st.labelKey) }),
      time != null ? h('span', { class: 't', text: (time / 1000).toFixed(1) + 's' }) : null)));
    const live = h('div', { class: 'live', text: state.summary || '' });
    box.replaceChildren(list, live);

    // The bar is the persistent status, so the phase and clock live there and are not repeated here.
    $('#ab-bar').style.width = Math.round((doneCount / STEPS.length) * 100) + '%';
    setAction(state.label, elapsed.toFixed(1) + 's · ' + t('step_of', doneCount, STEPS.length));
  }

  const PHASE_LABEL = {
    queued: 'phase_queued', sent: 'phase_sent', connected: 'phase_connected',
    verdict: 'phase_verdict', writing: 'phase_writing',
  };

  $('#go').addEventListener('click', async () => {
    if (busy || !brand || !model) return;
    busy = true; renderSlots(); sync();
    const ordered = SLOTS.filter((s) => photos.has(s.id) && !photos.get(s.id).loading)
      .map((s) => ({ side: s.id, data: photos.get(s.id).data, small: photos.get(s.id).small }));
    const state = { phase: null, connected: false, keys: [], summary: null, label: t('starting'), doneAt: {} };
    const started = Date.now();
    $('#ab-progress').hidden = false;
    $('#ab-bar').style.width = '0%';
    const clock = setInterval(() => renderProgress(state, started), 200);
    renderProgress(state, started);
    $('#p-run').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const ctl = new AbortController();
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ brand: brand.id, model: model.id, lang, images: ordered }),
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
              $('#p-run').hidden = true;
              $('#ab-progress').hidden = true;
              $('#progress').replaceChildren(); // the run is over; a stale step list reads as current
              photosOpen = false; // the result is the point now, so the photo form folds away
              renderReport(ev.report);
              return;
            }
            state.phase = ev.phase;
            if (ev.phase === 'connected') state.connected = true;
            if (ev.keys) state.keys = ev.keys;
            if (ev.summary != null) state.summary = ev.summary;
            state.label = t(PHASE_LABEL[ev.phase] || 'phase_writing');
            renderProgress(state, started);
          }
        }
      }
      throw new Error(t('err_stream'));
    } catch (e) {
      clearInterval(clock);
      $('#p-run').hidden = true;
      $('#ab-progress').hidden = true;
      $('#progress').replaceChildren();
      showError(t('err_check') + e.message);
    } finally {
      busy = false; renderSlots(); sync();
    }
  });

  // ---------- report ----------
  function renderReport(r) {
    lastReport = r;
    const box = $('#report');
    const quality = r.photo_quality_reason
      ? `${enumLabel('quality', r.photo_quality)} (${r.photo_quality_reason})`
      : enumLabel('quality', r.photo_quality);

    const findings = r.findings.length
      ? h('ul', { class: 'findings' }, r.findings.map((f) => h('li', { 'data-sev': f.severity },
          h('div', {},
            h('span', { class: 'ftitle', text: f.title }),
            h('span', { class: 'tag sev-' + f.severity, text: enumLabel('sev', f.severity) }),
            h('span', { class: 'tag' + (f.source === 'rule' ? ' rule' : ''), text: enumLabel('src', f.source) })),
          h('div', { class: 'fdetail', text: f.detail }),
          h('div', { class: 'fwhere', text: `${t('photo_word')} ${f.image} · ${f.region}` }))))
      : h('p', { class: 'fine', text: t('no_findings') });

    const chipRows = r.chips.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: t('col_chip') }), h('th', { text: t('col_marking') }), h('th', { text: t('col_legible') }), h('th', { text: t('col_where') }))),
      h('tbody', {}, r.chips.map((c) => h('tr', {},
        h('td', { text: c.id }),
        h('td', { text: c.part_marking || '—' }),
        h('td', { text: c.readable === false ? t('no') : t('yes') }),
        h('td', { text: c.region || '—' }))))) : h('p', { class: 'fine', text: t('no_chips') });

    const extras = [];
    if (r.components && r.components.length) {
      extras.push(h('h3', { text: t('parts_seen') }),
        h('ul', { class: 'plain' }, r.components.map((c) => h('li', { text: `${c.name || c.marking || '?'}${c.status ? ' — ' + c.status : ''}` }))));
    }
    if (r.visible_text && r.visible_text.length) {
      extras.push(h('h3', { text: t('visible_text') }),
        h('div', {}, r.visible_text.map((v) => h('blockquote', { text: typeof v === 'string' ? v : v.text }))));
    }
    if (r.photos && r.photos.length) {
      extras.push(h('h3', { text: t('photos_based') }),
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', { text: t('col_side') }), h('th', { text: 'sha256' }), h('th', { text: t('col_bytes') }))),
          h('tbody', {}, r.photos.map((p) => h('tr', {},
            h('td', { text: p.side }),
            h('td', { text: p.sha256 }),
            h('td', { class: 'num', text: String(p.bytes) }))))),
        h('p', { class: 'fine', text: t('photos_note') }));
    }
    if (r.signature) {
      extras.push(h('h3', { text: t('signature') }),
        h('p', { class: 'fine', text: t('sig_note', r.signature.algorithm, r.signature.key_id) }));
    }

    const permalink = `/r/${r.id}`;
    const copy = h('button', {
      type: 'button', class: 'tiny', text: t('copy_link'),
      onclick: async (e) => {
        const url = location.origin + permalink;
        try { await navigator.clipboard.writeText(url); e.target.textContent = t('copied'); }
        catch { e.target.textContent = url; }
        setTimeout(() => { e.target.textContent = t('copy_link'); }, 1600);
      },
    });

    box.replaceChildren(...[
      h('div', { class: 'verdict ' + r.tone },
        h('div', { class: 'stamp', text: r.stamp }),
        h('p', { text: r.meaning })),
      h('p', { class: 'meta' },
        h('b', { text: r.device.name }), ` · ${t('quality_word')} ${quality} · ${t('identity_word')} ${enumLabel('identity', r.board_identity)}`
        + ` · ${r.findings.length} ${r.findings.length === 1 ? t('finding_one') : t('finding_many')}`
        + ` · ${(r.elapsed_ms / 1000).toFixed(1)}s${r.cached ? ' · ' + t('cached_word') : ''}`),
      r.injection_suspected ? h('p', { class: 'error' }, t('injection_note')) : null,
      h('h3', { text: t('findings') }), findings,
      h('h3', { text: t('summary') }), h('p', { text: r.summary }),
      r.retake_tips.length ? h('h3', { text: t('better') }) : null,
      r.retake_tips.length ? h('ul', { class: 'plain' }, r.retake_tips.map((x) => h('li', { text: x }))) : null,
      h('details', {},
        h('summary', { text: t('details') }),
        h('p', { class: 'fine', text: t('details_note') }),
        h('h3', { text: t('main_chips') }), chipRows, ...extras),
      h('div', { class: 'report-actions' },
        h('a', { href: permalink, target: '_blank', rel: 'noopener', text: t('permalink') }),
        copy,
        h('span', { class: 'fine', text: `model ${r.model}` })),
    ].filter(Boolean));
    box.hidden = false;
    box.setAttribute('tabindex', '-1');
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    box.focus({ preventScroll: true });
  }

  // ---------- boot ----------
  $('#lang').value = lang;
  applyStatic();
  renderSlots();
  sync();

  loadDevices()
    .then(() => { renderSpec(); renderSlots(); sync(); })
    .catch((e) => showError(t('err_devices') + e.message));

  // Installable shell. The service worker caches only the static UI, never a report.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ });
    });
  }
})();
