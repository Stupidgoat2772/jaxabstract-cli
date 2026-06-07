# Third-Party Notices

Jaxabstract's original project code is licensed under the BSD Zero Clause
License. See `LICENSE`.

That license applies to this project's original code. Third-party packages,
vendored files, and system libraries keep their own licenses. If you redistribute
Jaxabstract as source or binaries, preserve the applicable third-party notices.

## Direct JavaScript Dependencies

- `@xterm/xterm` 6.0.0: MIT. Used as the embedded terminal emulator in the
  Tauri WebView.
- `@tauri-apps/api` 2.11.x: Apache-2.0 OR MIT. Used for the native app bridge.
- `@tauri-apps/cli` 2.11.x: Apache-2.0 OR MIT. Used as a development/build
  dependency.

## Bundled Runtime Files

- `web/vendor/xterm/xterm.js` and `web/vendor/xterm/xterm.css`: MIT. Copyright
  (c) the xterm.js authors, SourceLair Private Company, and Christopher Jeffrey.
- `web/vendor/butterchurn.min.js`: MIT. Copyright (c) 2013-2018 Jordan Berg.
- `web/vendor/butterchurnExtraImages.min.js`: MIT. Copyright (c) 2013-2018
  Jordan Berg.
- `web/vendor/butterchurnPresets*.min.js`: MIT. Copyright (c) 2013-2018
  Jordan Berg.

## Rust Dependencies

The Tauri app uses Rust crates including:

- `tauri`, `tauri-build`, and related Tauri crates: Apache-2.0 OR MIT.
- `portable-pty`: MIT. Used to open a real pseudoterminal and run the user's
  shell.
- `serde`, `serde_json`, `rustfft`, and `num-complex`: permissive MIT/Apache
  style licenses.

The generated Cargo dependency graph also includes permissive BSD, ISC, Zlib,
Unicode, and Unlicense terms, plus MPL-2.0 transitive crates from the WebKit/UI
stack. No GPL-only dependency was found in the current npm/Cargo metadata check.

## Terminal Stack

Jaxabstract does not embed Kitty, Konsole, or a browser terminal shell. The app
uses xterm.js for terminal emulation in the Tauri WebView, backed by Rust
`portable-pty`, which starts the user's real `$SHELL` in a pseudoterminal. The
native PTY sets `TERM=xterm-256color` and `COLORTERM=truecolor`.
