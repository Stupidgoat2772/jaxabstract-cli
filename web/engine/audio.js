window.AbstractAudio = (() => {
  "use strict";

  let ctx = null;
  let analyser = null;
  let sourceNode = null;
  let freqData = null;
  let timeData = null;
  let synthetic = null;

  // Beat detection state
  const BEAT_HISTORY = 43; // ~1s at 60fps
  const bassHistory = new Float32Array(BEAT_HISTORY);
  let beatHistIdx = 0;
  let lastBeatTime = 0;
  let beatCooldown = 120; // ms
  let sensitivity = 1.4; // multiplier over average — tunable

  const beat = { kick: false, energy: 0, bass: 0, mid: 0, high: 0 };

  function init(audioContext) {
    ctx = audioContext;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);
    return analyser;
  }

  function connectSource(node) {
    if (sourceNode) {
      try { sourceNode.disconnect(analyser); } catch (_) {}
    }
    sourceNode = node;
    node.connect(analyser);
  }

  function ensureSyntheticInput() {
    if (!ctx || !analyser) return null;
    if (synthetic) return synthetic;

    const master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(analyser);

    const bands = [
      { name: "bass", freq: 80, gain: ctx.createGain() },
      { name: "mid", freq: 700, gain: ctx.createGain() },
      { name: "high", freq: 4200, gain: ctx.createGain() },
    ];

    for (const band of bands) {
      const osc = ctx.createOscillator();
      osc.type = band.name === "bass" ? "sine" : "triangle";
      osc.frequency.value = band.freq;
      band.gain.gain.value = 0;
      osc.connect(band.gain);
      band.gain.connect(master);
      osc.start();
      band.osc = osc;
    }

    synthetic = { master, bands };
    return synthetic;
  }

  function setExternalLevels(levels) {
    const synth = ensureSyntheticInput();
    if (!synth || !levels) return;

    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    for (const band of synth.bands) {
      const value = Math.max(0, Math.min(1, Number(levels[band.name]) || 0));
      const target = value * (band.name === "bass" ? 0.65 : 0.35);
      band.gain.gain.cancelScheduledValues(ctx.currentTime);
      band.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.035);
    }
  }

  function getSourceNode() { return sourceNode; }
  function getAnalyserNode() { return analyser; }

  function bandEnergy(lo, hi) {
    // lo/hi in Hz
    const nyquist = ctx.sampleRate / 2;
    const binCount = analyser.frequencyBinCount;
    const loIdx = Math.floor((lo / nyquist) * binCount);
    const hiIdx = Math.min(Math.ceil((hi / nyquist) * binCount), binCount - 1);
    let sum = 0;
    for (let i = loIdx; i <= hiIdx; i++) sum += freqData[i];
    return sum / ((hiIdx - loIdx + 1) * 255);
  }

  function tick(now) {
    if (!analyser) return beat;
    analyser.getByteFrequencyData(freqData);
    analyser.getByteTimeDomainData(timeData);

    beat.bass  = bandEnergy(20,   250);
    beat.mid   = bandEnergy(250,  4000);
    beat.high  = bandEnergy(4000, 20000);
    beat.energy = beat.bass * 0.5 + beat.mid * 0.35 + beat.high * 0.15;

    // Kick detect: instantaneous bass vs running average
    bassHistory[beatHistIdx++ % BEAT_HISTORY] = beat.bass;
    const avg = bassHistory.reduce((a, b) => a + b, 0) / BEAT_HISTORY;
    beat.kick = (beat.bass > avg * sensitivity) && (now - lastBeatTime > beatCooldown);
    if (beat.kick) lastBeatTime = now;

    return beat;
  }

  function getFreqData() { return freqData; }
  function getTimeData() { return timeData; }

  function setSensitivity(v) { sensitivity = Math.max(1.0, Math.min(3.0, v)); }
  function getSensitivity() { return sensitivity; }

  return {
    init,
    connectSource,
    getSourceNode,
    getAnalyserNode,
    ensureSyntheticInput,
    setExternalLevels,
    tick,
    getFreqData,
    getTimeData,
    setSensitivity,
    getSensitivity
  };
})();
