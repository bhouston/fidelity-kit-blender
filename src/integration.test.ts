import { expect, it } from "vitest";
import {
  Scene,
  Mesh,
  SphereGeometry,
  MeshStandardMaterial,
  DirectionalLight,
  PerspectiveCamera,
  DataTexture,
  FloatType,
  RGBAFormat,
} from "three";
import { renderScene, exportEnvironment } from "./three.js";
it.skipIf(process.env.BLENDER_INTEGRATION !== "1")(
  "renders a real scene, transparency, light intensity and environment rotation",
  async () => {
    const scene = new Scene();
    scene.add(
      new Mesh(
        new SphereGeometry(1, 16, 12),
        new MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
      ),
    );
    const light = new DirectionalLight(0xffffff, 2);
    light.position.set(0, 0, 5);
    scene.add(light);
    const camera = new PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    const options = {
      scene,
      camera,
      width: 16,
      height: 16,
      samples: 16,
      bounces: 0,
      device: "cpu" as const,
      adaptiveThreshold: 0,
      toneMapping: "none" as const,
      toneMappingExposure: 1,
      outputColorSpace: "srgb" as const,
      background: { type: "transparent" as const },
    };
    const bright = await renderScene(options);
    expect(bright.pixels[3]).toBe(0);
    expect(bright.pixels[(8 * 16 + 8) * 4 + 3]).toBe(255);
    light.intensity = 1;
    const dim = await renderScene(options);
    const center = (8 * 16 + 8) * 4;
    expect(bright.linear[center]! / dim.linear[center]!).toBeCloseTo(2, 1);
    const sky = new Scene();
    const data = new Float32Array(16 * 8 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (i / 4) % 16 < 8 ? 2 : 0;
      data[i + 2] = (i / 4) % 16 >= 8 ? 2 : 0;
      data[i + 3] = 1;
    }
    const bytes = await exportEnvironment(new DataTexture(data, 16, 8, RGBAFormat, FloatType));
    const first = await renderScene({
      ...options,
      scene: sky,
      background: { type: "environment" },
      environment: { bytes },
    });
    const rotated = await renderScene({
      ...options,
      scene: sky,
      background: { type: "environment" },
      environment: { bytes, rotation: [0, Math.PI, 0] },
    });
    expect(first.linear[center]! + rotated.linear[center]!).toBeCloseTo(2, 1);
    expect(Math.abs(first.linear[center]! - rotated.linear[center]!)).toBeGreaterThan(1);
  },
  120_000,
);
