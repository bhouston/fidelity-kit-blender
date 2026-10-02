import { expect, it } from "vitest";
import { validateOptions } from "./index.js";
import type { RenderOptions } from "./types.js";
const options = {
  width: 16,
  height: 16,
  background: { type: "transparent" },
  toneMapping: "none",
  toneMappingExposure: 1,
  outputColorSpace: "srgb",
} satisfies RenderOptions;
it("rejects invalid explicit settings before starting Blender", () => {
  expect(() => validateOptions({ ...options, width: 0 })).toThrow("width");
  expect(() =>
    validateOptions({ ...options, outputColorSpace: "unknown" } as unknown as RenderOptions),
  ).toThrow("outputColorSpace");
  expect(() =>
    validateOptions({ ...options, environment: { path: "studio.exr", bytes: new Uint8Array(4) } }),
  ).toThrow("exactly one");
  expect(() =>
    validateOptions({ ...options, environment: { path: "studio.exr", rotation: [0, NaN, 0] } }),
  ).toThrow("rotation");
  expect(() =>
    validateOptions({ ...options, failAllBlack: "no" } as unknown as RenderOptions),
  ).toThrow("failAllBlack");
  expect(() => validateOptions({ ...options, background: { type: "environment" } })).toThrow(
    "requires an environment",
  );
});

it("validates optional area and camera descriptors before running Blender", async () => {
  const { validateSceneDescriptors } = await import("./index.js");
  const base = {
    ...options,
    gltf: new Uint8Array(),
    camera: {
      type: "perspective" as const,
      position: [0, 0, 5] as [number, number, number],
      quaternion: [0, 0, 0, 1] as [number, number, number, number],
      near: 0.1,
      far: 100,
      fov: 1,
      depthOfField: { apertureDiameter: 10, focusDistance: 5 },
    },
    lights: [
      {
        type: "area" as const,
        position: [0, 2, 0] as [number, number, number],
        quaternion: [0, 0, 0, 1] as [number, number, number, number],
        color: [1, 1, 1] as [number, number, number],
        width: 2,
        height: 3,
        intensity: 4,
      },
    ],
  };
  expect(() => validateSceneDescriptors(base)).not.toThrow();
  for (const depthOfField of [
    { apertureDiameter: 0, focusDistance: 5 },
    { apertureDiameter: 10, focusDistance: NaN },
    { apertureDiameter: 10, focusDistance: 5, apertureBlades: 2 },
    { apertureDiameter: 10, focusDistance: 5, apertureRotation: Infinity },
  ])
    expect(() =>
      validateSceneDescriptors({ ...base, camera: { ...base.camera, depthOfField } }),
    ).toThrow();
  expect(() =>
    validateSceneDescriptors({ ...base, camera: { ...base.camera, type: "orthographic" } }),
  ).toThrow("perspective");
  expect(() =>
    validateSceneDescriptors({ ...base, lights: [{ ...base.lights[0]!, width: -1 }] }),
  ).toThrow("dimensions");
  expect(() =>
    validateSceneDescriptors({ ...base, lights: [{ ...base.lights[0]!, intensity: NaN }] }),
  ).toThrow("radiance");
  expect(() =>
    validateSceneDescriptors({
      ...base,
      lights: [{ ...base.lights[0]!, quaternion: [0, 0, 0, 0] }],
    }),
  ).toThrow("quaternion");
  expect(() =>
    validateOptions({
      ...options,
      background: { type: "equirectangular", texture: { bytes: new Uint8Array(4) } },
    }),
  ).not.toThrow();
  expect(() =>
    validateOptions({
      ...options,
      background: { type: "equirectangular", texture: { path: "a", bytes: new Uint8Array(4) } },
    }),
  ).toThrow("exactly one");
});
