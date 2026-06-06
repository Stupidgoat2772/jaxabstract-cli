(() => {
  "use strict";

  // butterchurn exposes itself as window.butterchurn (UMD)
  // butterchurn-presets as window.butterchurnPresets
  const BC   = window.butterchurn?.default ?? window.butterchurn;
  const BCP  = window.butterchurnPresets;
  const params = new URLSearchParams(window.location.search);
  const outputMode =
    document.body.dataset.jaxabstractMode === "output" ||
    params.get("mode") === "output" ||
    params.has("output");
  const DEFAULT_OUTPUT_CONFIG = {
    profile: null,
    preset: "random",
    media: true,
    audio_source: "native",
    locked: false,
    fps: 0,
    preset_interval_sec: 300,
    preset_blend_sec: 2.7,
    terminal: {
      font_family: "'JetBrains Mono', 'Cascadia Mono', 'Fira Code', 'DejaVu Sans Mono', ui-monospace, monospace",
      font_size: 15,
      line_height: 1.15
    },
    profiles: {},
  };

  const state = {
    audioCtx:    null,
    visualizer:  null,
    allPresets:  null,
    presets:     null,
    presetKeys:  [],
    presetIdx:   0,
    currentPresetName: null,
    locked:      false,
    running:     false,
    animId:      null,
    audioEl:     null,   // current <audio> element (file playback)
    audioStream: null,   // current MediaStream (mic/system)
    paused:      false,
    ready:       false,
    outputConfig: { ...DEFAULT_OUTPUT_CONFIG },
    presetTimer: null,
    externalAudioConnected: false,
    lastRenderTs: 0,
  };

  // ---- boot ----------------------------------------------------------------

  async function boot() {
    document.body.classList.toggle("output-mode", outputMode);
    state.outputConfig = await loadOutputConfig();

    // Auto-start visuals immediately — no splash, no gate
    launchVisuals();

    document.getElementById("btn-mic")?.addEventListener("click", connectMic);
    document.getElementById("btn-system")?.addEventListener("click", connectSystem);
    document.getElementById("btn-play")?.addEventListener("click", togglePause);
    document.getElementById("btn-stop")?.addEventListener("click", stopAudio);
    document.getElementById("file-input")?.addEventListener("change", (e) => {
      if (e.target.files[0]) connectFile(e.target.files[0]);
    });

    // Drag-drop .milk preset files
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      const file = Array.from(e.dataTransfer.files).find((f) => f.name.endsWith(".milk"));
      if (file) loadMilkFile(file);
    });

    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    exposeOutputApi();
  }

  async function loadOutputConfig() {
    const nativeConfig = await loadNativeOutputConfig();
    if (nativeConfig) return applyQueryOverrides(mergeOutputConfig(nativeConfig));

    if (!outputMode) return { ...DEFAULT_OUTPUT_CONFIG };

    const configPath = params.get("config") || "output.config.json";
    let fileConfig = {};
    try {
      const res = await fetch(configPath, { cache: "no-store" });
      if (res.ok) fileConfig = await res.json();
    } catch (_) {}

    return applyQueryOverrides(mergeOutputConfig(fileConfig));
  }

  function mergeOutputConfig(config = {}) {
    return {
      ...DEFAULT_OUTPUT_CONFIG,
      ...config,
      terminal: {
        ...DEFAULT_OUTPUT_CONFIG.terminal,
        ...(config.terminal ?? {})
      },
      profiles: config.profiles ?? DEFAULT_OUTPUT_CONFIG.profiles,
    };
  }

  async function loadNativeOutputConfig() {
    try {
      const tauri = window.__TAURI__;
      if (!tauri?.core?.invoke) return null;
      return await tauri.core.invoke("load_output_config");
    } catch (_) {
      return null;
    }
  }

  function applyQueryOverrides(config) {
    const next = { ...config };
    if (params.has("profile")) next.profile = params.get("profile");
    if (params.has("preset")) next.preset = params.get("preset");
    if (params.has("media")) next.media = !["0", "false", "off"].includes(params.get("media"));
    if (params.has("audio_source")) next.audio_source = params.get("audio_source");
    if (params.has("locked")) next.locked = ["1", "true", "on"].includes(params.get("locked"));
    if (params.has("fps")) next.fps = Number(params.get("fps"));
    if (params.has("preset_interval_sec")) next.preset_interval_sec = Number(params.get("preset_interval_sec"));
    if (params.has("preset_blend_sec")) next.preset_blend_sec = Number(params.get("preset_blend_sec"));
    return next;
  }

  // ---- visuals-first launch ------------------------------------------------

  async function launchVisuals() {
    const canvas = document.getElementById("viz");
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;

    // AudioContext created lazily — page-load contexts are suspended by browsers.
    // We create it here but immediately suspend until first audio source connects.
    // butterchurn still initialises fine with a suspended context.
    state.audioCtx = new AudioContext();
    AbstractAudio.init(state.audioCtx);

    if (!BC) {
      console.warn("butterchurn not loaded — falling back to fractal renderer");
      fallbackRenderer(canvas);
    } else {
      state.visualizer = BC.createVisualizer(state.audioCtx, canvas, {
        width:  canvas.width,
        height: canvas.height,
      });
      state.externalAudioConnected = false;
      if (window.butterchurnExtraImages?.getImages) {
        state.visualizer.loadExtraImages(window.butterchurnExtraImages.getImages());
      }
      loadPresets();
      randomPreset();
    }

    await AbstractOverlay.init(document.getElementById("overlays"));
    applyStartupOptions();

    window.addEventListener("resize", () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      state.visualizer?.setRendererSize?.(canvas.width, canvas.height);
    });

    state.running = true;
    state.ready = true;
    startPresetTimer();
    autoConnectAudio();
    emit("ready", getPublicState());
    requestAnimationFrame(render);
  }

  // Shared audio connect — called after stream/source is ready within a gesture
  async function connectAudioSource(getStreamFn) {
    stopAudio();
    // Create fresh AudioContext within the user gesture — guarantees it starts running
    if (state.audioCtx) { try { state.audioCtx.close(); } catch (_) {} }
    state.audioCtx = new AudioContext();
    AbstractAudio.init(state.audioCtx);

    // Reinit butterchurn with the new context so it can hear audio
    const canvas = document.getElementById("viz");
    if (BC) {
      state.visualizer = BC.createVisualizer(state.audioCtx, canvas, {
        width: canvas.width,
        height: canvas.height,
      });
      state.externalAudioConnected = false;
      if (window.butterchurnExtraImages?.getImages) {
        state.visualizer.loadExtraImages(window.butterchurnExtraImages.getImages());
      }
      const key = state.presetKeys[state.presetIdx];
      if (key && state.presets[key]) state.visualizer.loadPreset(state.presets[key], 0);
    }

    const { stream, srcNode } = await getStreamFn(state.audioCtx);
    state.audioStream = stream;
    AbstractAudio.connectSource(srcNode);

    // Our analyser is confirmed working (bars show signal).
    // Chain: srcNode → our analyser → butterchurn's analyser.
    // AnalyserNode is transparent — passes audio through.
    // Our analyser is confirmed working for all source types.
    // Pass it to butterchurn — it's an AudioNode and carries the signal through.
    const analyser = AbstractAudio.getAnalyserNode();
    if (state.visualizer?.connectAudio) {
      state.visualizer.connectAudio(analyser);
      state.externalAudioConnected = true;
    }

    setPlayUI(true, false);
  }

  // ---- audio sources -------------------------------------------------------

  async function connectMic() {
    try {
      await connectAudioSource(async (actx) => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        return { stream, srcNode: actx.createMediaStreamSource(stream) };
      });
    } catch (err) {
      reportError("Mic", err);
    }
  }

  async function connectSystem() {
    // Get mic permission first so enumerateDevices returns labels
    let permStream;
    try {
      permStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (_) {}
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (permStream) permStream.getTracks().forEach((t) => t.stop());

    const monitors = devices.filter(
      (d) => d.kind === "audioinput" &&
        /monitor|loopback|pipewire|pulse/i.test(d.label)
    );

    let deviceId = null;
    if (monitors.length === 1) {
      deviceId = monitors[0].deviceId;
    } else if (monitors.length > 1) {
      const chosen = await pickDevice(monitors);
      if (!chosen) return;
      deviceId = chosen.deviceId;
    }

    try {
      if (deviceId) {
        await connectAudioSource(async (actx) => {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: deviceId } }, video: false,
          });
          return { stream, srcNode: actx.createMediaStreamSource(stream) };
        });
      } else {
        // Chrome fallback via getDisplayMedia
        await connectAudioSource(async (actx) => {
          const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
          stream.getVideoTracks().forEach((t) => t.stop());
          if (!stream.getAudioTracks().length) {
            throw new Error("No audio tracks.\n\nOn Linux/Firefox, run:\n  pactl load-module module-loopback latency_msec=1\nthen use the Mic button.");
          }
          return { stream, srcNode: actx.createMediaStreamSource(stream) };
        });
      }
    } catch (err) {
      if (err.name !== "NotAllowedError") reportError("System audio", err);
    }
  }

  // Simple device picker — injects a small modal, resolves with chosen device
  function pickDevice(devices) {
    return new Promise((resolve) => {
      const modal = document.createElement("div");
      modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:200;display:flex;align-items:center;justify-content:center;";
      const box = document.createElement("div");
      box.style.cssText = "background:#111;border:1px solid #333;padding:24px;display:flex;flex-direction:column;gap:10px;font-family:monospace;font-size:12px;color:#ccc;min-width:300px;";
      box.innerHTML = "<div style='margin-bottom:4px;color:#fff;letter-spacing:.1em'>SELECT MONITOR SOURCE</div>";
      devices.forEach((d) => {
        const btn = document.createElement("button");
        btn.textContent = d.label || d.deviceId;
        btn.style.cssText = "background:transparent;border:1px solid #333;color:#ccc;padding:8px 12px;cursor:pointer;font-family:inherit;font-size:11px;text-align:left;";
        btn.onmouseenter = () => btn.style.borderColor = "#fff";
        btn.onmouseleave = () => btn.style.borderColor = "#333";
        btn.onclick = () => { document.body.removeChild(modal); resolve(d); };
        box.appendChild(btn);
      });
      const cancel = document.createElement("button");
      cancel.textContent = "cancel";
      cancel.style.cssText = "background:transparent;border:none;color:#555;padding:4px;cursor:pointer;font-family:inherit;font-size:10px;";
      cancel.onclick = () => { document.body.removeChild(modal); resolve(null); };
      box.appendChild(cancel);
      modal.appendChild(box);
      document.body.appendChild(modal);
    });
  }

  async function connectFile(file) {
    try {
      const url = URL.createObjectURL(file);
      await connectAudioSource(async (actx) => {
        const audio = new Audio();
        audio.src = url;
        audio.loop = true;
        const src = actx.createMediaElementSource(audio);
        src.connect(actx.destination); // so user hears it
        state.audioEl = audio;
        await audio.play();
        return { stream: null, srcNode: src };
      });
    } catch (err) {
      reportError("File", err);
    }
  }

  function reportError(label, err) {
    const message = `${label}: ${err.message}`;
    console.warn(message);
    emit("error", { label, message });
    if (!outputMode) alert(message);
  }

  function togglePause() {
    if (!state.audioEl && !state.audioStream) return;
    state.paused = !state.paused;
    if (state.audioEl) {
      state.paused ? state.audioEl.pause() : state.audioEl.play();
    } else {
      // stream: suspend/resume the AudioContext
      state.paused ? state.audioCtx.suspend() : state.audioCtx.resume();
    }
    setPlayUI(true, state.paused);
  }

  function stopAudio() {
    if (state.audioEl) { state.audioEl.pause(); state.audioEl.src = ""; state.audioEl = null; }
    if (state.audioStream) { state.audioStream.getTracks().forEach((t) => t.stop()); state.audioStream = null; }
    state.paused = false;
    setPlayUI(false, false);
  }

  function setPlayUI(active, paused) {
    const play = document.getElementById("btn-play");
    const stop = document.getElementById("btn-stop");
    if (!play || !stop) return;
    play.style.display = active ? "" : "none";
    stop.style.display = active ? "" : "none";
    play.textContent = paused ? "▶" : "⏸";
  }

  function loadPresets() {
    state.allPresets = {};

    // Merge all available preset packs
    const packs = [
      window.butterchurnPresets,
      window.butterchurnPresetsExtra,
      window.butterchurnPresetsExtra2,
      window.butterchurnPresetsMD1,
      window.butterchurnPresetsNonMinimal,
    ];
    for (const pack of packs) {
      if (pack?.getPresets) Object.assign(state.allPresets, pack.getPresets());
    }

    // Any user .milk files queued before launch
    Object.assign(state.allPresets, state._pendingPresets || {});
    state._pendingPresets = {};

    refreshPresetPool();
    console.log(`abstract: ${state.presetKeys.length}/${Object.keys(state.allPresets).length} presets loaded`);
  }

  function refreshPresetPool() {
    state.presets = {};
    const keys = Object.keys(state.allPresets ?? {}).filter(isPresetAllowedForActiveProfile);
    for (const key of keys) state.presets[key] = state.allPresets[key];

    state.presetKeys = keys;
    for (let i = state.presetKeys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.presetKeys[i], state.presetKeys[j]] = [state.presetKeys[j], state.presetKeys[i]];
    }

    if (!state.presetKeys.length) {
      state.presets = { ...(state.allPresets ?? {}) };
      state.presetKeys = Object.keys(state.presets);
    }
  }

  function isPresetAllowedForActiveProfile(name) {
    const rules = shaderRulesForProfile();
    if (rules.allow_random !== false) return true;

    const allow = rules.allow ?? [];
    const deny = rules.deny ?? [];
    const lower = name.toLowerCase();
    const inAllow = allow.some(item => lower === String(item).toLowerCase());
    const inDeny = deny.some(item => lower === String(item).toLowerCase());
    if (allow.length) return inAllow;
    if (deny.length) return !inDeny;
    return true;
  }

  function shaderRulesForProfile(profileName = getActiveProfileName()) {
    const config = ensureProfileConfig(profileName);
    config.shaders = config.shaders ?? {};
    config.shaders.allow = config.shaders.allow ?? [];
    config.shaders.deny = config.shaders.deny ?? [];
    config.shaders.favorites = config.shaders.favorites ?? {};
    if (config.shaders.allow_random == null) config.shaders.allow_random = true;
    return config.shaders;
  }

  function ensureProfileConfig(profileName = getActiveProfileName()) {
    state.outputConfig.profiles = state.outputConfig.profiles ?? {};
    state.outputConfig.profiles[profileName] = state.outputConfig.profiles[profileName] ?? {};
    return state.outputConfig.profiles[profileName];
  }

  function getActiveProfileName() {
    return AbstractOverlay.getActiveProfile() ?? state.outputConfig.profile ?? "default";
  }

  // ---- render loop ---------------------------------------------------------

  const _meter = { ctx: null, w: 60, h: 16 };

  function render(ts) {
    if (!state.running) return;
    state.animId = requestAnimationFrame(render);

    const frameMs = outputFrameMs();
    if (frameMs > 0 && state.lastRenderTs && ts - state.lastRenderTs < frameMs) return;
    state.lastRenderTs = ts;

    const beat = AbstractAudio.tick(ts);
    if (state.visualizer) state.visualizer.render();
    drawMeter(beat);

    if (!outputMode && !state.locked && beat.kick) {
      state._beatCount = (state._beatCount || 0) + 1;
      if (state._beatCount >= 60) {
        state._beatCount = 0;
        nextPreset(2.7);
      }
    }
  }

  function outputFrameMs() {
    if (!outputMode) return 0;
    const fps = Number(state.outputConfig.fps);
    if (!Number.isFinite(fps) || fps <= 0) return 0;
    return 1000 / Math.max(1, Math.min(60, fps));
  }

  function drawMeter(beat) {
    if (!_meter.ctx) {
      const c = document.getElementById("level-meter");
      if (!c) return;
      _meter.ctx = c.getContext("2d");
    }
    const { ctx, w, h } = _meter;
    ctx.clearRect(0, 0, w, h);
    // Bass / mid / high bars
    const bars = [
      { v: beat.bass,   color: beat.kick ? "#f55" : "#a33" },
      { v: beat.mid,    color: "#3a8" },
      { v: beat.high,   color: "#38f" },
      { v: beat.energy, color: "#aaa" },
    ];
    const bw = Math.floor(w / bars.length) - 1;
    bars.forEach((b, i) => {
      const bh = Math.round(b.v * h);
      ctx.fillStyle = b.color;
      ctx.fillRect(i * (bw + 1), h - bh, bw, bh);
    });
  }

  // ---- preset management ---------------------------------------------------

  function nextPreset(blend) {
    if (!state.visualizer || !state.presetKeys.length) return;
    if (!state.presetKeys.includes(state.currentPresetName)) state.presetIdx = -1;
    state.presetIdx = (state.presetIdx + 1) % state.presetKeys.length;
    applyPreset(blend ?? 2.7);
  }

  function prevPreset() {
    if (!state.visualizer || !state.presetKeys.length) return;
    if (!state.presetKeys.includes(state.currentPresetName)) state.presetIdx = 0;
    state.presetIdx = (state.presetIdx - 1 + state.presetKeys.length) % state.presetKeys.length;
    applyPreset(2.7);
  }

  function randomPreset(blend = 2.7) {
    if (!state.visualizer || !state.presetKeys.length) return;
    state.presetIdx = weightedRandomPresetIndex();
    applyPreset(blend);
  }

  function weightedRandomPresetIndex() {
    const favorites = shaderRulesForProfile().favorites ?? {};
    const weights = state.presetKeys.map(key => Math.max(1, 1 + (Number(favorites[key]) || 0)));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (!Number.isFinite(total) || total <= 0) return Math.floor(Math.random() * state.presetKeys.length);

    let pick = Math.random() * total;
    for (let i = 0; i < state.presetKeys.length; i++) {
      pick -= weights[i];
      if (pick <= 0) return i;
    }
    return state.presetKeys.length - 1;
  }

  function applyPreset(blend) {
    const key = state.presetKeys[state.presetIdx];
    state.visualizer.loadPreset(state.presets[key], blend ?? 0);
    state.currentPresetName = key;
    setPresetName(key);
    emit("preset", getPublicState());
  }

  function selectPreset(name, blend) {
    if (!state.visualizer || !state.presetKeys.length) return false;
    const idx = state.presetKeys.findIndex(key => key === name || key.toLowerCase().includes(String(name).toLowerCase()));
    if (idx < 0) return false;
    state.presetIdx = idx;
    applyPreset(blend ?? 0);
    return true;
  }

  function currentPresetName() {
    return state.currentPresetName ?? state.presetKeys[state.presetIdx] ?? null;
  }

  function addShaderRule(kind, presetName = currentPresetName()) {
    if (!presetName || !["allow", "deny"].includes(kind)) return getPublicState();
    const rules = shaderRulesForProfile();
    const otherKind = kind === "allow" ? "deny" : "allow";
    rules[kind] = uniqueList([...(rules[kind] ?? []), presetName]);
    rules[otherKind] = (rules[otherKind] ?? []).filter(name => name !== presetName);
    if (rules.allow_random === false) {
      refreshPresetPool();
      const idx = state.presetKeys.indexOf(presetName);
      if (idx >= 0) state.presetIdx = idx;
    }
    emit("config", state.outputConfig);
    return getPublicState();
  }

  function favoriteCurrentShader(presetName = currentPresetName(), bump = 1) {
    if (!presetName) return getPublicState();
    const rules = shaderRulesForProfile();
    const amount = Math.max(1, Math.floor(Number(bump) || 1));
    rules.favorites[presetName] = (Number(rules.favorites[presetName]) || 0) + amount;
    rules.deny = (rules.deny ?? []).filter(name => name !== presetName);
    if (rules.allow_random === false) refreshPresetPool();
    emit("config", state.outputConfig);
    return getPublicState();
  }

  function clearShaderRules(kind) {
    const rules = shaderRulesForProfile();
    if (kind === "allow" || kind === "deny") rules[kind] = [];
    else if (["favorite", "favorites", "fav"].includes(kind)) rules.favorites = {};
    else {
      rules.allow = [];
      rules.deny = [];
      rules.favorites = {};
    }
    if (rules.allow_random === false) refreshPresetPool();
    emit("config", state.outputConfig);
    return getPublicState();
  }

  function setAllowRandom(value) {
    const rules = shaderRulesForProfile();
    if (value === "toggle") rules.allow_random = rules.allow_random === false;
    else rules.allow_random = Boolean(value);
    refreshPresetPool();
    emit("config", state.outputConfig);
    return getPublicState();
  }

  function uniqueList(values) {
    const out = [];
    for (const value of values) {
      if (value && !out.includes(value)) out.push(value);
    }
    return out;
  }

  function setPresetName(name) {
    const el = document.getElementById("preset-name");
    if (el) el.textContent = name;
  }

  // ---- .milk file loading --------------------------------------------------

  async function loadMilkFile(file) {
    const text = await file.text();
    const name = file.name.replace(".milk", "");

    if (!state.visualizer) {
      // Queue for after launch
      state._pendingPresets = state._pendingPresets || {};
      state._pendingPresets[name] = parseMilk(text);
      return;
    }

    const preset = parseMilk(text);
    state.presets[name] = preset;
    state.presetKeys.push(name);
    state.presetIdx = state.presetKeys.length - 1;
    state.visualizer.loadPreset(preset, 2.7);
    setPresetName(name);
  }

  function parseMilk(text) {
    // butterchurn-preset-compiler handles .milk → preset object conversion
    // If available, use it; otherwise pass raw text (newer butterchurn accepts it)
    const compiler = window.butterchurnPresetCompiler;
    if (compiler?.compilePreset) return compiler.compilePreset(text);
    return { text }; // fallback — butterchurn may handle it directly
  }

  // ---- fallback (no butterchurn) -------------------------------------------

  function fallbackRenderer(canvas) {
    const ctx2d = canvas.getContext("2d");
    function draw(ts) {
      ctx2d.fillStyle = "rgba(0,0,0,0.15)";
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      const freq = AbstractAudio.getFreqData();
      if (freq) {
        const w = canvas.width / freq.length;
        ctx2d.fillStyle = "#3af";
        for (let i = 0; i < freq.length; i++) {
          const h = (freq[i] / 255) * canvas.height * 0.8;
          ctx2d.fillRect(i * w, canvas.height - h, w - 1, h);
        }
      }
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  }

  // ---- keyboard ------------------------------------------------------------

  function onKey(e) {
    if (document.body.classList.contains("shell-mode") && !e.altKey) return;

    switch (e.code) {
      case "Space":       e.preventDefault(); nextPreset(2.7);   break;
      case "ArrowRight":  nextPreset(2.7);   break;
      case "ArrowLeft":   prevPreset();       break;
      case "KeyR":        randomPreset();     break;
      case "KeyL":
        state.locked = !state.locked;
        document.body.classList.toggle("hud-locked", state.locked);
        break;
      case "KeyM":
        AbstractOverlay.toggle();
        break;
      case "KeyP":
        cycleProfile();
        break;
      case "KeyF":
        if (!document.fullscreenElement) document.documentElement.requestFullscreen();
        else document.exitFullscreen();
        break;
      case "ArrowUp":
        AbstractAudio.setSensitivity(AbstractAudio.getSensitivity() + 0.1);
        break;
      case "ArrowDown":
        AbstractAudio.setSensitivity(AbstractAudio.getSensitivity() - 0.1);
        break;
    }
  }

  // ---- profile cycling -----------------------------------------------------

  function cycleProfile() {
    const profiles = Object.keys(AbstractOverlay.getProfiles());
    if (!profiles.length) return;
    const current = AbstractOverlay.getActiveProfile();
    const idx = profiles.indexOf(current);
    const next = profiles[(idx + 1) % profiles.length];
    AbstractOverlay.loadProfile(next);
    refreshPresetPool();
    randomPreset();
    const el = document.getElementById("preset-name");
    if (el) {
      const prev = el.textContent;
      el.textContent = `profile: ${next}`;
      setTimeout(() => { el.textContent = prev; }, 2000);
    }
    emit("profile", getPublicState());
  }

  function applyStartupOptions() {
    const config = state.outputConfig;

    const profile = config.profile;
    if (profile) AbstractOverlay.loadProfile(profile);

    const preset = config.preset;
    if (preset && preset !== "random") selectPreset(preset, 0);

    if (!config.media) {
      if (AbstractOverlay.isEnabled()) AbstractOverlay.toggle();
    }

    if (config.locked) {
      state.locked = true;
      document.body.classList.add("hud-locked");
    }
  }

  function startPresetTimer() {
    clearInterval(state.presetTimer);
    const intervalSec = Number(state.outputConfig.preset_interval_sec);
    if (!outputMode || !Number.isFinite(intervalSec) || intervalSec <= 0) return;

    state.presetTimer = setInterval(() => {
      if (!state.locked) randomPreset(Number(state.outputConfig.preset_blend_sec) || 2.7);
    }, intervalSec * 1000);
  }

  function autoConnectAudio() {
    if (!outputMode) return;
    const source = String(state.outputConfig.audio_source ?? "none").toLowerCase();
    if (source === "system") connectSystem();
    if (source === "mic") connectMic();
  }

  // ---- output API ----------------------------------------------------------

  function getPublicState() {
    const canvas = document.getElementById("viz");
    return {
      ready: state.ready,
      output: outputMode,
      running: state.running,
      locked: state.locked,
      paused: state.paused,
      mediaEnabled: AbstractOverlay.isEnabled(),
      profile: AbstractOverlay.getActiveProfile(),
      preset: currentPresetName(),
      presetCount: state.presetKeys.length,
      audioSource: state.outputConfig.audio_source ?? "none",
      config: state.outputConfig,
      shaderRules: shaderRulesForProfile(),
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
    };
  }

  function setMediaEnabled(enabled) {
    const currentlyEnabled = AbstractOverlay.isEnabled();
    if (Boolean(enabled) !== currentlyEnabled) AbstractOverlay.toggle();
    emit("media", getPublicState());
    return AbstractOverlay.isEnabled();
  }

  function loadProfile(name) {
    AbstractOverlay.loadProfile(name);
    refreshPresetPool();
    randomPreset();
    emit("profile", getPublicState());
    return getPublicState();
  }

  function exposeOutputApi() {
    const api = {
      version: "0.1.0",
      getState: getPublicState,
      getCanvas: () => document.getElementById("viz"),
      getVideoStream: (fps = 60) => document.getElementById("viz")?.captureStream?.(fps) ?? null,
      nextPreset: (blend = 2.7) => { nextPreset(blend); return getPublicState(); },
      prevPreset: () => { prevPreset(); return getPublicState(); },
      randomPreset: (blend = 2.7) => { randomPreset(blend); return getPublicState(); },
      selectPreset: (name, blend = 0) => selectPreset(name, blend),
      allowCurrentShader: () => addShaderRule("allow"),
      denyCurrentShader: () => addShaderRule("deny"),
      favoriteCurrentShader,
      clearShaderRules,
      setAllowRandom,
      getProfiles: () => AbstractOverlay.getProfiles(),
      getConfig: () => state.outputConfig,
      setConfig: (config) => {
        state.outputConfig = { ...DEFAULT_OUTPUT_CONFIG, ...(config ?? {}) };
        refreshPresetPool();
        randomPreset();
        emit("config", state.outputConfig);
        return getPublicState();
      },
      loadProfile,
      toggleMedia: () => { AbstractOverlay.toggle(); emit("media", getPublicState()); return getPublicState(); },
      setMediaEnabled,
      setLocked: (locked) => {
        state.locked = Boolean(locked);
        document.body.classList.toggle("hud-locked", state.locked);
        emit("locked", getPublicState());
        return state.locked;
      },
      setSensitivity: (value) => {
        AbstractAudio.setSensitivity(Number(value));
        return AbstractAudio.getSensitivity();
      },
      setExternalAudioLevels: (levels) => {
        AbstractAudio.setExternalLevels(levels);
        if (!state.externalAudioConnected && state.visualizer?.connectAudio) {
          state.visualizer.connectAudio(AbstractAudio.getAnalyserNode());
          state.externalAudioConnected = true;
        }
        return getPublicState();
      },
      connectMic,
      connectSystem,
      stopAudio,
    };

    window.JaxabstractOutput = api;
    window.jaxabstract = api;
  }

  async function onMessage(event) {
    const data = event.data;
    if (!data || data.type !== "jaxabstract:command") return;

    const { id = null, command, args = [] } = data;
    const api = window.JaxabstractOutput;
    const replyTarget = event.source ?? window.parent;
    const replyOrigin = event.origin && event.origin !== "null" ? event.origin : "*";

    try {
      if (!api || typeof api[command] !== "function") {
        throw new Error(`unknown command: ${command}`);
      }
      const result = await api[command](...args);
      replyTarget?.postMessage({ type: "jaxabstract:response", id, ok: true, result }, replyOrigin);
    } catch (err) {
      replyTarget?.postMessage({ type: "jaxabstract:response", id, ok: false, error: err.message }, replyOrigin);
    }
  }

  function emit(name, detail, options = {}) {
    if (options.quiet) return;

    window.dispatchEvent(new CustomEvent(`jaxabstract:${name}`, { detail }));

    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: `jaxabstract:${name}`, detail }, "*");
    }
  }

  // ---- init ----------------------------------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

})();
