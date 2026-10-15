'use strict';
// Deterministic verdict engine. The model supplies observations; every decision below is
// made in code so the outcome is auditable and reproducible.

const SEV = { high: 0, medium: 1, low: 2 };

// Independent of the model: instruction-like text transcribed from the photo is a signal.
const INJECTION_PATTERNS = [
  /ignore (all )?(previous|prior|earlier|above)/i,
  /disregard (the )?(previous|prior|earlier|above|tamper)/i,
  /(system|developer) (prompt|message|instruction)/i,
  /you are (an?|now)\b/i,
  /(report|return|answer|say|set|output|reply|conclude|verdict|state)\b[^.]{0,60}\b(no anomalies|no_visible_anomalies|passed|clean|match|verdict|json)/i,
  /do not (analyse|analyze|check|look)/i,
  /(verdict|is_pcb|device_match|photo_quality)\s*[:=]/i,
  /\{\s*"(verdict|is_pcb|device_match)"/i,
];

function scanForInstructions(texts) {
  const hits = [];
  for (const t of texts) {
    const s = String(t || '');
    if (INJECTION_PATTERNS.some((re) => re.test(s))) hits.push(s);
  }
  return hits;
}

function normKind(kind) {
  return String(kind || '').toLowerCase().replace(/[\s-]+/g, '_');
}

// ---- chip marking comparison --------------------------------------------------------------
// The reference states which part a genuine unit carries; the model reads what is actually
// printed on the chip. Those two have to be compared, or a board built from the wrong
// components reads as clean.

function normPart(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// true = matches, false = does not, null = cannot judge.
// Only a reference that is an actual part number is compared. Entries that describe a class
// ("ARM Cortex-M4 @ 180 MHz") or are explicitly marked match:false are skipped, so a
// reference that does not document a part number can never become an accusation.
//
// A reference may name more than one acceptable part, because manufacturers ship more than one
// board revision under the same model name: the Nano X MCU is STM32WB55 on revisions 1-3 and
// STM32WB35 on revision 4. Judging a genuine revision 4 board against STM32WB55 alone would
// accuse a device that is exactly what it should be, which is the one error this must never make.
function compareChip(readMarking, ref) {
  if (!ref || !ref.part || ref.match === false) return null;
  const a = normPart(readMarking);
  if (!a) return null;
  const parts = (Array.isArray(ref.part) ? ref.part : [ref.part]).map(normPart).filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((b) => a === b)) return true;
  // The model often reads the full orderable part (STM32WB55CEU6) where the reference lists
  // the family (STM32WB55). Containment covers that; short strings are not compared this way.
  const comparable = parts.filter((b) => Math.min(a.length, b.length) >= 4);
  if (!comparable.length) return null;
  return comparable.some((b) => a.includes(b) || b.includes(a));
}

// How a reference part is shown to the user, whether it is one part or a set of revisions.
function partLabel(ref) {
  if (!ref || !ref.part) return '';
  return Array.isArray(ref.part) ? ref.part.join(' or ') : String(ref.part);
}

// Does this marking name a part that is documented for SOME model in the reference data?
//
// This separates the two very different reasons a marking can fail to match:
//   - it is a real part number, but one that belongs to another model -> the board was built from
//     the wrong components. That is a genuine finding and it is reported at full severity.
//   - it matches nothing documented at all -> far more likely the model misread a tiny laser
//     etching than that someone invented a part. Accusing a device on the strength of a misread
//     would be worse than saying nothing, so that case is reported as unconfirmed.
function matchesDocumentedPart(readMarking, knownParts) {
  const a = normPart(readMarking);
  if (!a || a.length < 5) return false;
  for (const p of knownParts || []) {
    const b = normPart(p);
    if (b.length < 5) continue;
    if (a === b || a.includes(b) || b.includes(a)) return true;
  }
  return false;
}

// Wording the user reads. The model always answers in English; only the strings shown to the
// user are translated, and every one of them comes from code rather than from the model.
function translator(taxonomy, lang) {
  const t = (lang && taxonomy && taxonomy.i18n && taxonomy.i18n[lang]) || null;
  const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m));
  return {
    anomaly: (kind, def) => Object.assign({}, def, (t && t.anomalies && t.anomalies[kind]) || {}),
    verdict: (name, v) => Object.assign({}, v, (t && t.verdicts && t.verdicts[name]) || {}),
    s: (key, fallback, vars) => fill((t && t.strings && t.strings[key]) || fallback, vars),
  };
}

