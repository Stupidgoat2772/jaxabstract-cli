(() => {
  "use strict";

  async function boot() {
    const tauri = window.__TAURI__;
    if (!tauri?.event || !tauri?.core) return;

    await tauri.event.listen("jaxabstract-audio-levels", (event) => {
      window.JaxabstractOutput?.setExternalAudioLevels?.(event.payload);
    });

    await tauri.event.listen("jaxabstract-audio-error", (event) => {
      console.warn("jaxabstract native audio:", event.payload);
    });

    window.addEventListener("jaxabstract:config", (event) => {
      tauri.core.invoke("save_output_config", { config: event.detail }).catch((err) => {
        console.warn("jaxabstract config save failed:", err);
      });
    });

    const start = () => {
      tauri.core.invoke("start_audio_capture").catch((err) => {
        console.warn("jaxabstract native audio start failed:", err);
      });
    };

    if (window.JaxabstractOutput?.getState?.().ready) start();
    else window.addEventListener("jaxabstract:ready", start, { once: true });

    initTerminal(tauri).catch((err) => {
      console.warn("jaxabstract terminal init failed:", err);
    });
  }

  async function initTerminal(tauri) {
    const container = document.getElementById("terminal-layer");
    if (!container || !window.Terminal) return;

    document.body.classList.add("shell-mode");
    const terminalConfig = window.JaxabstractOutput?.getConfig?.().terminal ?? {};

    const term = new window.Terminal({
      allowTransparency: true,
      allowProposedApi: false,
      cursorBlink: false,
      convertEol: true,
      fontFamily: terminalConfig.font_family ?? "'JetBrains Mono', 'Cascadia Mono', 'Fira Code', 'DejaVu Sans Mono', ui-monospace, monospace",
      fontSize: Number(terminalConfig.font_size) || 15,
      lineHeight: Number(terminalConfig.line_height) || 1.15,
      letterSpacing: 0,
      scrollback: 1000,
      theme: {
        background: "rgba(0, 0, 0, 0)",
        foreground: "#eaf6ff",
        cursor: "#9edbff",
        selectionBackground: "#2a5878",
        black: "#05070d",
        red: "#ff697c",
        green: "#76e7b6",
        yellow: "#ffd87a",
        blue: "#70beff",
        magenta: "#c499ff",
        cyan: "#87eeff",
        white: "#eef6ff",
        brightBlack: "#4a5870",
        brightRed: "#ff697c",
        brightGreen: "#76e7b6",
        brightYellow: "#ffd87a",
        brightBlue: "#70beff",
        brightMagenta: "#c499ff",
        brightCyan: "#87eeff",
        brightWhite: "#ffffff"
      }
    });

    term.open(container);
    fitTerminal(term, container);
    term.focus();

    await tauri.event.listen("jaxabstract-terminal-output", (event) => {
      term.write(event.payload);
    });

    await tauri.event.listen("jaxabstract-terminal-exit", () => {
      term.writeln("\r\n[process exited]");
    });

    await tauri.event.listen("jaxabstract-shell-command", (event) => {
      handleShellCommand(term, event.payload?.line ?? "");
    });

    term.onData((data) => {
      tauri.core.invoke("write_shell", { data }).catch((err) => {
        console.warn("jaxabstract terminal write failed:", err);
      });
    });

    await tauri.core.invoke("start_shell", {
      cols: term.cols,
      rows: term.rows,
      shell: null,
    });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitTerminal(term, container);
        tauri.core.invoke("resize_shell", {
          cols: term.cols,
          rows: term.rows,
        }).catch((err) => {
          console.warn("jaxabstract terminal resize failed:", err);
        });
      }, 80);
    });

    window.JaxabstractTerminal = {
      term,
      focus: () => term.focus(),
      resize: () => fitTerminal(term, container),
    };
  }

  function handleShellCommand(term, line) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return;

    const api = window.JaxabstractOutput;
    if (!api) {
      term.writeln("\r\n[jax] renderer not ready");
      return;
    }

    if (["help", "-h", "--help"].includes(parts[0])) {
      writeHelp(term);
      return;
    }

    if (["next", "prev", "random", "allow", "deny", "favorite", "list", "clear"].includes(parts[0])) {
      handleShaderCommand(term, api, parts);
      return;
    }

    if (parts[0] === "allowrandom") {
      handleAllowRandomCommand(term, api, parts.slice(1));
      return;
    }

    if (parts[0] === "profile") {
      handleProfileCommand(term, api, parts.slice(1));
      return;
    }

    term.writeln(`\r\n[jax] unknown command: ${line}`);
  }

  function handleShaderCommand(term, api, parts) {
    const action = parts[0] ?? "list";
    let state = api.getState();

    if (action === "next") {
      state = api.nextPreset();
      writeShortStatus(term, state, "next");
    } else if (action === "prev") {
      state = api.prevPreset();
      writeShortStatus(term, state, "prev");
    } else if (action === "random") {
      state = api.randomPreset();
      writeShortStatus(term, state, "random");
    } else if (action === "allow") {
      state = api.allowCurrentShader();
      writeRuleStatus(term, state, "allowed");
    } else if (action === "deny") {
      state = api.denyCurrentShader();
      writeRuleStatus(term, state, "denied");
    } else if (action === "favorite") {
      state = api.favoriteCurrentShader(undefined, parts[1] ?? 1);
      writeRuleStatus(term, state, "favorited");
    } else if (action === "clear") {
      state = api.clearShaderRules(parts[1] ?? "all");
      writeRuleStatus(term, state, `cleared ${parts[1] ?? "all"}`);
    } else if (action === "list") {
      writeShaderStatus(term, state, "list");
    } else {
      term.writeln(`\r\n[jax] unknown command: ${action}`);
    }
  }

  function handleAllowRandomCommand(term, api, parts) {
    const value = parts[0] ?? "status";
    let state = api.getState();

    if (value === "on" || value === "true" || value === "1") {
      state = api.setAllowRandom(true);
    } else if (value === "off" || value === "false" || value === "0") {
      state = api.setAllowRandom(false);
    } else if (value === "toggle") {
      state = api.setAllowRandom("toggle");
    } else if (value !== "status" && value !== "list") {
      term.writeln(`\r\n[jax] usage: jax allowrandom on|off|toggle|status`);
      return;
    }

    const rules = state.shaderRules ?? {};
    const mode = rules.allow_random === false ? "off" : "on";
    term.writeln(`\r\n[jax] allowrandom ${mode} | pool ${state.presetCount} | current ${state.preset ?? "(none)"}`);
  }

  function handleProfileCommand(term, api, parts) {
    const action = parts[0] ?? "list";
    const profiles = api.getProfiles?.() ?? {};
    const names = Object.keys(profiles);

    if (action === "list") {
      term.writeln(`\r\n[jax] profiles: ${names.length ? names.join(" | ") : "(none)"}`);
      term.writeln(`[jax] current: ${api.getState().profile ?? "default"}`);
      return;
    }

    const name = action === "load" ? parts[1] : action;
    if (!name) {
      term.writeln(`\r\n[jax] usage: jax profile list|load <name>`);
      return;
    }

    if (!profiles[name]) {
      term.writeln(`\r\n[jax] unknown profile: ${name}`);
      if (names.length) term.writeln(`[jax] profiles: ${names.join(" | ")}`);
      return;
    }

    const state = api.loadProfile(name);
    term.writeln(`\r\n[jax] profile ${state.profile ?? name} | pool ${state.presetCount} | current ${state.preset ?? "(none)"}`);
  }

  function writeHelp(term) {
    term.writeln("\r\n[jax] commands");
    term.writeln("  jax next | prev | random | list");
    term.writeln("  jax allow | deny | favorite [amount]");
    term.writeln("  jax clear allow|deny|favorites|all");
    term.writeln("  jax allowrandom on|off|toggle|status");
    term.writeln("  jax profile list|load <name>");
  }

  function writeShortStatus(term, state, action) {
    term.writeln(`\r\n[jax] ${action}: ${state.preset ?? "(none)"}`);
  }

  function writeRuleStatus(term, state, action) {
    const rules = state.shaderRules ?? { allow: [], deny: [], favorites: {}, allow_random: true };
    const mode = rules.allow_random === false ? "locked" : "curating";
    const allow = rules.allow?.length ?? 0;
    const deny = rules.deny?.length ?? 0;
    const favorites = Object.keys(rules.favorites ?? {}).length;
    const currentFavorite = Number(rules.favorites?.[state.preset]) || 0;
    term.writeln(`\r\n[jax] ${action}: ${state.preset ?? "(none)"} | allow ${allow} | deny ${deny} | favorites ${favorites} | current +${currentFavorite} | ${mode}`);
  }

  function writeShaderStatus(term, state, action) {
    const rules = state.shaderRules ?? { allow: [], deny: [], favorites: {}, allow_random: true };
    const allow = rules.allow ?? [];
    const deny = rules.deny ?? [];
    const favorites = Object.entries(rules.favorites ?? {})
      .filter(([, weight]) => Number(weight) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    const mode = rules.allow_random === false ? "locked" : "curating";
    term.writeln(`\r\n[jax] ${action}`);
    term.writeln(`[jax] current: ${state.preset ?? "(none)"}`);
    term.writeln(`[jax] profile: ${state.profile ?? "default"} | pool: ${state.presetCount} | mode: ${mode}`);
    term.writeln(`[jax] allow: ${allow.length ? allow.join(" | ") : "(empty)"}`);
    term.writeln(`[jax] deny: ${deny.length ? deny.join(" | ") : "(empty)"}`);
    term.writeln(`[jax] favorites: ${favorites.length ? favorites.map(([name, weight]) => `${name} +${weight}`).join(" | ") : "(empty)"}`);
  }

  function fitTerminal(term, container) {
    const rect = container.getBoundingClientRect();
    const probe = document.createElement("span");
    probe.textContent = "W";
    const config = window.JaxabstractOutput?.getConfig?.().terminal ?? {};
    const fontSize = Number(config.font_size) || 15;
    const lineHeight = Number(config.line_height) || 1.15;
    const fontFamily = config.font_family ?? "'JetBrains Mono', 'Cascadia Mono', 'Fira Code', 'DejaVu Sans Mono', ui-monospace, monospace";
    probe.style.cssText = `position:absolute;visibility:hidden;font:${fontSize}px ${fontFamily};line-height:${lineHeight}`;
    container.appendChild(probe);
    const probeRect = probe.getBoundingClientRect();
    probe.remove();

    const cellWidth = Math.max(7, probeRect.width || 9);
    const cellHeight = Math.max(14, probeRect.height || 18);
    const styles = getComputedStyle(container);
    const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);

    const cols = Math.max(20, Math.floor((rect.width - padX) / cellWidth));
    const rows = Math.max(6, Math.floor((rect.height - padY) / cellHeight));
    term.resize(cols, rows);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
