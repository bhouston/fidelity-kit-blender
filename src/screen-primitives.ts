import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  Vector4,
} from "three";
import type {
  Camera,
  Line,
  LineBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Points,
  PointsMaterial,
} from "three";

export type ScreenPrimitiveContext = { camera: Camera; width: number; height: number };

/** Bake untextured raster primitives into triangle surfaces for this camera and physical viewport. */
export function bakeScreenPrimitives(scene: Object3D, context: ScreenPrimitiveContext): void {
  const { camera, width, height } = context;
  if (![width, height].every((value) => Number.isInteger(value) && value > 0))
    throw new Error("Invalid primitive viewport");
  camera.updateWorldMatrix(true, false);
  scene.updateWorldMatrix(true, true);
  const projectionCamera = camera.clone();
  if ((projectionCamera as PerspectiveCamera).isPerspectiveCamera) {
    (projectionCamera as PerspectiveCamera).aspect = width / height;
    (projectionCamera as PerspectiveCamera).updateProjectionMatrix();
  }
  const project = new Matrix4().multiplyMatrices(
    projectionCamera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  const inverseProject = project.clone().invert();
  const objects: (Points | Line)[] = [];
  scene.traverse((object) => {
    if ((object as Points).isPoints || (object as Line).isLine)
      objects.push(object as Points | Line);
  });
  for (const object of objects) {
    const source = object.material as PointsMaterial | LineBasicMaterial;
    if (
      Array.isArray(source) ||
      (!(source as PointsMaterial).isPointsMaterial &&
        !(source as LineBasicMaterial).isLineBasicMaterial) ||
      (source as unknown as { isLineDashedMaterial?: boolean }).isLineDashedMaterial
    )
      throw new Error("Screen primitives require PointsMaterial or solid LineBasicMaterial");
    if (source.map || (source as PointsMaterial).alphaMap)
      throw new Error("Textured screen primitives require an explicit triangle replacement");
    const geometry = object.geometry;
    const position = geometry.getAttribute("position");
    const color = source.vertexColors ? geometry.getAttribute("color") : undefined;
    const inverseWorld = object.matrixWorld.clone().invert();
    const positions: number[] = [],
      colors: number[] = [];
    const count = geometry.index?.count ?? position.count;
    const start = geometry.drawRange.start;
    const end = Math.min(count, start + geometry.drawRange.count);
    const vertex = (ordinal: number) => geometry.index?.getX(ordinal) ?? ordinal;
    const world = (index: number) =>
      new Vector3().fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld);
    const clip = (point: Vector3) =>
      new Vector4(point.x, point.y, point.z, 1).applyMatrix4(project);
    const ndc = (point: Vector4) =>
      new Vector3(point.x / point.w, point.y / point.w, point.z / point.w);
    const add = (corners: Vector3[], indices: number[]) => {
      for (const corner of [0, 1, 2, 0, 2, 3]) {
        positions.push(
          ...corners[corner]!.clone()
            .applyMatrix4(inverseProject)
            .applyMatrix4(inverseWorld)
            .toArray(),
        );
        if (color) {
          const index = indices[corner]!;
          colors.push(color.getX(index), color.getY(index), color.getZ(index));
          if (color.itemSize === 4) colors.push(color.getW(index));
        }
      }
    };
    if ((object as Points).isPoints) {
      const material = source as PointsMaterial;
      if (!Number.isFinite(material.size) || material.size < 0)
        throw new Error("Invalid point size");
      for (let ordinal = start; ordinal < end; ordinal++) {
        const index = vertex(ordinal),
          point = world(index),
          projected = clip(point);
        if (
          projected.w <= 0 ||
          [projected.x, projected.y, projected.z].some((value) => Math.abs(value) > projected.w)
        )
          continue;
        let size = material.size;
        if (material.sizeAttenuation && (camera as PerspectiveCamera).isPerspectiveCamera)
          size *= height / (2 * -point.clone().applyMatrix4(camera.matrixWorldInverse).z);
        const p = ndc(projected),
          dx = size / width,
          dy = size / height;
        add(
          [
            new Vector3(p.x - dx, p.y - dy, p.z),
            new Vector3(p.x + dx, p.y - dy, p.z),
            new Vector3(p.x + dx, p.y + dy, p.z),
            new Vector3(p.x - dx, p.y + dy, p.z),
          ],
          [index, index, index, index],
        );
      }
    } else {
      const material = source as LineBasicMaterial;
      if (material.linewidth !== 1)
        throw new Error("Screen primitive capture supports the standard one-pixel line width");
      const segments: [number, number][] = [];
      for (
        let ordinal = start;
        ordinal + 1 < end;
        ordinal += (object as Line & { isLineSegments?: boolean }).isLineSegments ? 2 : 1
      )
        segments.push([vertex(ordinal), vertex(ordinal + 1)]);
      if ((object as Line & { isLineLoop?: boolean }).isLineLoop && end - start > 1)
        segments.push([vertex(end - 1), vertex(start)]);
      for (const [a, b] of segments) {
        const first = world(a),
          second = world(b),
          c0 = clip(first),
          c1 = clip(second);
        const distances = (p: Vector4) => [
          p.w + p.x,
          p.w - p.x,
          p.w + p.y,
          p.w - p.y,
          p.w + p.z,
          p.w - p.z,
        ];
        const d0 = distances(c0),
          d1 = distances(c1);
        let low = 0,
          high = 1;
        for (let plane = 0; plane < 6; plane++) {
          const x = d0[plane]!,
            y = d1[plane]!;
          if (x < 0 && y < 0) {
            high = -1;
            break;
          }
          if (x < 0) low = Math.max(low, x / (x - y));
          if (y < 0) high = Math.min(high, x / (x - y));
        }
        if (low > high) continue;
        const p0 = ndc(clip(first.clone().lerp(second, low))),
          p1 = ndc(clip(first.clone().lerp(second, high)));
        const x = ((p1.x - p0.x) * width) / 2,
          y = ((p1.y - p0.y) * height) / 2,
          length = Math.hypot(x, y);
        if (length < 1e-10) continue;
        const dx = -y / length / width,
          dy = x / length / height;
        // Vertex colors are interpolated at the clipped endpoints, as on the original line.
        const before = colors.length;
        add(
          [
            new Vector3(p0.x + dx, p0.y + dy, p0.z),
            new Vector3(p0.x - dx, p0.y - dy, p0.z),
            new Vector3(p1.x - dx, p1.y - dy, p1.z),
            new Vector3(p1.x + dx, p1.y + dy, p1.z),
          ],
          [a, a, b, b],
        );
        if (color)
          for (let i = 0; i < 6; i++) {
            const t = [low, low, high, low, high, high][i]!;
            for (let channel = 0; channel < color.itemSize; channel++) {
              const read = (index: number) =>
                [
                  color.getX(index),
                  color.getY(index),
                  color.getZ(index),
                  color.itemSize === 4 ? color.getW(index) : 1,
                ][channel]!;
              colors[before + i * color.itemSize + channel] = read(a) * (1 - t) + read(b) * t;
            }
          }
      }
    }
    const triangles = new BufferGeometry();
    triangles.setAttribute("position", new Float32BufferAttribute(positions, 3));
    if (color) triangles.setAttribute("color", new Float32BufferAttribute(colors, color.itemSize));
    triangles.computeVertexNormals();
    const material = new MeshBasicMaterial({
      color: source.color,
      vertexColors: source.vertexColors,
      opacity: source.opacity,
      transparent: source.transparent,
      alphaTest: source.alphaTest,
      side: DoubleSide,
      toneMapped: source.toneMapped,
      depthTest: source.depthTest,
      depthWrite: source.depthWrite,
    });
    const replacement = new Mesh(triangles, material);
    replacement.name = object.name;
    replacement.position.copy(object.position);
    replacement.quaternion.copy(object.quaternion);
    replacement.scale.copy(object.scale);
    replacement.matrix.copy(object.matrix);
    replacement.matrixAutoUpdate = object.matrixAutoUpdate;
    replacement.visible = object.visible;
    replacement.userData = structuredClone(object.userData);
    const parent = object.parent;
    if (parent) {
      const index = parent.children.indexOf(object);
      parent.children[index] = replacement;
      replacement.parent = parent;
      object.parent = null;
    }
    for (const child of object.children.slice()) replacement.add(child);
  }
}
