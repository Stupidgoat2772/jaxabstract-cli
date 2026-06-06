use image::{ImageBuffer, ImageError, Rgba};
use std::f32::consts::TAU;
use std::path::Path;

pub struct RenderOptions {
    pub width: u32,
    pub height: u32,
    pub seed: u32,
    pub strength: f32,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            seed: 7,
            strength: 0.72,
        }
    }
}

pub fn save_background(path: &Path, options: &RenderOptions) -> Result<(), ImageError> {
    let image = render_background(options);
    image.save(path)
}

pub fn render_background(options: &RenderOptions) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
    let width = options.width.max(16);
    let height = options.height.max(16);
    let seed = options.seed as f32;
    let strength = options.strength.clamp(0.05, 1.0);

    ImageBuffer::from_fn(width, height, |x, y| {
        let u = x as f32 / (width - 1) as f32;
        let v = y as f32 / (height - 1) as f32;
        let cx = u - 0.5;
        let cy = v - 0.5;
        let radius = (cx * cx + cy * cy).sqrt();
        let angle = cy.atan2(cx);

        let wave_a = ((u * 7.0 + seed * 0.113).sin() + (v * 11.0 - seed * 0.071).cos()) * 0.5;
        let wave_b = ((angle * 3.0 + radius * 28.0 + seed * 0.037).sin() + 1.0) * 0.5;
        let pulse = ((u * 31.0).sin() * (v * 23.0 + seed).cos()).abs();
        let grid = grid_line(u, 28.0) + grid_line(v, 18.0);
        let filament = filament_field(u, v, seed);
        let noise = hash_noise(x, y, options.seed);

        let vignette = (1.0 - radius * 1.45).clamp(0.0, 1.0);
        let signal = (wave_a * 0.22
            + wave_b * 0.34
            + pulse * 0.16
            + grid * 0.16
            + filament * 0.42
            + noise * 0.08)
            .clamp(0.0, 1.0);
        let glow = (signal * vignette.powf(0.45) * strength).clamp(0.0, 1.0);

        let scanline = 0.92 + 0.08 * ((v * height as f32 * TAU / 3.0).sin() * 0.5 + 0.5);
        let r = (2.0 + glow * 28.0 + filament * 18.0) * scanline;
        let g = (8.0 + glow * 92.0 + grid * 42.0) * scanline;
        let b = (18.0 + glow * 168.0 + wave_b * 34.0) * scanline;

        Rgba([
            r.clamp(0.0, 255.0) as u8,
            g.clamp(0.0, 255.0) as u8,
            b.clamp(0.0, 255.0) as u8,
            255,
        ])
    })
}

fn grid_line(value: f32, cells: f32) -> f32 {
    let pos = (value * cells).fract();
    let dist = pos.min(1.0 - pos);
    (1.0 - dist * 95.0).clamp(0.0, 1.0)
}

fn filament_field(u: f32, v: f32, seed: f32) -> f32 {
    let mut value: f32 = 0.0;
    for i in 0..7 {
        let fi = i as f32;
        let phase = seed * (0.013 + fi * 0.009);
        let center = 0.5 + (u * (fi + 1.7) * TAU + phase).sin() * 0.18;
        let width = 0.004 + fi * 0.0016;
        let dist = (v - center).abs();
        value = value.max((1.0 - dist / width).clamp(0.0, 1.0) * (0.45 + fi * 0.06));
    }
    value
}

fn hash_noise(x: u32, y: u32, seed: u32) -> f32 {
    let mut n = x
        .wrapping_mul(374_761_393)
        .wrapping_add(y.wrapping_mul(668_265_263))
        .wrapping_add(seed.wrapping_mul(2_246_822_519));
    n = (n ^ (n >> 13)).wrapping_mul(1_274_126_177);
    ((n ^ (n >> 16)) & 0xffff) as f32 / 65_535.0
}
