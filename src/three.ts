import { Canvas, createCanvas, Image, ImageData } from "@napi-rs/canvas";
import {
  Euler,
  DataTexture,
  Source,
  Object3D,
  HalfFloatType,
  FloatType,
  RGBAFormat,
  Color,
  Quaternion,
  Vector3,
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  LinearToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  ReinhardToneMapping,
  SRGBColorSpace,
  LinearSRGBColorSpace,
} from "three";
import type {
  Scene,
  Camera as ThreeCamera,
  PerspectiveCamera,
  OrthographicCamera,
  Light as ThreeLight,
  DirectionalLight,
  SpotLight,
  PointLight,
  RectAreaLight,
  Mesh,
  Material,
  Texture,
} from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { EXRExporter, NO_COMPRESSION } from "three/addons/exporters/EXRExporter.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { renderGLTF } from "./index.js";
import type {
  Background,
  Camera,
  Environment,
  Light,
  PunctualLight,
  RenderOptions,
  ToneMapping,
  Vec3,
} from "./types.js";
export interface SceneRenderOptions extends Omit<RenderOptions, "background"> {
  scene: Scene;
  camera: ThreeCamera;
  /** Extract a plain color, null, or the matching environment background when omitted. */
  background?: Background;
  /** Unsupported features throw by default; choose warn to knowingly approximate/omit them. */
  unsupported?: "error" | "warn";
  onDiagnostic?: (message: string) => void;
  /** Optional scene translations; omitted/false retains strict unsupported-feature diagnostics. */
  features?: { areaLights?: boolean; depthOfField?: boolean; textureBackground?: boolean };
}
export function cameraDescriptor(camera: ThreeCamera, depthOfField = false): Camera {
  const aperture = (camera as ThreeCamera & { bokehSize?: number }).bokehSize;
  if (aperture !== undefined && (!Number.isFinite(aperture) || aperture < 0))
    throw new Error("bokehSize must be a finite nonnegative aperture diameter");
  if (aperture && !(camera as PerspectiveCamera).isPerspectiveCamera)
    throw new Error("Depth of field requires a perspective camera");
  camera.updateWorldMatrix(true, false);
  const p = camera.getWorldPosition(new Vector3()).toArray() as Vec3;
  const q = camera.getWorldQuaternion(new Quaternion()).toArray() as Camera["quaternion"];
  if ((camera as PerspectiveCamera).isPerspectiveCamera) {
    const c = camera as PerspectiveCamera;
    if (c.view?.enabled || c.filmOffset !== 0)
      throw new Error("Camera view offsets/film offsets require an explicit supported camera");
    return {
      type: "perspective",
      position: p,
      quaternion: q,
      near: c.near,
      far: c.far,
      fov: (c.getEffectiveFOV() * Math.PI) / 180,
      depthOfField:
        depthOfField && (c as PerspectiveCamera & { bokehSize?: number }).bokehSize
          ? physicalDepthOfField(c)
          : undefined,
    };
  }
  if ((camera as OrthographicCamera).isOrthographicCamera) {
    const c = camera as OrthographicCamera;
    if (c.view?.enabled) throw new Error("Camera view offsets are unsupported");
    const cx = (c.left + c.right) / 2,
      cy = (c.top + c.bottom) / 2;
    return {
      type: "orthographic",
      position: p,
      quaternion: q,
      near: c.near,
      far: c.far,
      left: cx + (c.left - cx) / c.zoom,
      right: cx + (c.right - cx) / c.zoom,
      top: cy + (c.top - cy) / c.zoom,
      bottom: cy + (c.bottom - cy) / c.zoom,
    };
  }
  throw new Error("Specify a PerspectiveCamera or OrthographicCamera");
}
function physicalDepthOfField(camera: PerspectiveCamera) {
  const physical = camera as PerspectiveCamera & {
    bokehSize: number;
    focusDistance: number;
    apertureBlades?: number;
    apertureRotation?: number;
    anamorphicRatio?: number;
  };
  if (physical.anamorphicRatio !== undefined && physical.anamorphicRatio !== 1)
    throw new Error("Anamorphic depth of field requires anamorphicRatio=1");
  return {
    apertureDiameter: physical.bokehSize,
    focusDistance: physical.focusDistance,
    apertureBlades: physical.apertureBlades ?? 0,
    apertureRotation: physical.apertureRotation ?? 0,
  };
}
export function lightDescriptors(
  scene: Scene,
  diagnostic: (message: string) => void,
  areaLights = false,
): Light[] {
  scene.updateMatrixWorld(true);
  const lights: Light[] = [];
  scene.traverseVisible((object) => {
    if (!(object as ThreeLight).isLight) return;
    if (areaLights && (object as RectAreaLight).isRectAreaLight) {
      const area = object as RectAreaLight & { isCircular?: boolean };
      lights.push({
        type: "area",
        position: area.getWorldPosition(new Vector3()).toArray() as Vec3,
        quaternion: area.getWorldQuaternion(new Quaternion()).toArray() as [
          number,
          number,
          number,
          number,
        ],
        color: area.color.toArray() as Vec3,
        intensity: area.intensity,
        width: area.width,
        height: area.height,
        circular: Boolean(area.isCircular),
      });
      return;
    }
    const l = object as DirectionalLight & SpotLight & PointLight;
    const type = l.isDirectionalLight
      ? "directional"
      : l.isSpotLight
        ? "spot"
        : l.isPointLight
          ? "point"
          : undefined;
    if (!type) {
      diagnostic(`Unsupported light ${object.type}: supply IBL or supported punctual lights`);
      return;
    }
    if (type !== "directional" && l.decay !== 2)
      diagnostic(`Light ${l.name || l.type} decay=${l.decay}; Blender uses inverse-square falloff`);
    if (type !== "directional" && l.distance > 0)
      diagnostic(
        `Light ${l.name || l.type} distance cutoff is unsupported; set distance=0 or choose warn`,
      );
    if (type === "spot" && l.map)
      diagnostic(`SpotLight ${l.name} projection texture is unsupported`);
    const position = l.getWorldPosition(new Vector3());
    const light: PunctualLight = {
      type,
      position: position.toArray() as Vec3,
      color: l.color.toArray() as Vec3,
      intensity: l.intensity,
    };
    if (type !== "point") {
      l.target.updateWorldMatrix(true, false);
      const direction = l.target.getWorldPosition(new Vector3()).sub(position);
      if (direction.lengthSq() === 0) throw new Error("Light target must differ from its position");
      light.direction = direction.normalize().toArray() as Vec3;
    }
    if (type === "spot") {
      light.innerConeAngle = (1 - l.penumbra) * l.angle;
      light.outerConeAngle = l.angle;
    }
    lights.push(light);
  });
  return lights;
}
export async function exportEnvironment(texture: DataTexture): Promise<Uint8Array> {
  if (
    !texture.isDataTexture ||
    texture.format !== RGBAFormat ||
    (texture.type !== HalfFloatType && texture.type !== FloatType)
  )
    throw new Error(
      "Provide an HDR/EXR source or RGBA float/half-float equirectangular DataTexture explicitly",
    );
  const { data, width, height } = texture.image;
  if (!(data instanceof Uint16Array || data instanceof Float32Array))
    throw new Error("Environment requires float/half-float pixels");
  const rows = data.slice();
  if (texture.flipY) {
    const stride = width * 4;
    for (let y = 0; y < height; y++)
      rows.set(data.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
  }
  // Texture.clone shares its Source; allocate a fresh texture to preserve the caller image.
  const copy = new DataTexture(rows, width, height, RGBAFormat, texture.type);
  // Three.js ZIP export can corrupt partial blocks or tiny rows; use lossless uncompressed EXR.
  return new EXRExporter().parse(copy, { type: FloatType, compression: NO_COMPRESSION });
}
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend?: () => void;
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((value) => {
      this.result = value;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((value) => {
      this.result = `data:${blob.type};base64,${Buffer.from(value).toString("base64")}`;
      this.onloadend?.();
    });
  }
}
let exportQueue: Promise<unknown> = Promise.resolve();
function createExportCanvas(width: number, height: number) {
  const canvas = createCanvas(width, height);
  // GLTFExporter identifies raw pixel images by image.data. Native canvas's
  // data() method must not be mistaken for a DataTexture pixel array.
  Object.defineProperty(canvas, "data", { value: undefined, configurable: true });
  const toBlob = canvas.toBlob.bind(canvas);
  // The native encoder can outlive GLTFExporter's reference to its canvas.
  // Retain it in the callback until encoding finishes to prevent a native crash.
  canvas.toBlob = (callback, mime, quality) =>
    toBlob((blob) => callback.call(canvas, blob), mime, quality);
  return canvas;
}
/** Serialized, temporary Node canvas/FileReader bindings; original bindings are restored even on failure. */
export function exportScene(
  scene: Scene,
  diagnostic: (message: string) => void = (message) => {
    throw new Error(message);
  },
): Promise<Uint8Array> {
  const task = exportQueue.then(async () => {
    const snapshot = clone(scene);
    const materialCopies = new Map<Material, Material>();
    const textureCopies = new Map<Texture, Texture>();
    const copyMaterial = (material: Material): Material => {
      let copy = materialCopies.get(material);
      if (!copy) {
        copy = material.clone();
        materialCopies.set(material, copy);
      }
      return copy;
    };
    const remove: typeof snapshot.children = [];
    snapshot.traverse((object) => {
      if ((object as ThreeLight).isLight || (object as ThreeCamera).isCamera) remove.push(object);
      const mesh = object as Mesh;
      if (!mesh.material) return;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(copyMaterial)
        : copyMaterial(mesh.material);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const m = material as Material & {
          isMeshStandardMaterial?: boolean;
          isMeshBasicMaterial?: boolean;
          isNodeMaterial?: boolean;
          toneMapped: boolean;
        };
        if (m.isNodeMaterial || (!m.isMeshStandardMaterial && !m.isMeshBasicMaterial))
          diagnostic(
            `Unsupported material ${m.type}; supply a MeshStandardMaterial/MeshPhysicalMaterial or MeshBasicMaterial replacement`,
          );
        if (!m.toneMapped || m.isMeshBasicMaterial)
          diagnostic(
            `Material ${m.name || m.type} bypasses Three.js tone mapping/unlit lighting; Blender output applies a global tone mapper`,
          );
        for (const [key, value] of Object.entries(material)) {
          const texture = value as Texture;
          if (!texture?.isTexture) continue;
          if ((texture as unknown as { isCompressedTexture: boolean }).isCompressedTexture)
            throw new Error(
              "Compressed textures require an explicit decoded texture or direct glTF input",
            );
          // Native canvases expose a data() method, rather than a raw pixel array.
          if (texture.image instanceof Canvas || texture.image instanceof Image) continue;
          const image = texture.image as { data?: unknown; width: number; height: number };
          if (
            image?.data &&
            !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
          )
            diagnostic(
              "Material texture requires RGBA8 pixels; supply an explicitly converted texture",
            );
          if (image?.data instanceof Uint8Array || image?.data instanceof Uint8ClampedArray) {
            let copy = textureCopies.get(texture);
            if (!copy) {
              // GLTFExporter combines separate metalness/roughness maps with drawImage,
              // which cannot draw a DataTexture's raw { data, width, height } image.
              const { data, width, height } = image;
              const canvas = createExportCanvas(width, height);
              canvas
                .getContext("2d")
                .putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
              copy = texture.clone();
              // Texture.clone shares its Source; replace it without touching the caller.
              copy.source = new Source(canvas);
              // Decoded KTX2 images retain their original MIME type in userData,
              // but canvas encoders need a supported output format.
              copy.userData.mimeType = "image/png";
              textureCopies.set(texture, copy);
            }
            (material as unknown as Record<string, unknown>)[key] = copy;
          }
        }
      }
    });
    for (const object of remove) object.removeFromParent();
    // Blender glTF importer requires a scene node, including for environment-only renders.
    if (snapshot.children.length === 0) snapshot.add(new Object3D());
    const bindings: Record<string, unknown> = {
      document: {
        createElement: (tag: string) => {
          if (tag !== "canvas") throw new Error(`Unexpected export element ${tag}`);
          return createExportCanvas(1, 1);
        },
      },
      FileReader: NodeFileReader,
      ImageData,
      HTMLCanvasElement: Canvas,
      HTMLImageElement: Image,
      OffscreenCanvas: undefined,
    };
    const globals = globalThis as unknown as Record<string, unknown>;
    const originals = new Map(
      Object.keys(bindings).map((key) => [key, Object.getOwnPropertyDescriptor(globals, key)]),
    );
    try {
      for (const [key, value] of Object.entries(bindings))
        Object.defineProperty(globals, key, { value, writable: true, configurable: true });
      const data = await new GLTFExporter().parseAsync(snapshot, { binary: true });
      return new Uint8Array(data as ArrayBuffer);
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globals, key, descriptor);
        else delete globals[key];
      }
    }
  });
  exportQueue = task.catch(() => {});
  return task;
}
export async function renderScene(options: SceneRenderOptions) {
  const { scene, camera } = options;
  const diagnostic = (message: string) => {
    if (options.unsupported !== "warn") throw new Error(message);
    (options.onDiagnostic ?? console.warn)(message);
  };
  if (scene.fog) diagnostic("Scene fog is unsupported");
  const lights = lightDescriptors(scene, diagnostic, options.features?.areaLights);
  if ((camera as ThreeCamera & { bokehSize?: number }).bokehSize && !options.features?.depthOfField)
    diagnostic("Physical-camera depth of field requires features.depthOfField=true");
  const cameraData = cameraDescriptor(camera, options.features?.depthOfField);
  let environment: Environment | null | undefined = options.environment;
  if (environment === undefined && scene.environment) {
    environment = {
      bytes: await exportEnvironment(scene.environment as DataTexture),
      intensity: scene.environmentIntensity,
      rotation: new Euler()
        .setFromQuaternion(new Quaternion().setFromEuler(scene.environmentRotation), "XYZ")
        .toArray()
        .slice(0, 3) as Vec3,
    };
  }
  let background = options.background;
  if (!background) {
    if (scene.background === null) background = { type: "transparent" };
    else if ((scene.background as Color).isColor)
      background = { type: "color", color: (scene.background as Color).toArray() as Vec3 };
    else if (
      scene.background === scene.environment &&
      scene.backgroundIntensity === scene.environmentIntensity &&
      scene.backgroundRotation.equals(scene.environmentRotation) &&
      scene.backgroundBlurriness === 0
    )
      background = { type: "environment" };
    else if (
      options.features?.textureBackground &&
      (scene.background as DataTexture).isDataTexture &&
      scene.backgroundBlurriness === 0
    )
      background = {
        type: "equirectangular",
        texture: {
          bytes: await exportEnvironment(scene.background as DataTexture),
          intensity: scene.backgroundIntensity,
          rotation: new Euler()
            .setFromQuaternion(new Quaternion().setFromEuler(scene.backgroundRotation), "XYZ")
            .toArray()
            .slice(0, 3) as Vec3,
        },
      };
    else
      throw new Error(
        "Specify background explicitly for a separate/blurred/rotated background texture",
      );
  }
  const gltf = await exportScene(scene, diagnostic);
  return renderGLTF({
    ...options,
    gltf,
    camera: cameraData,
    lights,
    replaceLights: true,
    environment,
    background,
  });
}
/** Convenience for callers that already have a Three.js renderer; values are never inferred from the scene. */
export function outputSettings(renderer: {
  toneMapping: number;
  toneMappingExposure: number;
  outputColorSpace: string;
}): Pick<RenderOptions, "toneMapping" | "toneMappingExposure" | "outputColorSpace"> {
  const modes = new Map<number, ToneMapping>([
    [NoToneMapping, "none"],
    [LinearToneMapping, "linear"],
    [ReinhardToneMapping, "reinhard"],
    [CineonToneMapping, "cineon"],
    [ACESFilmicToneMapping, "aces-filmic"],
    [AgXToneMapping, "agx"],
    [NeutralToneMapping, "neutral"],
  ]);
  const toneMapping = modes.get(renderer.toneMapping);
  if (!toneMapping) throw new Error("Specify a custom tone mapping callback explicitly");
  if (
    renderer.outputColorSpace !== SRGBColorSpace &&
    renderer.outputColorSpace !== LinearSRGBColorSpace
  )
    throw new Error("Unsupported renderer output color space");
  return {
    toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
    outputColorSpace: renderer.outputColorSpace as RenderOptions["outputColorSpace"],
  };
}
