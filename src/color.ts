import type { Background, RenderOptions, Vec3 } from "./types.js";
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const mul = (m: number[], v: Vec3): Vec3 =>
  [0, 1, 2].map((i) => m[i]! * v[0] + m[i + 3]! * v[1] + m[i + 6]! * v[2]) as Vec3;
const map = (v: Vec3, fn: (x: number) => number): Vec3 => v.map(fn) as Vec3;
/** Exact Three.js piecewise linear-sRGB to sRGB transfer function. */
export const linearToSRGB = (x: number): number =>
  x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
/** Port of Three.js tonemapping_pars_fragment; preserve its exposure and clipping semantics. */
export function toneMap(rgb: Vec3, mode: RenderOptions["toneMapping"], exposure: number): Vec3 {
  if (typeof mode === "function") return mode(rgb, exposure);
  if (mode === "none") return rgb;
  let v = map(rgb, (x) => x * exposure);
  switch (mode) {
    case "linear":
      return map(v, clamp);
    case "reinhard":
      return map(v, (x) => clamp(x / (1 + x)));
    case "cineon":
      return map(v, (x) => {
        x = Math.max(0, x - 0.004);
        return ((x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06)) ** 2.2;
      });
    case "aces-filmic":
      v = mul(
        [0.59719, 0.076, 0.0284, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777],
        map(v, (x) => x / 0.6),
      );
      v = map(
        v,
        (x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081),
      );
      return map(
        mul(
          [1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602],
          v,
        ),
        clamp,
      );
    case "agx":
      v = mul([0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.088, 0.0433, 0.0113, 0.8956], v);
      v = mul(
        [
          0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588,
          0.761241990602591, 0.0767994186031903, 0.0482516061458583, 0.101439036467562,
          0.811302368396859,
        ],
        v,
      );
      v = map(v, (x) => clamp((Math.log2(Math.max(x, 1e-10)) + 12.47393) / (4.026069 + 12.47393)));
      v = map(
        v,
        (x) =>
          15.5 * x ** 6 -
          40.14 * x ** 5 +
          31.96 * x ** 4 -
          6.868 * x ** 3 +
          0.4298 * x ** 2 +
          0.1191 * x -
          0.00232,
      );
      v = mul(
        [
          1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323,
          1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257,
          1.2519364065950405,
        ],
        v,
      );
      return map(
        mul(
          [1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187],
          map(v, (x) => Math.max(0, x) ** 2.2),
        ),
        clamp,
      );
    case "neutral": {
      const x = Math.min(...v);
      const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
      v = map(v, (x) => x - offset);
      const peak = Math.max(...v);
      if (peak < 0.76) return v;
      const newPeak = 1 - 0.24 ** 2 / (peak + 0.24 - 0.76);
      const g = 1 - 1 / (0.15 * (peak - newPeak) + 1);
      return map(v, (x) => x * (newPeak / peak) * (1 - g) + newPeak * g);
    }
    default:
      throw new Error(`Unsupported tone mapping: ${String(mode)}`);
  }
}
function backgroundAt(
  background: Background,
  x: number,
  y: number,
  width: number,
  height: number,
): Vec3 | undefined {
  if (background.type === "color") return background.color;
  if (background.type !== "gradient") return undefined;
  const t = Math.hypot((x + 0.5) / width - 0.5, (y + 0.5) / height - 0.5) / 0.5;
  return background.center.map((c, i) => c + (background.edge[i]! - c) * t) as Vec3;
}
/** Input is top-first premultiplied scene-linear RGBA. Output uses straight alpha. */
export function encodeLinear(
  linear: Float32Array,
  options: Pick<
    RenderOptions,
    "width" | "height" | "background" | "toneMapping" | "toneMappingExposure" | "outputColorSpace"
  >,
): Uint8Array {
  const { width, height, background } = options;
  if (linear.length !== width * height * 4) throw new Error("Linear pixel dimensions do not match");
  const out = new Uint8Array(linear.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let alpha = clamp(linear[i + 3]!);
      let rgb: Vec3 = [linear[i]!, linear[i + 1]!, linear[i + 2]!];
      const bg = backgroundAt(background, x, y, width, height);
      if (bg) {
        rgb = rgb.map((c, n) => c + bg[n]! * (1 - alpha)) as Vec3;
        alpha = 1;
      } else if (background.type === "transparent")
        rgb = map(rgb, (c) => (alpha > 0 ? c / alpha : 0));
      rgb = toneMap(rgb, options.toneMapping, options.toneMappingExposure);
      for (let n = 0; n < 3; n++)
        out[i + n] = Math.round(
          clamp(options.outputColorSpace === "srgb" ? linearToSRGB(clamp(rgb[n]!)) : rgb[n]!) * 255,
        );
      out[i + 3] = Math.round(alpha * 255);
    }
  return out;
}
