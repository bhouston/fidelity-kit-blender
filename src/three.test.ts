import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import {
  Scene,
  Mesh,
  BoxGeometry,
  MeshStandardMaterial,
  DirectionalLight,
  SpotLight,
  PerspectiveCamera,
  OrthographicCamera,
  DataTexture,
  RGBAFormat,
  FloatType,
  ACESFilmicToneMapping,
  SRGBColorSpace,
} from "three";
import {
  cameraDescriptor,
  exportScene,
  exportEnvironment,
  lightDescriptors,
  outputSettings,
} from "./three.js";
it("exports geometry and RGBA textures without changing scene structure or globals", async () => {
  const scene = new Scene();
  const texture = new DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map: texture })));
  const light = new DirectionalLight();
  light.position.set(2, 3, 4);
  light.target.position.set(1, 0, 0);
  scene.add(light, light.target);
  const camera = new PerspectiveCamera();
  scene.add(camera);
  const children = [...scene.children];
  const position = light.target.position.clone();
  const globalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const [glb, second] = await Promise.all([exportScene(scene), exportScene(scene)]);
  expect(new DataView(glb.buffer).getUint32(0, true)).toBe(0x46546c67);
  expect(glb).toEqual(second);
  const jsonLength = new DataView(glb.buffer).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  expect(json.images).toHaveLength(1);
  expect(json.cameras).toBeUndefined();
  expect(json.extensions?.KHR_lights_punctual).toBeUndefined();
  expect(scene.children).toEqual(children);
  expect(light.target.position).toEqual(position);
  expect(light.target.parent).toBe(scene);
  expect(Object.getOwnPropertyDescriptor(globalThis, "document")).toEqual(globalDocument);
});
it.each([false, true])(
  "exports separate RGBA8 metalness/roughness maps with flipY=%s",
  async (flipY) => {
    const metalness = new DataTexture(new Uint8Array([1, 2, 40, 255, 3, 4, 80, 255]), 1, 2);
    const roughness = new DataTexture(new Uint8ClampedArray([5, 60, 7, 255, 8, 120, 9, 255]), 1, 2);
    metalness.flipY = roughness.flipY = flipY;
    metalness.userData.mimeType = roughness.userData.mimeType = "image/ktx2";
    metalness.repeat.set(2, 3);
    const material = new MeshStandardMaterial({ metalnessMap: metalness, roughnessMap: roughness });
    const mesh = new Mesh(new BoxGeometry(), material);
    const scene = new Scene();
    scene.add(
      mesh,
      new Mesh(
        new BoxGeometry(),
        Array.from({ length: 6 }, () => material),
      ),
    );
    const source = metalness.source;
    const image = metalness.image;
    const bytes = image.data.slice();
    const glb = await exportScene(scene);
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
    expect(json.materials).toHaveLength(1);
    const map = json.materials[0].pbrMetallicRoughness.metallicRoughnessTexture;
    expect(map.extensions.KHR_texture_transform.scale).toEqual([2, 3]);
    const imageDef = json.images[json.textures[map.index].source];
    expect(imageDef.mimeType).toBe("image/png");
    const bufferView = json.bufferViews[imageDef.bufferView];
    const offset = 28 + jsonLength + (bufferView.byteOffset ?? 0);
    const decoded = await loadImage(
      Buffer.from(glb.subarray(offset, offset + bufferView.byteLength)),
    );
    const canvas = createCanvas(1, 2);
    const context = canvas.getContext("2d");
    context.drawImage(decoded, 0, 0);
    expect([...context.getImageData(0, 0, 1, 2).data]).toEqual(
      flipY ? [0, 120, 80, 255, 0, 60, 40, 255] : [0, 60, 40, 255, 0, 120, 80, 255],
    );
    expect(mesh.material).toBe(material);
    expect(material.metalnessMap).toBe(metalness);
    expect(material.roughnessMap).toBe(roughness);
    expect(metalness.userData.mimeType).toBe("image/ktx2");
    expect(roughness.userData.mimeType).toBe("image/ktx2");
    expect(metalness.source).toBe(source);
    expect(metalness.image).toBe(image);
    expect(metalness.image.data).toEqual(bytes);
  },
);
it("extracts target-based world directions and spot cones", () => {
  const scene = new Scene();
  const light = new SpotLight();
  light.position.set(1, 2, 3);
  light.target.position.set(1, 2, 1);
  light.penumbra = 0.5;
  light.angle = 0.8;
  scene.add(light, light.target);
  const [data] = lightDescriptors(scene, (message) => {
    throw new Error(message);
  });
  expect(data?.direction).toEqual([0, 0, -1]);
  expect(data?.innerConeAngle).toBe(0.4);
});
it("extracts zoomed cameras without changing their projection or parent", () => {
  const camera = new PerspectiveCamera(60);
  camera.zoom = 2;
  expect(cameraDescriptor(camera).fov).toBeCloseTo((camera.getEffectiveFOV() * Math.PI) / 180);
  const ortho = new OrthographicCamera(-2, 2, 1, -1);
  ortho.zoom = 2;
  expect(cameraDescriptor(ortho)).toMatchObject({ left: -1, right: 1, top: 0.5, bottom: -0.5 });
});
it("exports readable HDR data and rejects unsupported environment data", async () => {
  const texture = new DataTexture(new Float32Array([1, 0.5, 0.2, 1]), 1, 1, RGBAFormat, FloatType);
  const sourceImage = texture.image;
  const sourcePixels = texture.image.data;
  const bytes = await exportEnvironment(texture);
  expect(texture.image).toBe(sourceImage);
  expect(texture.image.data).toBe(sourcePixels);
  expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(20000630);
  const decoded = new EXRLoader().setDataType(FloatType).parse(bytes.buffer);
  expect(decoded.data[0]).toBeCloseTo(1);
  expect(decoded.data[1]).toBeCloseTo(0.5);
  expect(decoded.data[2]).toBeCloseTo(0.2);
  await expect(exportEnvironment(new DataTexture(new Uint8Array(4), 1, 1))).rejects.toThrow(
    "explicitly",
  );
});
it("copies explicit renderer settings", () => {
  expect(
    outputSettings({
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: 2,
      outputColorSpace: SRGBColorSpace,
    }),
  ).toEqual({ toneMapping: "aces-filmic", toneMappingExposure: 2, outputColorSpace: "srgb" });
});