function buildReport({ device, observations, taxonomy, verdicts, model, elapsedMs, photos, lang, knownParts }) {
  const tr = translator(taxonomy, lang);
  const byKind = new Map(taxonomy.anomalies.map((a) => [a.kind, tr.anomaly(a.kind, a)]));
  const findings = [];
  const chips = Array.isArray(observations.chips) ? observations.chips : [];
  const components = Array.isArray(observations.components) ? observations.components : [];
  const visibleText = Array.isArray(observations.visible_text) ? observations.visible_text : [];
  const quality = String(observations.photo_quality || 'limited');
  const identity = String(observations.board_identity || 'unsure');

  // 1. model-reported anomalies, normalised against the taxonomy. Kinds the model is not offered
  //    (rule_only ones) are rejected here too, so a model cannot assert a verdict-level finding.
  for (const a of Array.isArray(observations.anomalies) ? observations.anomalies : []) {
    const kind = normKind(a.kind);
    const def = byKind.get(kind);
    if (!def || def.rule_only) continue;
    findings.push({
      kind,
      severity: def.severity,
      title: def.label,
      detail: a.detail || def.explain,
      image: Number(a.image) || 1,
      region: a.region || 'center',
      source: 'model',
    });
  }

  // 2. text that tries to steer the checker (code-side, independent of the model)
  const injections = scanForInstructions([
    ...visibleText.map((v) => (typeof v === 'string' ? v : v && v.text)),
    observations.summary,
  ]);
  if (injections.length && !findings.some((f) => f.kind === 'instruction_text_in_photo')) {
    const def = byKind.get('instruction_text_in_photo');
    findings.push({
      kind: 'instruction_text_in_photo',
      severity: def.severity,
      title: def.label,
      detail: `${def.explain} Found: "${injections[0].slice(0, 160)}"`,
      image: 1,
      region: 'center',
      source: 'rule',
    });
  }

  // 2b. known implant signatures. A specific, documented combination of silkscreen labels and
  //     structural findings is worth naming: "second PCB" undersells what the photo shows.
  const haystack = [
    ...visibleText.map((v) => (typeof v === 'string' ? v : (v && v.text) || '')),
    ...findings.map((f) => f.detail || ''),
    observations.summary || '',
  ].join(' ').toUpperCase();
  for (const sig of Array.isArray(taxonomy.signatures) ? taxonomy.signatures : []) {
    if (findings.some((f) => f.kind === 'known_implant_signature')) break;
    const need = sig.match || {};
    const hits = (need.visible_text_any || []).filter((tok) => haystack.includes(String(tok).toUpperCase()));
    if (hits.length < (need.min_text_hits || 2)) continue;
    const kinds = new Set(findings.map((f) => f.kind));
    if (need.anomalies_any && need.anomalies_any.length && !need.anomalies_any.some((k) => kinds.has(k))) continue;
    const sigDef = byKind.get('known_implant_signature') || {};
    findings.push({
      kind: 'known_implant_signature',
      severity: sig.severity || 'high',
      title: sigDef.label || sig.label,
      detail: `${sigDef.explain || sig.detail} ${tr.s('detail_signature', `Matched on: ${hits.join(', ')}.`, { hits: hits.join(', ') })}`,
      image: 1,
      region: 'center',
      source: 'rule',
      vars: { hits: hits.join(', ') },
    });
  }

  // 3. board identity (skip when the model already reported it as an anomaly)
  if (identity === 'mismatch' && !findings.some((f) => f.kind === 'board_mismatch')) {
    const def = byKind.get('board_mismatch');
    findings.push({
      kind: 'board_mismatch',
      severity: def.severity,
      title: def.label,
      detail: observations.board_identity_reason || def.explain,
      image: 1,
      region: 'center',
      source: 'model',
    });
  }

  // 4. chips: which were read, and do the markings match what the model should carry?
  const mainIds = device.chips.map((c) => c.id);
  const located = chips.filter((c) => mainIds.includes(c.id) && c.readable !== false && c.part_marking);
  const unreadable = chips.filter((c) => mainIds.includes(c.id) && (c.readable === false || !c.part_marking));
  const chipsRead = located.length > 0;

  // 4b. cross-check every marking that was read against the reference part. Without this the
  //     reference data would only ever reach the prompt and never the verdict, and a board
  //     built from the wrong components would be reported clean.
  const mismatches = [];
  for (const c of located) {
    if (findings.some((f) => f.kind === 'chip_replaced')) break;
    const ref = device.chips.find((d) => d.id === c.id);
    if (compareChip(c.part_marking, ref) !== false) continue;
    // A marking that is a documented part of another model is a swapped chip; anything else could
    // be a misread, so it is reported as unconfirmed rather than as an accusation.
    const confirmed = matchesDocumentedPart(c.part_marking, knownParts);
    mismatches.push({ read: c.part_marking, expected: partLabel(ref), id: c.id, image: c.image,
                      region: c.region, kind: confirmed ? 'chip_marking_mismatch' : 'chip_marking_unverified' });
  }
  for (const m of mismatches) {
    const def = byKind.get(m.kind);
    const key = m.kind === 'chip_marking_mismatch' ? 'detail_read' : 'detail_unverified';
    const fallback = m.kind === 'chip_marking_mismatch'
      ? `Read "${m.read}" where a genuine unit carries ${m.expected} (${m.id}). That marking belongs to a different model.`
      : `Read "${m.read}" where a genuine unit carries ${m.expected} (${m.id}). Confirm it by eye: a misread is possible.`;
    findings.push({
      kind: m.kind,
      severity: def.severity,
      title: def.label,
      detail: tr.s(key, fallback, { read: m.read, expected: m.expected, id: m.id }),
      image: Number(m.image) || 1,
      region: m.region || 'center',
      source: 'rule',
      vars: { read: m.read, expected: m.expected, id: m.id },
    });
  }

  // 5. verdict, in priority order. A real tamper signal outranks a board-identity mismatch,
  //    so the identity finding is excluded from the "any high finding" test.
  const tamperHigh = findings.some((f) => f.severity === 'high' && f.kind !== 'board_mismatch');
  let verdict;
  if (!observations.is_pcb || quality === 'unusable') verdict = 'unusable_photo';
  else if (tamperHigh) verdict = 'anomalies';
  else if (identity === 'mismatch') verdict = 'board_mismatch';
  else if (!chipsRead) verdict = 'needs_closer_look';
  else if (findings.length) verdict = 'needs_closer_look';
  else verdict = 'no_visible_anomalies';

  findings.sort((a, b) => SEV[a.severity] - SEV[b.severity]);

  const v = tr.verdict(verdict, verdicts[verdict] || verdicts.needs_closer_look);
  const meaning = String(v.meaning).replace('{device}', `${device.brandName} ${device.modelName}`);

  return {
    verdict,
    tone: v.tone,
    stamp: v.stamp,
    meaning,
    device: { brand: device.brandId, model: device.modelId, name: `${device.brandName} ${device.modelName}` },
    photo_quality: quality,
    photo_quality_reason: observations.photo_quality_reason || '',
    board_identity: identity,
    board_identity_reason: observations.board_identity_reason || '',
    chips_read: chipsRead,
    chips_unreadable: unreadable.map((c) => c.id),
    chips,
    components,
    visible_text: visibleText,
    findings,
    summary: observations.summary || '',
    retake_tips: (verdict === 'unusable_photo' || verdict === 'needs_closer_look')
      ? buildTips(device, chips, observations, tr)
      : [],
    injection_suspected: injections.length > 0,
    photos: Array.isArray(photos) ? photos : [],
    model,
    elapsed_ms: elapsedMs,
  };
}

