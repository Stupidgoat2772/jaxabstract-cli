window.AbstractOverlay = (() => {
  "use strict";

  let container = null;
  let config = null;
  let layers = [];       // all live layers (fade_in | hold | fade_out)
  let enabled = true;
  let rollTimer = null;
  let currentProfile = null;

  const ROLL_INTERVAL = 30000; // ms between auto re-rolls

  // ---- init ------------------------------------------------------------------

  async function init(containerEl) {
    container = containerEl;
    try {
      config = await loadMediaConfig();
      currentProfile = config.default_profile ?? null;
    } catch (_) {
      config = { types: {}, media: [], profiles: {} };
    }
    if ((config.media ?? []).length) roll();
    scheduleRoll();
  }

  async function loadMediaConfig() {
    const tauri = window.__TAURI__;
    if (tauri?.core?.invoke) {
      return await tauri.core.invoke("load_media_config");
    }

    const params = new URLSearchParams(window.location.search);
    const configPath = params.get("media_config") || "media/media.json";
    const res = await fetch(configPath, { cache: "no-store" });
    if (!res.ok) throw new Error(`failed to load media config: ${res.status}`);
    return await res.json();
  }

  // ---- config helpers --------------------------------------------------------

  function activeProfileDef() {
    return (currentProfile && config.profiles?.[currentProfile]) ?? {};
  }

  // Merge order: global type defaults → profile type overrides → per-entry
  function resolveEntry(entry) {
    const globalTypeDef  = config.types?.[entry.type] ?? {};
    const profileTypeDef = activeProfileDef().types?.[entry.type] ?? {};
    return { ...globalTypeDef, ...profileTypeDef, ...entry };
  }

  function getPool() {
    const media = (config.media ?? []).filter(e => e.enabled !== false);
    const profile = activeProfileDef();
    if (!profile.tags?.length) return media;
    const profileTags = new Set(profile.tags.map(normalizeToken));
    return media.filter(e => effectiveTags(e).some(t => profileTags.has(t)));
  }

  function profileTagLimits() {
    return normalizeTagLimitMap(activeProfileDef().tag_limits ?? {});
  }

  function profileBucketLimits() {
    return normalizeLimitMap({ ...(config.bucket_limits ?? {}), ...(activeProfileDef().bucket_limits ?? {}) });
  }

  function passesTagLimits(entry, tagLimits, tagCounts) {
    for (const tag of effectiveTags(entry)) {
      const limit = tagLimits[tag];
      if (limit != null && (tagCounts[tag] ?? 0) >= limit) return false;
    }
    return true;
  }

  function trackLimitedTags(entry, tagLimits, tagCounts) {
    for (const tag of effectiveTags(entry)) {
      if (tagLimits[tag] != null) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
  }

  function normalizeToken(value) {
    return String(value ?? '').trim().toLowerCase();
  }

  function normalizeBucket(value) {
    return normalizeToken(value);
  }

  function normalizeLimitMap(limits = {}) {
    const out = {};
    for (const [rawKey, limit] of Object.entries(limits)) {
      out[normalizeBucket(rawKey)] = limit;
    }
    return out;
  }

  function normalizeTagLimitMap(limits = {}) {
    const out = {};
    for (const [rawKey, limit] of Object.entries(limits)) {
      out[normalizeToken(rawKey)] = limit;
    }
    return out;
  }

  function explicitTags(entry) {
    return unique((entry.tags ?? []).map(normalizeToken));
  }

  function effectiveTags(entry) {
    return unique([...explicitTags(entry), ...mediaBuckets(entry)]);
  }

  function mediaBuckets(entry) {
    const buckets = [];
    const tags = new Set(explicitTags(entry));
    const explicit = Array.isArray(entry.buckets) ? entry.buckets : [];

    if (entry.type === 'video' || entry.type === 'image') buckets.push('visual');
    if (entry.type === 'video') buckets.push('animated');
    if (entry.type === 'music') buckets.push('music', 'audio');
    if (entry.type === 'sound') buckets.push('sound', 'audio');

    if (entry.type === 'image') {
      const src = assetSrc(entry) ?? '';
      const pathname = src.split(/[?#]/, 1)[0];
      const ext = pathname.split('.').pop().toLowerCase();
      if (ext === 'gif' || ext === 'apng' || tags.has('gif') || tags.has('animated')) {
        buckets.push('animated');
      } else {
        buckets.push('still');
      }
    }

    if (
      tags.has('audio') ||
      tags.has('sound') ||
      tags.has('music') ||
      entry.has_audio === true ||
      entry.muted === false
    ) {
      buckets.push('audio');
    }

    return unique([...buckets, ...explicit.map(normalizeBucket)]);
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function passesBucketLimits(entry, bucketLimits, bucketCounts) {
    for (const bucket of mediaBuckets(entry)) {
      const limit = bucketLimits[bucket];
      if (limit != null && (bucketCounts[bucket] ?? 0) >= limit) return false;
    }
    return true;
  }

  function trackLimitedBuckets(entry, bucketLimits, bucketCounts) {
    for (const bucket of mediaBuckets(entry)) {
      if (bucketLimits[bucket] != null) bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
    }
  }

  function retireTagLimitConflicts(entry, tagLimits) {
    const limitedTags = new Set(effectiveTags(entry).filter(tag => tagLimits[tag] != null));
    if (!limitedTags.size) return;
    for (const layer of [...layers]) {
      if (effectiveTags(layer.entry).some(tag => limitedTags.has(tag))) destroy(layer);
    }
  }

  // Weighted random sample without replacement, with optional profile tag caps.
  function weightedSample(pool, count, tagLimits = {}, tagCounts = {}, bucketLimits = {}, bucketCounts = {}) {
    const remaining = pool.map(e => ({ entry: e, w: e.weight ?? 1.0 }));
    const out = [];
    for (let i = 0; i < Math.min(count, remaining.length); i++) {
      const candidates = remaining.filter(x =>
        passesTagLimits(x.entry, tagLimits, tagCounts) &&
        passesBucketLimits(x.entry, bucketLimits, bucketCounts)
      );
      if (!candidates.length) break;

      const total = candidates.reduce((s, x) => s + x.w, 0);
      let r = Math.random() * total;
      let picked = candidates[candidates.length - 1];
      for (const candidate of candidates) {
        r -= candidate.w;
        if (r <= 0) { picked = candidate; break; }
      }
      remaining.splice(remaining.indexOf(picked), 1);
      trackLimitedTags(picked.entry, tagLimits, tagCounts);
      trackLimitedBuckets(picked.entry, bucketLimits, bucketCounts);
      out.push(picked.entry);
    }
    return out;
  }

  function randInRange(range) {
    const [lo, hi] = range ?? [0.3, 0.6];
    return lo + Math.random() * (hi - lo);
  }

  // ---- roll ------------------------------------------------------------------

  function roll() {
    if (!config || !enabled) return;

    const pool = getPool();
    if (!pool.length) return;

    // Group by type
    const byType = {};
    for (const e of pool) {
      (byType[e.type] = byType[e.type] ?? []).push(e);
    }

    // Fade out all current non-outgoing layers
    layers.filter(l => l.state !== 'fade_out').forEach(fadeOut);

    // Spawn new selection — crossfade: new layers start before old finish
    const profileDef = activeProfileDef();
    const tagLimits = profileTagLimits();
    const bucketLimits = profileBucketLimits();
    const tagCounts = {};
    const bucketCounts = {};
    for (const [type, entries] of Object.entries(byType)) {
      const globalTypeDef  = config.types?.[type] ?? {};
      const profileTypeDef = profileDef.types?.[type] ?? {};
      const typeDef = { ...globalTypeDef, ...profileTypeDef };
      const maxActive = typeDef.max_active ?? 1;
      weightedSample(entries, maxActive, tagLimits, tagCounts, bucketLimits, bucketCounts)
        .forEach(entry => spawnLayer(entry, tagLimits));
    }
  }

  // ---- layer lifecycle -------------------------------------------------------

  function spawnLayer(entry, tagLimits = {}) {
    const resolved = resolveEntry(entry);
    const type = entry.type;

    if (!['video', 'image', 'sound', 'music'].includes(type)) return;
    retireTagLimitConflicts(entry, tagLimits);

    const layer = {
      id: Math.random().toString(36).slice(2),
      entry,
      resolved,
      type,
      el:       null,
      audioEl:  null,
      state:    'fade_in',
      durationTimer: null,
    };

    const fadeInSec = resolved.fade_in ?? 2.0;

    if (type === 'video' || type === 'image') {
      const el = makeVisualEl(entry, resolved);
      if (!el) return;
      layer.el = el;
      container.appendChild(el);

      // Start at 0, animate to target opacity
      el.style.opacity = '0';
      el.style.transition = `opacity ${fadeInSec}s ease`;
      const targetOpacity = randInRange(resolved.opacity_range ?? [0.2, 0.5]);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.opacity = String(targetOpacity);
      }));

    } else if (type === 'sound' || type === 'music') {
      const audioEl = makeAudioEl(entry, resolved);
      if (!audioEl) return;
      layer.audioEl = audioEl;
      audioEl.volume = 0;
      audioEl.play().catch(() => {}); // autoplay may be blocked without user gesture
      const targetVol = randInRange(resolved.volume_range ?? [0.1, 0.3]);
      fadeVolumeTo(layer, 0, targetVol, fadeInSec);
    }

    // Transition to hold after fade_in
    setTimeout(() => {
      if (layer.state === 'fade_in') layer.state = 'hold';
    }, fadeInSec * 1000);

    // Duration-based auto-fade
    if (resolved.duration != null) {
      layer.durationTimer = setTimeout(() => fadeOut(layer), resolved.duration * 1000);
    }

    layers.push(layer);
  }

  function fadeOut(layer) {
    if (layer.state === 'fade_out' || layer.state === 'gone') return;
    layer.state = 'fade_out';

    if (layer.durationTimer) { clearTimeout(layer.durationTimer); layer.durationTimer = null; }

    const fadeOutSec = layer.resolved.fade_out ?? 2.0;

    if (layer.el) {
      layer.el.style.transition = `opacity ${fadeOutSec}s ease`;
      layer.el.style.opacity = '0';
      setTimeout(() => destroy(layer), fadeOutSec * 1000 + 100);
    }

    if (layer.audioEl) {
      fadeVolumeTo(layer, layer.audioEl.volume, 0, fadeOutSec, () => destroy(layer));
    }

    // If layer has no media element yet (shouldn't happen but guard)
    if (!layer.el && !layer.audioEl) destroy(layer);
  }

  function destroy(layer) {
    layer.state = 'gone';
    if (layer.durationTimer) { clearTimeout(layer.durationTimer); layer.durationTimer = null; }
    layer.el?.remove();
    layer.el = null;
    if (layer.audioEl) {
      layer.audioEl.pause();
      layer.audioEl.src = '';
      layer.audioEl = null;
    }
    layers = layers.filter(l => l !== layer);
  }

  // ---- element factories -----------------------------------------------------

  function assetSrc(entry) {
    const src = entry.url ?? entry.file;
    if (!src) return null;
    if (/^(https?:|data:|blob:|\/)/i.test(src)) return src;
    return 'media/' + src;
  }

  function makeVisualEl(entry, resolved) {
    const src = assetSrc(entry);
    if (!src) return null;
    const pathname = src.split(/[?#]/, 1)[0];
    const ext = pathname.split('.').pop().toLowerCase();
    let el;

    if (['mp4', 'webm', 'mov'].includes(ext)) {
      el = document.createElement('video');
      el.src = src;
      el.autoplay = true;
      el.loop = resolved.loop ?? true;
      el.muted = resolved.muted ?? true;
      el.playsInline = true;
    } else if (['jpg', 'jpeg', 'png', 'webp', 'avif', 'svg', 'gif', 'apng'].includes(ext)) {
      el = document.createElement('img');
      el.src = src;
      el.alt = '';
    } else {
      return null;
    }

    el.style.mixBlendMode = resolved.blend_mode ?? 'screen';
    return el;
  }

  function makeAudioEl(entry, resolved) {
    const src = assetSrc(entry);
    if (!src) return null;
    const el = document.createElement('audio');
    el.src = src;
    el.loop = resolved.loop ?? true;
    el.volume = 0;
    return el;
  }

  // ---- volume ramp (rAF-based, no Web Audio dependency) ----------------------

  function fadeVolumeTo(layer, from, to, durationSec, onDone) {
    const startMs = performance.now();
    const durationMs = durationSec * 1000;

    function tick() {
      if (!layer.audioEl) return; // destroyed mid-fade
      const t = Math.min((performance.now() - startMs) / durationMs, 1);
      layer.audioEl.volume = Math.max(0, Math.min(1, from + (to - from) * t));
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        layer.audioEl.volume = Math.max(0, Math.min(1, to));
        onDone?.();
      }
    }
    requestAnimationFrame(tick);
  }

  // ---- scheduling ------------------------------------------------------------

  function scheduleRoll() {
    clearInterval(rollTimer);
    rollTimer = setInterval(roll, ROLL_INTERVAL);
  }

  // ---- public API ------------------------------------------------------------

  function toggle() {
    enabled = !enabled;
    if (!enabled) {
      layers.filter(l => l.state !== 'fade_out').forEach(fadeOut);
    } else {
      roll();
    }
    return enabled;
  }

  function loadProfile(name) {
    if (!config?.profiles?.[name]) return;
    currentProfile = name;
    roll();
  }

  function getProfiles() {
    return config?.profiles ?? {};
  }

  function getActiveProfile() {
    return currentProfile;
  }

  return { init, roll, toggle, loadProfile, getProfiles, getActiveProfile, isEnabled: () => enabled };
})();
