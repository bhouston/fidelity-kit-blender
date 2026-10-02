# fidelity-kit-blender

Render glTF assets and Three.js scenes with Blender Cycles. Includes Blender discovery and subprocess utilities for other fidelity-kit adapters. Node 24+ and Blender 4.0+ are required. Blender is installed separately; nothing is downloaded or installed at render time.

```sh
npm install fidelity-kit-blender three
```

```ts
import { renderScene } from "fidelity-kit-blender/three";

const result = await renderScene({
  scene,
  camera,
  environment: {
    path: "/assets/studio.exr",
    intensity: 1,
    rotation: [0, Math.PI / 2, 0],
  },
  width: 1024,
  height: 1024,
  samples: 256,
  background: { type: "transparent" },
  toneMapping: "aces-filmic",
  toneMappingExposure: 1,
  outputColorSpace: "srgb",
});
// result.pixels: top-first straight-alpha RGBA8
// result.linear: top-first premultiplied scene-linear Float32 RGBA
```

For an existing asset, `renderGLTF` from the main entry point accepts `gltf: '/assets/model.glb'` (or GLB bytes) and the same render settings. A `.gltf` path preserves resolution of its external buffers/textures. Supply a camera descriptor, select an imported camera by name, or omit `camera` to use the first imported camera. Additional light descriptors use Three.js Y-up coordinates, linear-sRGB colors, directional lux, and point/spot candela. Set `replaceLights: true` to replace imported lights instead of adding to them. File-based glTF and IBL rendering needs no WebGL or DOM setup.

## Explicit settings and extraction

Tone mapping, exposure, output color space, and dimensions are explicit. `outputSettings(renderer)` copies the three color settings from an explicitly supplied Three.js renderer. Built-in tone mappings are `none`, `linear`, `reinhard`, `cineon`, `aces-filmic`, `agx`, and `neutral`; a `(linearRGB, exposure) => linearRGB` callback supplies a custom operator. `none` ignores exposure, matching Three.js. Output encoding uses the exact piecewise sRGB transfer function. `srgb-linear` omits that transfer function; RGBA8 still clips to [0, 1]. Use `result.linear` for unclipped HDR.

The Three.js adapter exports a cloned scene to GLB, transfers the selected camera and punctual lights separately, and preserves source parents, light targets, and materials. It temporarily installs serialized Node canvas/FileReader bindings during export and restores the previous globals; avoid unrelated DOM operations during export in the same process.

Environment input accepts exactly one of `path` (HDR/EXR) or `bytes` (HDR/EXR bytes), with optional intensity and rotation. Rotation is an XYZ Euler triple **in radians**, in Three.js Y-up coordinates, matching `Scene.environmentRotation`; positive Y rotates the environment around world up. When environment is omitted, a readable RGBA float/half-float equirectangular `scene.environment` is exported, including its intensity and rotation. A GPU-only, PMREM, compressed, cube, or procedural environment needs an explicit original IBL. Callers may bake procedural environments themselves and pass the result; the package does not initialize a GPU renderer to infer them. Set `environment: null` to disable environment lighting.

Background types are `transparent`, `environment`, `color` (linear RGB), and `gradient` (linear center/edge RGB). When omitted from `renderScene`, simple scene backgrounds are extracted. Separate readable equirectangular texture backgrounds can be extracted with `features: { textureBackground: true }`, or supplied explicitly as `{ type: "equirectangular", texture: { path: "/assets/background.exr", intensity: 1, rotation: [0, 0, 0] } }`. Background input accepts the same path/bytes format as environment input and has independent intensity and rotation. Blurred or GPU-only backgrounds still require a baked replacement. Colors composite in linear space before tone mapping. Encoders consuming `result.pixels` must attach color metadata matching `result.outputColorSpace`; this API returns pixels rather than an encoded image file.

## Scope and diagnostics

The initial supported target is static scenes using MeshStandardMaterial/MeshPhysicalMaterial, ordinary perspective/orthographic cameras, physical perspective-camera depth of field, rectangular/circular area lights, RGBA8 readable material textures or native canvas images, and directional/point/spot lights. Skin/morph data travels through GLTFExporter; animated pose matching is not yet certified. Orthographic bounds must match output aspect. Camera view/film offsets require a replacement camera. No automatic model normalization or camera framing is performed.

