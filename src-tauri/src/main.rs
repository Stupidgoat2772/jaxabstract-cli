use num_complex::Complex32;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use rustfft::{Fft, FftPlanner};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env,
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

const SAMPLE_RATE: usize = 48_000;
const FFT_SIZE: usize = 2048;
const AUDIO_EMIT_INTERVAL: Duration = Duration::from_millis(50);
const EVENT_NAME: &str = "jaxabstract-audio-levels";
const TERMINAL_OUTPUT_EVENT: &str = "jaxabstract-terminal-output";
const SHELL_COMMAND_EVENT: &str = "jaxabstract-shell-command";

static AUDIO_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Default, Serialize)]
struct AudioLevels {
    bass: f32,
    mid: f32,
    high: f32,
    energy: f32,
}

#[derive(Default)]
struct TerminalState {
    inner: Mutex<Option<TerminalSession>>,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    command_file: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ShellCommand {
    line: String,
}

#[tauri::command]
fn start_audio_capture(app: AppHandle) -> Result<(), String> {
    if AUDIO_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    thread::Builder::new()
        .name("jaxabstract-audio-capture".into())
        .spawn(move || {
            if let Err(err) = run_audio_capture(app.clone()) {
                let _ = app.emit("jaxabstract-audio-error", err);
            }
            AUDIO_RUNNING.store(false, Ordering::SeqCst);
        })
        .map_err(|err| err.to_string())?;

    Ok(())
}

#[tauri::command]
fn stop_audio_capture() {
    AUDIO_RUNNING.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn start_shell(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|err| err.to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let pty_system = native_pty_system();
    let command_file = command_file_path();
    fs::create_dir_all(command_file.parent().ok_or_else(|| "invalid command file path".to_string())?)
        .map_err(|err| format!("failed to create command dir: {err}"))?;
    fs::write(&command_file, "").map_err(|err| format!("failed to initialize command file: {err}"))?;

    let size = PtySize {
        rows: rows.max(2),
        cols: cols.max(2),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system
        .openpty(size)
        .map_err(|err| format!("failed to open pty: {err}"))?;

    let shell_path = shell.unwrap_or_else(default_shell);
    let mut command = CommandBuilder::new(&shell_path);
    command.cwd(env::current_dir().unwrap_or_else(|_| env::var("HOME").unwrap_or_else(|_| "/".into()).into()));
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("JAXABSTRACT_COMMAND_FILE", command_file.to_string_lossy().to_string());
    command.env("PATH", shell_path_with_app_bin());

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| format!("failed to start shell {shell_path}: {err}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("failed to clone pty reader: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("failed to open pty writer: {err}"))?;

    let reader_app = app.clone();
    thread::Builder::new()
        .name("jaxabstract-terminal-reader".into())
        .spawn(move || {
            let mut buf = [0_u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                        if reader_app.emit(TERMINAL_OUTPUT_EVENT, text).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = reader_app.emit("jaxabstract-terminal-exit", ());
        })
        .map_err(|err| err.to_string())?;

    start_shell_command_watcher(app.clone(), command_file.clone());

    *guard = Some(TerminalSession {
        master: pair.master,
        child,
        writer,
        command_file,
    });

    Ok(())
}

#[tauri::command]
fn write_shell(state: State<'_, TerminalState>, data: String) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|err| err.to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "shell is not running".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|err| format!("failed to write shell input: {err}"))?;
    session
        .writer
        .flush()
        .map_err(|err| format!("failed to flush shell input: {err}"))?;
    Ok(())
}

#[tauri::command]
fn resize_shell(state: State<'_, TerminalState>, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|err| err.to_string())?;
    let session = guard
        .as_ref()
        .ok_or_else(|| "shell is not running".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("failed to resize shell: {err}"))
}

#[tauri::command]
fn stop_shell(state: State<'_, TerminalState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|err| err.to_string())?;
    if let Some(mut session) = guard.take() {
        let _ = session.child.kill();
        let _ = fs::remove_file(session.command_file);
    }
    Ok(())
}

#[tauri::command]
fn load_output_config() -> Result<Value, String> {
    let path = output_config_path();
    if !path.exists() {
        let default_path = package_root().join("web/output.config.json");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("failed to create config dir: {err}"))?;
        }
        fs::copy(&default_path, &path).map_err(|err| {
            format!(
                "failed to copy default config from {} to {}: {err}",
                default_path.display(),
                path.display()
            )
        })?;
    }

    let text = fs::read_to_string(&path)
        .map_err(|err| format!("failed to read config {}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("failed to parse config {}: {err}", path.display()))
}

#[tauri::command]
fn load_media_config() -> Result<Value, String> {
    let user_path = media_config_path();
    let path = if user_path.exists() {
        user_path
    } else {
        package_root().join("web/media/media.json")
    };

    let text = fs::read_to_string(&path)
        .map_err(|err| format!("failed to read media config {}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("failed to parse media config {}: {err}", path.display()))
}

#[tauri::command]
fn save_output_config(config: Value) -> Result<(), String> {
    let path = output_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("failed to create config dir: {err}"))?;
    }
    let text = serde_json::to_string_pretty(&config)
        .map_err(|err| format!("failed to serialize config: {err}"))?;
    fs::write(&path, text).map_err(|err| format!("failed to write config {}: {err}", path.display()))
}

fn run_audio_capture(app: AppHandle) -> Result<(), String> {
    let monitor = default_monitor_source()?;
    let mut child = Command::new("parec")
        .arg("--device")
        .arg(&monitor)
        .arg("--format")
        .arg("s16le")
        .arg("--channels")
        .arg("1")
        .arg("--rate")
        .arg(SAMPLE_RATE.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("failed to start parec for {monitor}: {err}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "parec did not expose stdout".to_string())?;

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut pcm_bytes = vec![0_u8; FFT_SIZE * 2];
    let mut samples = vec![0.0_f32; FFT_SIZE];
    let mut spectrum = vec![Complex32::default(); FFT_SIZE];
    let mut last_emit = Instant::now();

    while AUDIO_RUNNING.load(Ordering::SeqCst) {
        if let Err(err) = stdout.read_exact(&mut pcm_bytes) {
            let _ = child.kill();
            return Err(format!("audio stream ended: {err}"));
        }

        for (sample, bytes) in samples.iter_mut().zip(pcm_bytes.chunks_exact(2)) {
            let value = i16::from_le_bytes([bytes[0], bytes[1]]);
            *sample = value as f32 / i16::MAX as f32;
        }

        if last_emit.elapsed() >= AUDIO_EMIT_INTERVAL {
            let levels = analyze_levels(&samples, &mut spectrum, &fft);
            let _ = app.emit(EVENT_NAME, levels);
            last_emit = Instant::now();
        }
    }

    let _ = child.kill();
    Ok(())
}

fn default_monitor_source() -> Result<String, String> {
    let output = Command::new("pactl")
        .arg("get-default-sink")
        .output()
        .map_err(|err| format!("failed to run pactl: {err}"))?;

    if !output.status.success() {
        return Err("pactl get-default-sink failed".into());
    }

    let sink = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sink.is_empty() {
        return Err("default sink is empty".into());
    }

    Ok(format!("{sink}.monitor"))
}

fn default_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
}

fn start_shell_command_watcher(app: AppHandle, path: PathBuf) {
    let _ = thread::Builder::new()
        .name("jaxabstract-shell-command-watcher".into())
        .spawn(move || {
            let mut offset = 0_usize;
            loop {
                thread::sleep(Duration::from_millis(120));
                let Ok(text) = fs::read_to_string(&path) else {
                    break;
                };
                if text.len() < offset {
                    offset = 0;
                }
                if text.len() == offset {
                    continue;
                }
                for line in text[offset..].lines() {
                    let line = line.trim();
                    if !line.is_empty() {
                        let _ = app.emit(SHELL_COMMAND_EVENT, ShellCommand { line: line.into() });
                    }
                }
                offset = text.len();
            }
        });
}

fn command_file_path() -> PathBuf {
    env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir())
        .join(format!("jaxabstract-output-{}.commands", std::process::id()))
}

fn output_config_path() -> PathBuf {
    config_home()
        .join("jaxabstract/output.config.json")
}

fn media_config_path() -> PathBuf {
    config_home()
        .join("jaxabstract/media.json")
}

fn config_home() -> PathBuf {
    env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(|| env::temp_dir())
}

fn shell_path_with_app_bin() -> String {
    let bin = package_root().join("bin");
    let old = env::var("PATH").unwrap_or_default();
    format!("{}:{old}", bin.to_string_lossy())
}

fn package_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn analyze_levels(
    samples: &[f32],
    spectrum: &mut [Complex32],
    fft: &Arc<dyn Fft<f32>>,
) -> AudioLevels {
    for (i, sample) in samples.iter().enumerate() {
        let window = 0.5 - 0.5 * ((2.0 * std::f32::consts::PI * i as f32) / (samples.len() - 1) as f32).cos();
        spectrum[i] = Complex32::new(sample * window, 0.0);
    }

    fft.process(spectrum);

    let bass = band_energy(spectrum, 20.0, 250.0);
    let mid = band_energy(spectrum, 250.0, 4000.0);
    let high = band_energy(spectrum, 4000.0, 16_000.0);
    let energy = (bass * 0.50 + mid * 0.35 + high * 0.15).clamp(0.0, 1.0);

    AudioLevels {
        bass,
        mid,
        high,
        energy,
    }
}

fn band_energy(spectrum: &[Complex32], lo_hz: f32, hi_hz: f32) -> f32 {
    let bin_hz = SAMPLE_RATE as f32 / FFT_SIZE as f32;
    let lo = (lo_hz / bin_hz).floor().max(1.0) as usize;
    let hi = (hi_hz / bin_hz).ceil().min((FFT_SIZE / 2 - 1) as f32) as usize;
    if hi <= lo {
        return 0.0;
    }

    let mut sum = 0.0;
    for bin in lo..=hi {
        sum += spectrum[bin].norm_sqr().sqrt();
    }

    let avg = sum / (hi - lo + 1) as f32;
    (avg * 10.0).sqrt().clamp(0.0, 1.0)
}

fn main() {
    tauri::Builder::default()
        .manage(TerminalState::default())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "main window not found".to_string())?;
            window.set_focus()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_audio_capture,
            stop_audio_capture,
            start_shell,
            write_shell,
            resize_shell,
            stop_shell,
            load_output_config,
            load_media_config,
            save_output_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running jaxabstract output");
}
