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

it.skipIf(process.env.BLENDER_INTEGRATION !== "1")(
  "renders rectangular/circular area lights with proportional radiance",
  async () => {
    const { RectAreaLight, Color } = await import("three");
    const scene = new Scene();
    scene.background = new Color(0);
    scene.add(
      new Mesh(
        new SphereGeometry(1, 24, 16),
        new MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
      ),
    );
    const area = new RectAreaLight(0xffffff, 3, 2, 2);
    area.position.set(0, 0, 4);
    scene.add(area);
    const camera = new PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    const options = {
      scene,
      camera,
      width: 32,
      height: 32,
      samples: 32,
      bounces: 1,
      adaptiveThreshold: 0,
      device: "cpu" as const,
      toneMapping: "none" as const,
      toneMappingExposure: 1,
      outputColorSpace: "srgb" as const,
      features: { areaLights: true },
    };
    await expect(renderScene({ ...options, features: undefined })).rejects.toThrow(
      "Unsupported light",
    );
    const dim = await renderScene(options);
    area.intensity = 6;
    const bright = await renderScene(options);
    const center = (16 * 32 + 16) * 4;
    expect(dim.linear[center]!).toBeGreaterThan(0.01);
    expect(bright.linear[center]! / dim.linear[center]!).toBeCloseTo(2, 1);
    Object.assign(area, { isCircular: true });
    const circular = await renderScene(options);
    expect(circular.linear[center]!).toBeGreaterThan(0.01);
    expect(area.parent).toBe(scene);
    expect(area.width).toBe(2);
  },
  120_000,
);

it.skipIf(process.env.BLENDER_INTEGRATION !== "1")(
  "renders depth of field and independent texture backgrounds",
  async () => {
    const { PlaneGeometry, Color } = await import("three");
    const scene = new Scene();
    scene.background = new Color(0);
    const square = new Mesh(
      new PlaneGeometry(0.6, 0.6),
      new MeshStandardMaterial({ color: 0, emissive: 0xffffff }),
    );
    square.position.set(0.8, 0, -3);
    scene.add(square);
    const camera = new PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    Object.assign(camera, {
      bokehSize: 400,
      focusDistance: 5,
      apertureBlades: 6,
      apertureRotation: 0.2,
    });
    const options = {
      scene,
      camera,
      width: 64,
      height: 64,
      samples: 64,
      bounces: 1,
      adaptiveThreshold: 0,
      device: "cpu" as const,
      toneMapping: "none" as const,
      toneMappingExposure: 1,
      outputColorSpace: "srgb" as const,
      features: { depthOfField: true },
    };
    await expect(renderScene({ ...options, features: undefined })).rejects.toThrow(
      "depth of field",
    );
    const blurred = await renderScene(options);
    Object.assign(camera, { bokehSize: 0 });
    const sharp = await renderScene(options);
    const differing = blurred.pixels.filter(
      (value, i) => i % 4 !== 3 && Math.abs(value - sharp.pixels[i]!) > 10,
    ).length;
    expect(differing).toBeGreaterThan(30);
    const data = new Float32Array(16 * 8 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (i / 4) % 16 < 8 ? 2 : 0;
      data[i + 2] = (i / 4) % 16 >= 8 ? 2 : 0;
      data[i + 3] = 1;
    }
    const bytes = await exportEnvironment(new DataTexture(data, 16, 8, RGBAFormat, FloatType));
    const sky = new Scene();
    const first = await renderScene({
      ...options,
      scene: sky,
      environment: null,
      background: { type: "equirectangular", texture: { bytes } },
    });
    const rotated = await renderScene({
      ...options,
      scene: sky,
      environment: { bytes, intensity: 7 },
      background: { type: "equirectangular", texture: { bytes, rotation: [0, Math.PI, 0] } },
    });
    const center = (32 * 64 + 32) * 4;
    expect(first.linear[center]! + rotated.linear[center]!).toBeCloseTo(2, 1);
    expect(Math.abs(first.linear[center]! - rotated.linear[center]!)).toBeGreaterThan(1);
    expect(first.pixels[center + 3]).toBe(255);
    expect(rotated.pixels[center + 3]).toBe(255);
  },
  120_000,
);
