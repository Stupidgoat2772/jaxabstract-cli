# jaxabstract-cli

Jaxabstract-cli is a Linux output host for jaxabstract: a MilkDrop-style
audio-reactive visualizer with an embedded transparent shell. The app is built
with Tauri, runs the normal user shell in a PTY, and renders jaxabstract behind
the terminal text.

The default install starts fresh: shader output only, no media pack. Damian's
`rice1` profile is an optional remote pack. It is not included in the package
or cloned project; the installer downloads it only when users pass its pack URL
to `--with-rice`.

## What It Does

- Runs a full-screen-capable jaxabstract visualizer in a native app window.
- Captures default system audio through the Linux PulseAudio/PipeWire monitor
  path and feeds bass/mid/high/energy levels into the renderer.
- Starts an embedded shell using the user's `$SHELL`.
- Keeps terminal text opaque while the renderer and media layer live behind it.
- Changes shader presets on a timer. Default: every 5 minutes.
- Lets the shell control the renderer through `jax` commands.
- Supports per-profile shader allow lists, deny lists, favorites, and weighted
  random selection.
- Supports optional media overlays: images, GIFs, videos, sounds, music, tags,
  inferred buckets, type caps, bucket caps, tag caps, blend modes, fade timing,
  and weights.
- Ships with a clean starter manifest and supports optional remote media packs.
- Can also expose the renderer as `output.html` for browser/WebView embedding.
- Includes older static terminal-background helpers for Kitty and Konsole.

## Current Portability Status

This is a source-based Linux install right now. It is not yet a universal
prebuilt npm package.

Works best on Linux systems with:

- Node.js and npm
- Rust/Cargo
- Tauri Linux build dependencies
- GTK 3 and WebKitGTK development packages
- PulseAudio tools: `pactl` and `parec`
- PipeWire users: `pipewire-pulse` or another PulseAudio compatibility layer

The installer checks for the obvious commands/libraries and warns when something
is missing.

## Install

Clone the repo, then run:

```bash
git clone https://github.com/Stupidgoat2772/jaxabstract-cli.git
cd jaxabstract-cli
npm install
npm run install:linux
```

That installs:

- command launcher: `~/.local/bin/jaxabstract-output`
- desktop launcher: `~/.local/share/applications/local.kumo.jaxabstract-output.desktop`
- user config: `~/.config/jaxabstract/output.config.json`
- user media config: `~/.config/jaxabstract/media.json`

The desktop launcher is a Linux `.desktop` entry. It is what makes the app show
up in desktop launchers/menus.

If `~/.local/bin` is not on `PATH`, add it in your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then launch:

```bash
jaxabstract-output
```

Or open **Jaxabstract Output** from the desktop launcher.

## Optional Rice Packs

Default install starts fresh with no media overlays:

```bash
npm run install:linux
```

Install a rice/media pack from a URL:

```bash
npm run install:linux -- --with-rice https://example.com/media.json
```

Example using Damian's `rice1` pack:

```bash
npm run install:linux -- --with-rice https://raw.githubusercontent.com/Stupidgoat2772/jaxabstract-cli/packs/rice1.json
```

Reset an existing install to clean starter config:

```bash
npm run install:linux -- --fresh --reset-config
```

Reset an existing install to `rice1`:

```bash
npm run install:linux -- --with-rice https://raw.githubusercontent.com/Stupidgoat2772/jaxabstract-cli/packs/rice1.json --reset-config
```

Without `--reset-config`, the installer preserves existing user config where it
can. `--with-rice <url>` intentionally updates the active media config and sets
the active profile from the pack's `default_profile` when one is provided.

## Uninstall

```bash
npm run uninstall:linux
```

This removes the launcher and `.desktop` entry. It does not delete user config
under `~/.config/jaxabstract`.

## Run From Source

```bash
npm install
npm run output
```

`npm run output` runs `tauri dev`. The installed launcher prefers a compiled
release binary if one exists at `src-tauri/target/release/jaxabstract-output`;
otherwise it falls back to `npm run output`.

Build a release binary:

```bash
npm run build
```

## Config Files

The app loads config in this order:

- output config: `~/.config/jaxabstract/output.config.json`
- media config: `~/.config/jaxabstract/media.json`
- packaged fallback media config: `web/media/media.json`

