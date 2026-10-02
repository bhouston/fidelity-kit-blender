export type Vec3 = [number, number, number];
export type ToneMapping =
  | "none"
  | "linear"
  | "reinhard"
  | "cineon"
  | "aces-filmic"
  | "agx"
  | "neutral";
/** All colors are linear sRGB. Rotation is XYZ Euler radians in Three.js Y-up coordinates. */
export interface Environment {
  path?: string;
  bytes?: Uint8Array;
  intensity?: number;
  rotation?: Vec3;
}
export type Background =
  | { type: "transparent" }
  | { type: "environment" }
  | { type: "color"; color: Vec3 }
  | { type: "gradient"; center: Vec3; edge: Vec3 }
  | { type: "equirectangular"; texture: Environment };
export interface DepthOfField {
  /** Aperture diameter in millimeters, matching PhysicalCamera.bokehSize. */
  apertureDiameter: number;
  /** Distance along the camera axis in scene world units. */
  focusDistance: number;
  /** 0 for a disk, or an integer >= 3 for a polygon. */
  apertureBlades?: number;
  /** Radians. */
  apertureRotation?: number;
}
export interface Camera {
  type: "perspective" | "orthographic";
  position: Vec3;
  quaternion: [number, number, number, number];
  near: number;
  far: number;
  /** Vertical field of view in radians. */
  fov?: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  depthOfField?: DepthOfField;
}
/** Intensity: directional lux; point/spot candela, matching Three.js/glTF. */
export interface PunctualLight {
  type: "directional" | "point" | "spot";
  position: Vec3;
  direction?: Vec3;
  color: Vec3;
  intensity: number;
  innerConeAngle?: number;
  outerConeAngle?: number;
}
/** Area-light intensity is linear radiance; width/height are world units, unaffected by parent scale. */
export interface AreaLight {
  type: "area";
  position: Vec3;
  quaternion: [number, number, number, number];
  color: Vec3;
  intensity: number;
  width: number;
  height: number;
  circular?: boolean;
}
export type Light = PunctualLight | AreaLight;
export interface RenderOptions {
  width: number;
  height: number;
  samples?: number;
  bounces?: number;
  seed?: number;
  denoise?: boolean;
  adaptiveThreshold?: number;
  device?: "auto" | "cpu" | "gpu";
  environment?: Environment | null;
  background: Background;
  toneMapping: ToneMapping | ((rgb: Vec3, exposure: number) => Vec3);
  toneMappingExposure: number;
  outputColorSpace: "srgb" | "srgb-linear";
  executable?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLog?: (line: string) => void;
}
export interface RenderResult {
  width: number;
  height: number;
  /** Scene-linear, premultiplied RGBA, top row first; no tone mapping or background compositing. */
  linear: Float32Array;
  /** Output RGBA8, top row first. Alpha is straight (unassociated). */
  pixels: Uint8Array;
  outputColorSpace: RenderOptions["outputColorSpace"];
  blenderVersion: string;
}