// Advice for the next attempt. The specific tips come first: we already know which chips could
// not be read and roughly where they were, so the advice can point at them instead of repeating
// "get more light" for the fourth time.
function buildTips(device, chips, observations, tr) {
  const tips = [];
  for (const c of device.chips) {
    const seen = chips.find((o) => o.id === c.id);
    if (seen && seen.readable !== false && seen.part_marking) continue;
    const what = c.role || `${c.id} chip`;
    const where = seen && seen.region
      ? tr.s('tip_where', ` Last seen around the ${seen.region}.`, { region: seen.region })
      : '';
    tips.push(tr.s('tip_chip', `Get the ${what} in focus so its marking can be read.${where}`, { role: what, where }));
  }
  for (const t of Array.isArray(observations.retake_tips) ? observations.retake_tips : []) {
    if (typeof t === 'string' && t && !tips.includes(t)) tips.push(t);
  }
  if (!tips.length) tips.push(...defaultTips(device, tr));
  return tips.slice(0, 6);
}

function defaultTips(device, tr) {
  const tips = [
    tr.s('tip_light', 'Shoot in bright, even light so the whole main board is visible.'),
    tr.s('tip_focus', 'Get the largest chip and the secure element in focus so their markings can be read.'),
    tr.s('tip_both_sides', 'Photograph both sides of the board and the area around the battery and any flex cables.'),
  ];
  if (device.forbid.includes('second PCB')) {
    tips.push(tr.s('tip_case', 'Include the whole inside of the case so an extra board cannot hide out of frame.'));
  }
  return tips;
}

