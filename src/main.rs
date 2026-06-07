use jaxabstract_cli::{save_background, RenderOptions};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

const APP_ID: &str = "jaxabstract";
const KONSOLE_SCHEME: &str = "Jaxabstract";
const KONSOLE_PROFILE: &str = "Jaxabstract";

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Debug)]
struct CliError(String);

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CliError {}

fn main() {
    if let Err(err) = run() {
        eprintln!("jaxabstract-static: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = env::args_os().skip(1).collect::<Vec<_>>();
    let Some(command) = pop_string(&mut args) else {
        print_usage();
        return Ok(());
    };

    match command.as_str() {
        "render-bg" => render_bg(args),
        "terminal" => terminal(args),
        "install-terminal" => install_terminal(args),
        "-h" | "--help" | "help" => {
            print_usage();
            Ok(())
        }
        _ => Err(CliError(format!("unknown command: {command}")).into()),
    }
}

fn render_bg(args: Vec<OsString>) -> Result<()> {
    let (options, out, _cmd) = parse_common(args)?;
    let out = out.unwrap_or_else(default_background_path);
    ensure_parent(&out)?;
    save_background(&out, &options)?;
    println!("{}", out.display());
    Ok(())
}

fn terminal(args: Vec<OsString>) -> Result<()> {
    let Some(target) = args.first().and_then(|arg| arg.to_str()).map(str::to_owned) else {
        return Err(CliError("terminal target required: auto, kitty, or konsole".into()).into());
    };

    let (_, rest) = args.split_first().expect("checked above");
    match target.as_str() {
        "auto" => launch_auto(rest.to_vec()),
        "kitty" => launch_kitty(rest.to_vec()),
        "konsole" => launch_konsole(rest.to_vec()),
        _ => Err(CliError(format!("unsupported terminal target: {target}")).into()),
    }
}

fn install_terminal(args: Vec<OsString>) -> Result<()> {
    let Some(target) = args.first().and_then(|arg| arg.to_str()).map(str::to_owned) else {
        return Err(CliError("install target required: kitty or konsole".into()).into());
    };

    let (_, rest) = args.split_first().expect("checked above");
    let (options, out, _cmd) = parse_common(rest.to_vec())?;
    let image = out.unwrap_or_else(default_background_path);
    ensure_parent(&image)?;
    save_background(&image, &options)?;

    match target.as_str() {
        "kitty" => {
            let config = write_kitty_config(&image, options.strength)?;
            println!("kitty config: {}", config.display());
        }
        "konsole" => {
            let (scheme, profile) = write_konsole_config(&image)?;
            println!("konsole scheme: {}", scheme.display());
            println!("konsole profile: {}", profile.display());
        }
        _ => return Err(CliError(format!("unsupported install target: {target}")).into()),
    }

    println!("background: {}", image.display());
    Ok(())
}

fn launch_auto(args: Vec<OsString>) -> Result<()> {
    if command_exists("kitty") {
        return launch_kitty(args);
    }
    if command_exists("konsole") {
        return launch_konsole(args);
    }
    Err(CliError("no supported terminal found; install kitty or konsole".into()).into())
}

fn launch_kitty(args: Vec<OsString>) -> Result<()> {
    require_command("kitty")?;
    let (options, out, command) = parse_common(args)?;
    let image = out.unwrap_or_else(default_background_path);
    ensure_parent(&image)?;
    save_background(&image, &options)?;

    let log = runtime_dir().join("kitty.log");
    ensure_parent(&log)?;

    let mut child = Command::new("kitty");
    child
        .arg("--detach")
        .arg("--detached-log")
        .arg(&log)
        .arg("--class")
        .arg("jaxabstract-terminal")
        .arg("--title")
        .arg("jaxabstract terminal")
        .arg("--override")
        .arg(format!("background_image={}", image.display()))
        .arg("--override")
        .arg("background_image_layout=scaled")
        .arg("--override")
        .arg("background_image_linear=yes")
        .arg("--override")
        .arg(format!(
            "background_tint={:.3}",
            1.0 - options.strength.clamp(0.05, 1.0)
        ))
        .arg("--override")
        .arg("background_opacity=1")
        .arg("--override")
        .arg("foreground=#eaf6ff")
        .arg("--override")
        .arg("background=#05070d")
        .arg("--working-directory")
        .arg(current_dir()?);

    append_terminal_command(&mut child, command);
    run_launcher(child, "kitty")?;
    println!("RUNNING kitty background={}", image.display());
    Ok(())
}

fn launch_konsole(args: Vec<OsString>) -> Result<()> {
    require_command("konsole")?;
    let (options, out, command) = parse_common(args)?;
    let image = out.unwrap_or_else(default_background_path);
    ensure_parent(&image)?;
    save_background(&image, &options)?;
    let (_scheme, profile) = write_konsole_config(&image)?;

    let mut child = Command::new("konsole");
    child
        .arg("--profile")
        .arg(KONSOLE_PROFILE)
        .arg("--workdir")
        .arg(current_dir()?);

    if !command.is_empty() {
        child.arg("-e");
        child.args(command);
    }

    run_launcher(child, "konsole")?;
    println!(
        "RUNNING konsole profile={} profile_file={} background={}",
        KONSOLE_PROFILE,
        profile.display(),
        image.display()
    );
    Ok(())
}

fn parse_common(args: Vec<OsString>) -> Result<(RenderOptions, Option<PathBuf>, Vec<OsString>)> {
    let mut options = RenderOptions::default();
    let mut out = None;
    let mut command = Vec::new();
    let mut iter = args.into_iter();

    while let Some(arg) = iter.next() {
        let Some(text) = arg.to_str() else {
            return Err(CliError("arguments must be valid UTF-8".into()).into());
        };

        if text == "--" {
            command.extend(iter);
            break;
        }

        match text {
            "--out" => out = Some(PathBuf::from(next_value(&mut iter, "--out")?)),
            "--width" => options.width = parse_next(&mut iter, "--width")?,
            "--height" => options.height = parse_next(&mut iter, "--height")?,
            "--seed" => options.seed = parse_next(&mut iter, "--seed")?,
            "--strength" => options.strength = parse_next(&mut iter, "--strength")?,
            "-h" | "--help" => {
                print_usage();
                std::process::exit(0);
            }
            value => return Err(CliError(format!("unknown option: {value}")).into()),
        }
    }

    Ok((options, out, command))
}

fn next_value(iter: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<String> {
    let value = iter
        .next()
        .ok_or_else(|| CliError(format!("{flag} requires a value")))?;
    value
        .into_string()
        .map_err(|_| CliError(format!("{flag} value must be valid UTF-8")).into())
}

fn parse_next<T>(iter: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    let value = next_value(iter, flag)?;
    value
        .parse::<T>()
        .map_err(|err| CliError(format!("invalid {flag} value {value:?}: {err}")).into())
}

fn write_kitty_config(image: &Path, strength: f32) -> Result<PathBuf> {
    let dir = config_dir().join("kitty");
    fs::create_dir_all(&dir)?;
    let path = dir.join("jaxabstract.conf");
    let tint = 1.0 - strength.clamp(0.05, 1.0);
    fs::write(
        &path,
        format!(
            "\
background #05070d
foreground #eaf6ff
background_image {}
background_image_layout scaled
background_image_linear yes
background_tint {:.3}
background_opacity 1
",
            image.display(),
            tint
        ),
    )?;
    Ok(path)
}

fn write_konsole_config(image: &Path) -> Result<(PathBuf, PathBuf)> {
    let dir = data_dir().join("konsole");
    fs::create_dir_all(&dir)?;

    let scheme = dir.join(format!("{KONSOLE_SCHEME}.colorscheme"));
    fs::write(&scheme, konsole_colorscheme(image))?;

    let profile = dir.join(format!("{KONSOLE_PROFILE}.profile"));
    fs::write(
        &profile,
        format!(
            "\
[Appearance]
ColorScheme={KONSOLE_SCHEME}

[General]
Command={}
Name={KONSOLE_PROFILE}
Parent=FALLBACK/

[Terminal Features]
BlinkingCursorEnabled=true
",
            default_shell_command()
        ),
    )?;

    Ok((scheme, profile))
}

fn konsole_colorscheme(image: &Path) -> String {
    let palette = [
        ("Foreground", "234,246,255"),
        ("Background", "5,7,13"),
        ("Color0", "8,12,20"),
        ("Color1", "213,76,92"),
        ("Color2", "86,190,147"),
        ("Color3", "216,179,91"),
        ("Color4", "74,153,228"),
        ("Color5", "157,114,224"),
        ("Color6", "92,207,221"),
        ("Color7", "196,210,224"),
        ("ForegroundIntense", "255,255,255"),
        ("BackgroundIntense", "12,18,32"),
        ("Color0Intense", "74,88,112"),
        ("Color1Intense", "255,105,124"),
        ("Color2Intense", "118,231,182"),
        ("Color3Intense", "255,216,122"),
        ("Color4Intense", "112,190,255"),
        ("Color5Intense", "196,153,255"),
        ("Color6Intense", "135,238,255"),
        ("Color7Intense", "238,246,255"),
    ];

    let mut out = format!(
        "\
[General]
Description=Jaxabstract
Opacity=1
Wallpaper={}

",
        image.display()
    );

    for (name, color) in palette {
        out.push_str(&format!("[{name}]\nColor={color}\n\n"));
    }

    out
}

fn append_terminal_command(child: &mut Command, command: Vec<OsString>) {
    if command.is_empty() {
        child.arg(default_shell()).arg("-l");
    } else {
        child.args(command);
    }
}

fn run_launcher(mut command: Command, name: &str) -> Result<()> {
    let status = command.status()?;
    if !status.success() {
        return Err(CliError(format!("{name} launcher failed with status {status}")).into());
    }
    Ok(())
}

fn require_command(name: &str) -> Result<()> {
    if command_exists(name) {
        Ok(())
    } else {
        Err(CliError(format!("{name} is not installed or not on PATH")).into())
    }
}

fn command_exists(name: &str) -> bool {
    env::var_os("PATH")
        .unwrap_or_default()
        .to_string_lossy()
        .split(':')
        .map(Path::new)
        .any(|dir| dir.join(name).is_file())
}

fn default_background_path() -> PathBuf {
    cache_dir().join(APP_ID).join("background.png")
}

fn runtime_dir() -> PathBuf {
    env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join(APP_ID))
        .join(APP_ID)
}

fn cache_dir() -> PathBuf {
    env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".cache"))
}

fn config_dir() -> PathBuf {
    env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config"))
}

fn data_dir() -> PathBuf {
    env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".local/share"))
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn current_dir() -> io::Result<PathBuf> {
    env::current_dir()
}

fn ensure_parent(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn default_shell() -> OsString {
    env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/sh"))
}

fn default_shell_command() -> String {
    format!("{} -l", default_shell().to_string_lossy())
}

fn pop_string(args: &mut Vec<OsString>) -> Option<String> {
    if args.is_empty() {
        None
    } else {
        Some(args.remove(0).to_string_lossy().into_owned())
    }
}

fn print_usage() {
    println!(
        "\
usage:
  jaxabstract-static render-bg [--out path] [--width px] [--height px] [--seed n] [--strength 0..1]
  jaxabstract-static terminal auto|kitty|konsole [options] [-- command...]
  jaxabstract-static install-terminal kitty|konsole [options]

options:
  --out path       background PNG path, default: XDG cache
  --width px       render width, default: 1920
  --height px      render height, default: 1080
  --seed n         deterministic render seed, default: 7
  --strength n     background visual strength, default: 0.72
"
    );
}
