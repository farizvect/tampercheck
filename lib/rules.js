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

function buildReport({ device, observations, taxonomy, verdicts, model, elapsedMs }) {
  const byKind = new Map(taxonomy.anomalies.map((a) => [a.kind, a]));
  const findings = [];
  const chips = Array.isArray(observations.chips) ? observations.chips : [];
  const components = Array.isArray(observations.components) ? observations.components : [];
  const visibleText = Array.isArray(observations.visible_text) ? observations.visible_text : [];
  const quality = String(observations.photo_quality || 'limited');
  const identity = String(observations.board_identity || 'unsure');

  // 1. model-reported anomalies, normalised against the taxonomy
  for (const a of Array.isArray(observations.anomalies) ? observations.anomalies : []) {
    const kind = normKind(a.kind);
    const def = byKind.get(kind);
    if (!def) continue;
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

  // 4. chips readable?
  const mainIds = device.chips.map((c) => c.id);
  const located = chips.filter((c) => mainIds.includes(c.id) && c.readable !== false && c.part_marking);
  const unreadable = chips.filter((c) => mainIds.includes(c.id) && (c.readable === false || !c.part_marking));
  const chipsRead = located.length > 0;

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

  const v = verdicts[verdict] || verdicts.needs_closer_look;
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
    retake_tips: verdict === 'unusable_photo' || verdict === 'needs_closer_look'
      ? (Array.isArray(observations.retake_tips) && observations.retake_tips.length
        ? observations.retake_tips
        : defaultTips(device))
      : [],
    injection_suspected: injections.length > 0,
    model,
    elapsed_ms: elapsedMs,
  };
}

function defaultTips(device) {
  const tips = [
    'Shoot in bright, even light so the whole main board is visible.',
    'Get the largest chip and the secure element in focus so their markings can be read.',
    'Photograph both sides of the board and the area around the battery and any flex cables.',
  ];
  if (device.forbid.includes('second PCB')) tips.push('Include the whole inside of the case so an extra board cannot hide out of frame.');
  return tips;
}

module.exports = { buildReport, scanForInstructions };
