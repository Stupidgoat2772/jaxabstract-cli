# Jaxabstract Output Host

`output.html` is the renderer surface used by Jaxabstract. It is not a
control UI. It hosts the MilkDrop/butterchurn renderer, native app bridge,
optional media overlays, and the terminal background surface.

For normal use, launch the Tauri app:

```bash
npm install
npm run output
```

For Linux user install:

```bash
npm run install:linux
jaxabstract
```

The Linux desktop launcher is a `.desktop` entry installed to
`~/.local/share/applications`.

## Install Modes

Fresh install, no media pack:

```bash
npm run install:linux
```

Install a rice/media pack from a URL:

```bash
npm run install:linux -- --with-rice https://example.com/media.json
```

Example using Damian's `rice1` pack:

```bash
npm run install:linux -- --with-rice https://raw.githubusercontent.com/Stupidgoat2772/jaxabstract/packs/rice1.json
```

Reset config back to a clean install:

```bash
npm run install:linux -- --fresh --reset-config
```

The installer writes:

```text
~/.local/bin/jaxabstract
~/.local/share/applications/app.jaxabstract.desktop
~/.config/jaxabstract/output.config.json
~/.config/jaxabstract/media.json
```

## Config Loading

Native app mode:

- output config: `~/.config/jaxabstract/output.config.json`
- media config: `~/.config/jaxabstract/media.json`
- fallback media config: `web/media/media.json`

Browser/WebView mode:

- output config: `output.config.json` or `?config=/path/to/config.json`
- media config: `media/media.json` or `?media_config=/path/to/media.json`

The packaged default media manifest is intentionally empty. Optional packs are
remote JSON manifests. They are not present in the package unless the user opts
in and the installer writes one to `~/.config/jaxabstract/media.json`.

## URL Contract

```text
output.html
output.html?profile=rice1
output.html?preset=random
output.html?preset=Geiss
output.html?media=off
output.html?locked=on
output.html?config=/path/to/output.config.json
output.html?media_config=https://example.com/media.json
```

Serve the folder and point any browser/WebView/display view at:

```text
http://127.0.0.1:8767/output.html
```

## Output Config

Default:

```json
{
  "profile": null,
  "preset": "random",
  "media": true,
  "audio_source": "native",
  "locked": false,
  "preset_interval_sec": 300,
  "preset_blend_sec": 2.7,
  "terminal": {
    "font_family": "'JetBrains Mono', 'Cascadia Mono', 'Fira Code', 'DejaVu Sans Mono', ui-monospace, monospace",
    "font_size": 15,
    "line_height": 1.15
  },
  "profiles": {}
}
```

`preset_interval_sec` controls timed shader rotation. Default is 300 seconds.
`preset_blend_sec` controls crossfade time.

`terminal.font_family` is a preference list. It does not require the user to
have any one font installed.

## Shader Rules

Shader rules are per profile:

```json
{
  "profiles": {
    "rice1": {
      "shaders": {
        "allow_random": true,
        "allow": [],
        "deny": [],
        "favorites": {}
      }
    }
  }
}
```

`allow_random` defaults on. With it on, allow/deny lists can be curated without
changing rotation. With it off, the allow list becomes authoritative if it has
entries; otherwise the deny list removes entries from the full pool.

`favorites` is a map of shader name to extra weighted-random tickets.

## Media Config

Use `max_active` for per-type caps and `bucket_limits` for cross-type steady
state caps:

```json
{
  "bucket_limits": {
    "visual": 2,
    "animated": 1,
    "still": 2,
    "music": 1,
    "sound": 2,
    "audio": 1
  }
}
```

Profile overrides can replace global defaults:

```json
{
  "profiles": {
    "rice1": {
      "tags": ["rice1"],
      "bucket_limits": {
        "visual": 2,
        "animated": 1,
        "still": 2,
        "audio": 1
      }
    }
  }
}
```

Buckets are automatic tags inferred from the media type:

- video: `visual`, `animated`
- GIF/APNG image: `visual`, `animated`
- static image: `visual`, `still`
- sound: `sound`, `audio`
- music: `music`, `audio`
- video with configured audio: `audio`

Profile `tags` and `tag_limits` see both explicit tags and inferred buckets.
Bucket caps apply to the new selection on each roll. Crossfade can temporarily
exceed caps while old layers fade out.

## Audio Sources

```text
none
native
system
mic
```

In the Tauri app, `native` reads the default PulseAudio/PipeWire monitor through
the Rust backend. In a normal browser, `system` and `mic` use browser media APIs
and may require prompts.

## Terminal Emulator

The embedded shell uses xterm.js (`@xterm/xterm`) for terminal emulation in the
Tauri WebView. A Rust `portable-pty` backend opens a real pseudoterminal and
starts the user's `$SHELL`, with `TERM=xterm-256color` and
`COLORTERM=truecolor`.

Kitty and Konsole are not embedded terminal engines here. They are only targets
for the older static background helper commands.

## Shell Commands

Inside the embedded shell:

```bash
jax help
jax next
jax prev
jax random
jax list
jax allow
jax deny
jax favorite
jax favorite 3
jax clear allow
jax clear deny
jax clear favorites
jax clear all
jax allowrandom on
jax allowrandom off
jax allowrandom toggle
jax profile list
jax profile load rice1
```

## JavaScript API

The page exposes:

```js
window.JaxabstractOutput
window.jaxabstract
```

Methods:

```js
getState()
getCanvas()
getVideoStream(fps)
nextPreset(blend)
prevPreset()
randomPreset()
selectPreset(name, blend)
allowCurrentShader()
denyCurrentShader()
favoriteCurrentShader(name, bump)
clearShaderRules(kind)
loadProfile(name)
toggleMedia()
setMediaEnabled(enabled)
setLocked(locked)
setSensitivity(value)
connectMic()
connectSystem()
stopAudio()
```

Events:

```js
window.addEventListener("jaxabstract:ready", event => {})
window.addEventListener("jaxabstract:preset", event => {})
window.addEventListener("jaxabstract:profile", event => {})
window.addEventListener("jaxabstract:media", event => {})
window.addEventListener("jaxabstract:locked", event => {})
```

## postMessage API

Hosts can control the output surface without reaching into the WebView global:

```js
iframe.contentWindow.postMessage({
  type: "jaxabstract:command",
  id: "1",
  command: "loadProfile",
  args: ["rice1"]
}, "*");
```

Responses:

```js
window.addEventListener("message", event => {
  if (event.data?.type === "jaxabstract:response") {
    console.log(event.data);
  }
});
```
