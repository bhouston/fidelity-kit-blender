import { describe, expect, it } from "vitest";
import { assertNotAllBlack, encodeLinear, isAllBlack, linearToSRGB, toneMap } from "./color.js";
import type { RenderOptions, ToneMapping } from "./types.js";
const options = {
  width: 1,
  height: 1,
  background: { type: "transparent" },
  toneMapping: "none",
  toneMappingExposure: 1,
  outputColorSpace: "srgb",
} satisfies RenderOptions;
describe("Three.js output pipeline", () => {
  it("uses piecewise sRGB, preserves alpha and unpremultiplies before encoding", () => {
    expect([...encodeLinear(new Float32Array([0.25, 0.25, 0.25, 0.5]), options)]).toEqual([
      188, 188, 188, 128,
    ]);
    expect(linearToSRGB(0.003)).toBeCloseTo(0.03876, 8);
    expect(linearToSRGB(0.5)).toBeCloseTo(0.735356983, 8);
  });
  it("composites background in linear space and supports linear output", () => {
    expect([
      ...encodeLinear(new Float32Array([0.25, 0, 0, 0.5]), {
        ...options,
        background: { type: "color", color: [0, 0.5, 0] },
        outputColorSpace: "srgb-linear",
      }),
    ]).toEqual([64, 64, 0, 255]);
  });
  it("preserves Three.js NoToneMapping exposure semantics", () => {
    expect(toneMap([0.2, 0.3, 0.4], "none", 10)).toEqual([0.2, 0.3, 0.4]);
    expect(toneMap([0.2, 0.3, 0.4], "linear", 2)).toEqual([0.4, 0.6, 0.8]);
    expect(toneMap([1, 2, 4], "reinhard", 1)).toEqual([0.5, 2 / 3, 0.8]);
  });
  it("supports every built-in mapper with finite bounded display output", () => {
    for (const mode of [
      "linear",
      "reinhard",
      "cineon",
      "aces-filmic",
      "agx",
      "neutral",
    ] as ToneMapping[]) {
      for (const value of [0, 0.001, 0.18, 1, 100]) {
        const output = toneMap([value, value * 0.5, value * 0.2], mode, 1);
        expect(output.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)).toBe(true);
      }
    }
    expect(toneMap([0.18, 0.18, 0.18], "aces-filmic", 1)[0]).toBeCloseTo(0.213105, 5);
    expect(toneMap([0.18, 0.18, 0.18], "neutral", 1)[0]).toBeCloseTo(0.14, 8);
  });
});

describe("all-black detection", () => {
  it("ignores alpha and fails all-black images unless disabled", () => {
    const black = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0]);
    const dim = new Uint8Array([0, 0, 0, 255, 0, 0, 1, 255]);
    expect(isAllBlack(black)).toBe(true);
    expect(isAllBlack(dim)).toBe(false);
    expect(() => assertNotAllBlack(black)).toThrow("all black");
    expect(() => assertNotAllBlack(black, { failAllBlack: false })).not.toThrow();
    expect(() => assertNotAllBlack(dim)).not.toThrow();
  });
});
