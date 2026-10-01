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
  expect(() => validateOptions({ ...options, background: { type: "environment" } })).toThrow(
    "requires an environment",
  );
});