Custom GLSL/TSL shaders, postprocessing, fog, ambient/hemisphere lights, projected spot textures, per-material tone-mapping bypass, finite light-distance cutoffs and nonphysical light decay are not translated. Unsupported features throw by default; `unsupported: 'warn'` reports through `onDiagnostic` (or console.warn) and permits deliberate approximations. Material replacement should be explicit. GLTFExporter/Blender material-extension coverage depends on both versions; validate advanced extensions against your own fixtures. Cycles and Three.js BRDFs, spot penumbra profiles, alpha handling, sampling and light transport can differ. This package does not promise pixel identity.

Rendering defaults: 256 samples, 8 bounces, seed 1, adaptive threshold 0.01, denoising off, automatic GPU selection with CPU fallback. Set `device: 'cpu' | 'gpu' | 'auto'`, `denoise`, `bounces`, or `adaptiveThreshold` explicitly as needed. An `environment` background shares lighting intensity and rotation; an `equirectangular` background is independent. Setting `adaptiveThreshold: 0` disables adaptive sampling. An all-black output (every RGB value 0) throws, since it usually means a failed render; set `failAllBlack: false` for scenes that are expected to be black.

## Area lights and depth of field

Enable area-light and physical-camera depth-of-field extraction with
`features: { areaLights: true, depthOfField: true }` in `renderScene`. Defaults retain strict diagnostics;
explicit `renderGLTF` area-light and camera descriptors are accepted directly. `RectAreaLight` emits along local -Z; position and quaternion are world-space, while width/height are
unscaled world units, matching the legacy pathtracer. `isCircular: true` selects an elliptical emitter. Color times
intensity is linear radiance; Cycles power is radiance × emitting area × π. Camera rays do not show the light.
The explicit `renderGLTF` descriptor is `{ type: "area", position, quaternion, color, intensity, width, height,
circular?: boolean }`; quaternions use XYZW order and must be unit length.

A perspective camera with positive `bokehSize` and `focusDistance` carries its depth of field when `features.depthOfField` is enabled.
`bokehSize` is aperture **diameter in millimeters**; focus distance is in scene world units. Optional
`apertureBlades` (0 or >= 3) and `apertureRotation` (radians) are preserved. The explicit camera descriptor accepts
`depthOfField: { apertureDiameter, focusDistance, apertureBlades?, apertureRotation? }`.
`bokehSize: 0` leaves depth of field disabled. Anamorphic ratios other than 1 are rejected pending a certified
mapping. Area-light sampling and aperture distributions can still differ between Cycles and the pathtracer.

## Runtime utilities

Blender subprocesses run just below normal CPU scheduling priority (nice `+1` on macOS/Linux, Below Normal on Windows). An already lower inherited priority is preserved. If the OS rejects the adjustment, the renderer warns and continues. This does not change the calling application's priority or GPU scheduling.

```ts
import { discoverBlender, runBlender } from "fidelity-kit-blender/runtime";
const runtime = await discoverBlender({ executable: "/path/to/Blender" });
await runBlender(
  runtime.executable,
  ["--background", "--python-exit-code", "1", "--python", script],
  {
    signal: controller.signal,
    timeoutMs: 60_000,
    onLog: console.log,
  },
);
```

Discovery uses an explicit executable or `BLENDER_EXECUTABLE` authoritatively; otherwise it tries PATH, macOS Applications directories, the official Windows installer's `%ProgramFiles%\Blender Foundation\Blender <version>` directories (newest first), and custom candidates. Microsoft Store builds of Blender cannot run headless; install the official build or set `BLENDER_EXECUTABLE`. Execution uses no shell, retains bounded failure output, supports cancellation/timeouts and process-group cleanup on POSIX. On Windows, cancellation terminates the direct child; complete helper-process cleanup is not yet supported. MaterialX-specific scripts and custom runtime probes belong in consuming adapters.

## Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm tsc
pnpm lint
pnpm test --coverage
BLENDER_INTEGRATION=1 BLENDER_EXECUTABLE=/path/to/Blender pnpm test
```

The Python worker uses a versioned JSON manifest, built-in glTF importer and Cycles. It writes scene-linear EXR; Three.js tone mapping runs in Node, avoiding Blender display-transform differences. Every render runs in an isolated Blender process and cleans its temporary directory. Prepared-scene caching and persistent workers are future extensions.

Color operators are adapted from the MIT-licensed Three.js shader implementations (copyright Three.js authors). GLTFExporter, EXRExporter and EXRLoader are used from the caller's Three.js peer dependency.
