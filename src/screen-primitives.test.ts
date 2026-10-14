import { expect, it } from "vitest";
import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineSegments,
  LineBasicMaterial,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  Vector3,
} from "three";
import { bakeScreenPrimitives } from "./screen-primitives.js";
import { exportScene } from "./three.js";

function pointScene(sizeAttenuation = false) {
  const scene = new Scene();
  const points = new Points(
    new BufferGeometry().setAttribute("position", new Float32BufferAttribute([0, 0, 0], 3)),
    new PointsMaterial({ color: 0xff0000, size: 4, sizeAttenuation }),
  );
  scene.add(points);
  return { scene, points };
}
function projectedSize(
  mesh: Mesh,
  camera: OrthographicCamera | PerspectiveCamera,
  width: number,
  height: number,
) {
  mesh.updateWorldMatrix(true, false);
  const position = mesh.geometry.getAttribute("position");
  const vertices = Array.from({ length: position.count }, (_, i) =>
    new Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).project(camera),
  );
  return [
    ((Math.max(...vertices.map((v) => v.x)) - Math.min(...vertices.map((v) => v.x))) * width) / 2,
    ((Math.max(...vertices.map((v) => v.y)) - Math.min(...vertices.map((v) => v.y))) * height) / 2,
  ];
}
it("preserves point pixel dimensions through parent scale and non-square viewports", () => {
  const { scene, points } = pointScene();
  const group = new Group();
  group.position.x = 0.25;
  group.scale.setScalar(2);
  group.add(points);
  scene.add(group);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3;
  bakeScreenPrimitives(scene, { camera, width: 64, height: 32 });
  expect(projectedSize(group.children[0] as Mesh, camera, 64, 32)).toEqual([4, 4]);
});
it("matches perspective point attenuation and clips point centers outside the frustum", () => {
  const { scene, points } = pointScene(true);
  points.material.size = 1;
  points.geometry.setAttribute(
    "position",
    new Float32BufferAttribute([0, 0, 0, 0, 0, 5, 100, 0, 0], 3),
  );
  const camera = new PerspectiveCamera(90, 1, 0.1, 100);
  camera.position.z = 4;
  bakeScreenPrimitives(scene, { camera, width: 64, height: 64 });
  const mesh = scene.children[0] as Mesh;
  expect(mesh.geometry.getAttribute("position").count).toBe(6);
  const size = projectedSize(mesh, camera, 64, 64);
  expect(size[0]).toBeCloseTo(8);
  expect(size[1]).toBeCloseTo(8);
});
it("clips lines at the frustum and interpolates their vertex colors", () => {
  const scene = new Scene();
  const geometry = new BufferGeometry()
    .setAttribute("position", new Float32BufferAttribute([-2, 0, 0, 2, 0, 0], 3))
    .setAttribute("color", new Float32BufferAttribute([1, 0, 0, 0, 0, 1], 3));
  scene.add(new LineSegments(geometry, new LineBasicMaterial({ vertexColors: true })));
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3;
  bakeScreenPrimitives(scene, { camera, width: 32, height: 32 });
  const mesh = scene.children[0] as Mesh,
    colors = mesh.geometry.getAttribute("color");
  expect(projectedSize(mesh, camera, 32, 32)).toEqual([32, 1]);
  expect([colors.getX(0), colors.getZ(0), colors.getX(2), colors.getZ(2)]).toEqual([
    0.75, 0.25, 0.25, 0.75,
  ]);
});
it("keeps strict diagnostics by default and leaves source primitives intact during export", async () => {
  const { scene, points } = pointScene();
  const geometry = points.geometry,
    material = points.material;
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3;
  await expect(exportScene(scene)).rejects.toThrow("Unsupported material PointsMaterial");
  const glb = await exportScene(scene, undefined, { camera, width: 16, height: 16 });
  const length = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
  expect(json.meshes[0].primitives[0].mode ?? 4).toBe(4);
  expect(json.materials[0].extensions.KHR_materials_unlit).toEqual({});
  expect(scene.children).toEqual([points]);
  expect(points.geometry).toBe(geometry);
  expect(points.material).toBe(material);
});