The packaged media config is intentionally empty. Optional packs are remote JSON
files. `rice1` is published on the separate `packs` branch and only written to
`~/.config/jaxabstract/media.json` when the user opts in.

## Output Config

Default `output.config.json`:

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

Important fields:

- `profile`: active profile name, or `null`.
- `preset`: `"random"` or a preset name.
- `media`: enables/disables media overlays.
- `audio_source`: `native`, `system`, `mic`, or `none`.
- `locked`: prevents accidental keyboard preset changes when enabled.
- `preset_interval_sec`: timed shader rotation interval.
- `preset_blend_sec`: shader crossfade time.
- `terminal`: font family, size, and line height for the embedded shell.
- `profiles`: per-profile shader rules.

## Shader Rules

Shader rules are stored per output profile:

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

Rules:

- `allow_random: true`: rotate across the full preset pool while you curate
  allow/deny/favorite lists.
- `allow_random: false` with an allow list: only allowed shaders rotate.
- `allow_random: false` without an allow list: all shaders except denied
  shaders rotate.
- `favorites`: map of shader name to extra random-selection weight.
- Each favorite adds one extra ticket to the weighted random pool.

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

## Media Config

Media manifests contain global type defaults, optional profile definitions, and
entries.

Minimal empty manifest:

```json
{
  "types": {},
  "default_profile": null,
  "bucket_limits": {},
  "media": [],
  "profiles": {}
}
```

Example image entry:

```json
{
  "url": "https://example.com/image.gif",
  "name": "Signal GIF",
  "type": "image",
  "tags": ["rice1", "signal", "blue", "gif"],
  "weight": 1.2
}
```

Entry fields:

- `file`: local file under `web/media/`.
- `url`: remote media URL.
- `name`: display/debug name.
- `type`: `image`, `video`, `sound`, or `music`.
- `enabled`: set `false` to disable without deleting.
- `tags`: manual tags used by profiles and caps.
- `buckets`: optional extra automatic-bucket-style labels.
- `weight`: random selection weight.
- `opacity_range`: visual opacity range.
- `volume_range`: audio volume range.
- `blend_mode`: CSS mix-blend-mode for visual overlays.
- `fade_in`, `fade_out`: seconds.
- `loop`: loop playback.
- `muted` or `has_audio`: marks video as audio-capable.

## Buckets

Buckets are inferred automatic tags based on content type:

- `image` and `video` count as `visual`.
- `video` counts as `animated`.
- GIF/APNG images count as `animated`.
- Static JPG/PNG images count as `still`.
- `sound` counts as `sound` and `audio`.
- `music` counts as `music` and `audio`.
- Video with `muted: false`, `has_audio: true`, or an audio tag also counts as
  `audio`.

Profile `tags` and `tag_limits` see both explicit tags and inferred buckets.
Bucket caps apply to each new roll. Crossfades can temporarily exceed caps
because old layers fade out while new layers fade in.

## Browser/WebView Output

The app uses `web/output.html`. It can also be served or embedded directly:

```text
output.html
output.html?profile=rice1
output.html?preset=random
output.html?media=off
output.html?locked=on
output.html?config=/path/to/output.config.json
output.html?media_config=https://example.com/media.json
```

In a normal browser, `native` audio is unavailable. Use `system` or `mic`, and
expect browser permission prompts. In the Tauri app, `native` uses the Rust
backend and the PulseAudio/PipeWire monitor path.

## JavaScript API

The output page exposes:

```js
window.JaxabstractOutput
window.jaxabstract
```

Useful methods:

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
jaxabstract:ready
jaxabstract:preset
jaxabstract:profile
jaxabstract:media
jaxabstract:locked
```

## Static Terminal Background Helpers

The Rust CLI still includes static background helpers:

```bash
cargo run -- terminal auto
cargo run -- terminal kitty
cargo run -- terminal konsole
cargo run -- install-terminal kitty
cargo run -- install-terminal konsole
```

These generate a still jaxabstract-style background and wire it into Kitty or
Konsole. The Tauri output host is the main path for live shaders, media, native
audio, and the embedded shell.

## Known Limits

- This currently installs from a source checkout.
- First launch may compile the Tauri app unless a release binary already exists.
- Linux system packages are still required for Tauri/WebKitGTK.
- Native audio depends on `pactl` and `parec`.
- Remote media packs depend on those URLs staying available.
- Prebuilt AppImage/deb/rpm/npm binary publishing is not done yet.
