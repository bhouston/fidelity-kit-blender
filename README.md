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

Background types are `transparent`, `environment`, `color` (linear RGB), and `gradient` (linear center/edge RGB). When omitted from `renderScene`, simple scene backgrounds are extracted. Separate, blurred, or independently rotated texture backgrounds require an explicit supported background. Colors composite in linear space before tone mapping. Encoders consuming `result.pixels` must attach color metadata matching `result.outputColorSpace`; this API returns pixels rather than an encoded image file.

## Scope and diagnostics

The initial supported target is static scenes using MeshStandardMaterial/MeshPhysicalMaterial, ordinary perspective/orthographic cameras, RGBA8 readable material textures or native canvas images, and directional/point/spot lights. Skin/morph data travels through GLTFExporter; animated pose matching is not yet certified. Orthographic bounds must match output aspect. Camera view/film offsets require a replacement camera. No automatic model normalization or camera framing is performed.

Custom GLSL/TSL shaders, postprocessing, fog, area/ambient/hemisphere lights, projected spot textures, per-material tone-mapping bypass, finite light-distance cutoffs and nonphysical light decay are not translated. Unsupported features throw by default; `unsupported: 'warn'` reports through `onDiagnostic` (or console.warn) and permits deliberate approximations. Material replacement should be explicit. GLTFExporter/Blender material-extension coverage depends on both versions; validate advanced extensions against your own fixtures. Cycles and Three.js BRDFs, spot penumbra profiles, alpha handling, sampling and light transport can differ. This package does not promise pixel identity.

Rendering defaults: 256 samples, 8 bounces, seed 1, adaptive threshold 0.01, denoising off, automatic GPU selection with CPU fallback. Set `device: 'cpu' | 'gpu' | 'auto'`, `denoise`, `bounces`, or `adaptiveThreshold` explicitly as needed. `cameraOnlyEmission` supports fidelity suites that display emission but exclude its contribution to illumination. An environment background currently shares lighting intensity and rotation.

## Runtime utilities

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

Discovery uses an explicit executable or `BLENDER_EXECUTABLE` authoritatively; otherwise it tries PATH, macOS Applications directories, and custom candidates. Execution uses no shell, retains bounded failure output, supports cancellation/timeouts and process-group cleanup on POSIX. On Windows, cancellation terminates the direct child; complete helper-process cleanup is not yet supported. MaterialX-specific scripts and custom runtime probes belong in consuming adapters.

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
