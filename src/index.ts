import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FloatType } from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { encodeLinear } from "./color.js";
import { discoverBlender, runBlender } from "./runtime.js";
import type { Camera, Light, RenderOptions, RenderResult } from "./types.js";
export type * from "./types.js";
export { encodeLinear, toneMap, linearToSRGB } from "./color.js";
export interface GLTFRenderOptions extends RenderOptions {
  gltf: string | Uint8Array;
  /** Omit to use the first imported camera, or select an imported camera by name. */
  camera?: Camera | string;
  /** Additional lights, or replacements when replaceLights is true. */
  lights?: Light[];
  replaceLights?: boolean;
}
export async function renderGLTF(options: GLTFRenderOptions): Promise<RenderResult> {
  validateOptions(options);
  options.signal?.throwIfAborted();
  const runtime = await discoverBlender({ executable: options.executable });
  const dir = await mkdtemp(path.join(tmpdir(), "fidelity-kit-blender-"));
  try {
    const gltf =
      typeof options.gltf === "string" ? path.resolve(options.gltf) : path.join(dir, "scene.glb");
    if (typeof options.gltf !== "string") await writeFile(gltf, options.gltf);
    let environment;
    if (options.environment) {
      const input = options.environment;
      const envPath = input.path ? path.resolve(input.path) : path.join(dir, "environment.exr");
      if (input.bytes) await writeFile(envPath, input.bytes);
      environment = {
        path: envPath,
        intensity: input.intensity ?? 1,
        rotation: input.rotation ?? [0, 0, 0],
      };
    }
    const output = path.join(dir, "render.exr");
    const jobPath = path.join(dir, "job.json");
    await writeFile(
      jobPath,
      JSON.stringify({
        version: 1,
        gltf,
        output,
        environment,
        camera: options.camera,
        lights: options.lights ?? [],
        replaceLights: options.replaceLights ?? false,
        width: options.width,
        height: options.height,
        samples: options.samples ?? 256,
        bounces: options.bounces ?? 8,
        seed: options.seed ?? 1,
        denoise: options.denoise ?? false,
        adaptiveThreshold: options.adaptiveThreshold ?? 0.01,
        device: options.device ?? "auto",
        transparent: options.background.type !== "environment",
        cameraOnlyEmission: options.cameraOnlyEmission ?? false,
      }),
    );
    await runBlender(
      runtime.executable,
      [
        "--background",
        "--factory-startup",
        "--python-exit-code",
        "1",
        "--python",
        fileURLToPath(new URL("../blender/render.py", import.meta.url)),
        "--",
        jobPath,
      ],
      options,
    );
    const bytes = new Uint8Array(await readFile(output));
    const exr = new EXRLoader().setDataType(FloatType).parse(bytes.buffer);
    if (exr.width !== options.width || exr.height !== options.height)
      throw new Error("Blender output dimensions do not match the request");
    const bottomFirst = exr.data as Float32Array;
    const linear = new Float32Array(bottomFirst.length);
    const stride = options.width * 4;
    for (let y = 0; y < options.height; y++)
      linear.set(
        bottomFirst.subarray(y * stride, (y + 1) * stride),
        (options.height - 1 - y) * stride,
      );
    return {
      width: options.width,
      height: options.height,
      linear,
      pixels: encodeLinear(linear, options),
      outputColorSpace: options.outputColorSpace,
      blenderVersion: runtime.version,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export function validateOptions(options: RenderOptions): void {
  for (const key of ["width", "height", "samples"] as const) {
    const value = options[key];
    if ((key !== "samples" || value !== undefined) && (!Number.isSafeInteger(value) || value! <= 0))
      throw new Error(`${key} must be a positive integer`);
  }
  if (
    !options.background ||
    !["transparent", "environment", "color", "gradient"].includes(options.background.type)
  )
    throw new Error("Specify background explicitly");
  if (!["srgb", "srgb-linear"].includes(options.outputColorSpace))
    throw new Error("Specify outputColorSpace as srgb or srgb-linear");
  if (!Number.isFinite(options.toneMappingExposure) || options.toneMappingExposure < 0)
    throw new Error("Specify a nonnegative toneMappingExposure");
  if (
    typeof options.toneMapping !== "function" &&
    !["none", "linear", "reinhard", "cineon", "aces-filmic", "agx", "neutral"].includes(
      options.toneMapping,
    )
  )
    throw new Error("Specify a supported toneMapping explicitly");
  if (
    options.bounces !== undefined &&
    (!Number.isSafeInteger(options.bounces) || options.bounces < 0)
  )
    throw new Error("bounces must be a nonnegative integer");
  if (options.environment) {
    const env = options.environment;
    if (Boolean(env.path) === Boolean(env.bytes))
      throw new Error("environment requires exactly one of path or bytes");
    if (env.intensity !== undefined && (!Number.isFinite(env.intensity) || env.intensity < 0))
      throw new Error("environment intensity must be nonnegative");
    if (env.rotation && (env.rotation.length !== 3 || !env.rotation.every(Number.isFinite)))
      throw new Error("environment rotation must be three finite XYZ radians");
  }
  if (options.background.type === "environment" && !options.environment)
    throw new Error("Environment background requires an environment");
}