// Re-word an already-built report for another language.
//
// The report is stored once, in English, because the facts in it (the verdict, the finding
// kinds, the chips, the photo hashes) do not depend on language. Only the wording does. So a
// report produced in one language can be shown in another without calling the model again.
function localize(report, taxonomy, lang, device) {
  if (!lang || !taxonomy || !taxonomy.i18n || !taxonomy.i18n[lang]) return report;
  const tr = translator(taxonomy, lang);
  const base = (taxonomy.verdicts && taxonomy.verdicts[report.verdict]) || (taxonomy.verdicts || {}).needs_closer_look;
  const v = base ? tr.verdict(report.verdict, base) : null;

  const findings = (report.findings || []).map((f) => {
    const def = (taxonomy.anomalies || []).find((a) => a.kind === f.kind);
    if (!def) return f;
    const t = tr.anomaly(f.kind, def);
    let detail = t.explain || f.detail;
    if (f.kind === 'chip_marking_mismatch' && f.vars) {
      detail += ' ' + tr.s('detail_read', `Read "${f.vars.read}" where a genuine unit carries ${f.vars.expected} (${f.vars.id}). That marking belongs to a different model.`, f.vars);
    } else if (f.kind === 'chip_marking_unverified' && f.vars) {
      detail += ' ' + tr.s('detail_unverified', `Read "${f.vars.read}" where a genuine unit carries ${f.vars.expected} (${f.vars.id}). Confirm it by eye: a misread is possible.`, f.vars);
    } else if (f.kind === 'known_implant_signature' && f.vars) {
      detail += ' ' + tr.s('detail_signature', `Matched on: ${f.vars.hits}.`, f.vars);
    }
    return { ...f, title: t.label || f.title, detail };
  });

  let tips = report.retake_tips || [];
  if (tips.length && device) {
    const generated = buildTips(device, report.chips || [], { retake_tips: [] }, tr);
    tips = generated.length ? generated : defaultTips(device, tr);
  }

  return {
    ...report,
    stamp: v ? v.stamp : report.stamp,
    meaning: v ? String(v.meaning).replace('{device}', report.device ? report.device.name : '') : report.meaning,
    findings,
    retake_tips: tips,
  };
}

module.exports = { buildReport, localize, scanForInstructions, compareChip, normPart, partLabel };
