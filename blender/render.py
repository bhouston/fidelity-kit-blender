# Render the version 1 package manifest to scene-linear premultiplied RGBA EXR.
# Usage: blender --background --factory-startup --python render.py -- job.json
import json
import sys
import math
from mathutils import Matrix, Vector, Quaternion

import bpy

with open(sys.argv[sys.argv.index("--") + 1], encoding="utf-8") as stream:
    job = json.load(stream)
if job.get("version") != 1:
    raise ValueError("Unsupported manifest version")

bpy.ops.wm.read_factory_settings(use_empty=True)
# COMPAT: three.js units (sun W/m² = lux, point W = cd * 4π)
bpy.ops.import_scene.gltf(filepath=job["gltf"], export_import_convert_lighting_mode="COMPAT")
scene = bpy.context.scene
# Three.js Y-up -> Blender Z-up. All explicit descriptors use Three.js coordinates.
coordinate = Matrix.Rotation(math.pi / 2, 4, "X")
selection = job.get("camera")
if isinstance(selection, dict):
    data = bpy.data.cameras.new("three_blender_camera")
    camera = bpy.data.objects.new("three_blender_camera", data)
    scene.collection.objects.link(camera)
    x, y, z, w = selection["quaternion"]
    matrix = Quaternion((w, x, y, z)).to_matrix().to_4x4()
    matrix.translation = Vector(selection["position"])
    camera.matrix_world = coordinate @ matrix
    data.clip_start = selection["near"]
    data.clip_end = selection["far"]
    if selection["type"] == "perspective":
        data.type = "PERSP"
        data.sensor_fit = "VERTICAL"
        data.sensor_height = 24
        data.lens = data.sensor_height / (2 * math.tan(selection["fov"] / 2))
    else:
        data.type = "ORTHO"
        left, right = selection["left"], selection["right"]
        bottom, top = selection["bottom"], selection["top"]
        aspect = job["width"] / job["height"]
        if abs((right-left)/(top-bottom) - aspect) > 1e-5:
            raise ValueError("Orthographic camera bounds must match output aspect ratio")
        data.ortho_scale = max(right-left, top-bottom)
        camera.matrix_world.translation += coordinate.to_3x3() @ Quaternion((w, x, y, z)) @ Vector(((left+right)/2, (bottom+top)/2, 0))
    scene.camera = camera
elif isinstance(selection, str):
    camera = bpy.data.objects.get(selection)
    if camera is None or camera.type != "CAMERA":
        raise ValueError("Selected imported camera was not found: " + selection)
    scene.camera = camera
else:
    scene.camera = next((obj for obj in scene.objects if obj.type == "CAMERA"), None)
if scene.camera is None:
    raise ValueError("Specify a camera or include one in the glTF")

if job["replaceLights"]:
    for obj in list(scene.objects):
        if obj.type == "LIGHT":
            bpy.data.objects.remove(obj, do_unlink=True)
for item in job["lights"]:
    kind = {"directional": "SUN", "point": "POINT", "spot": "SPOT"}[item["type"]]
    data = bpy.data.lights.new("three_blender_light", kind)
    data.color = item["color"]
    data.energy = item["intensity"] if kind == "SUN" else item["intensity"] * 4 * math.pi
    obj = bpy.data.objects.new(data.name, data)
    scene.collection.objects.link(obj)
    obj.location = coordinate.to_3x3() @ Vector(item["position"])
    if kind != "POINT":
        direction = coordinate.to_3x3() @ Vector(item["direction"])
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    if kind == "SPOT":
        outer = item["outerConeAngle"]
        data.spot_size = 2 * outer
        data.spot_blend = 1 - item["innerConeAngle"] / outer if outer > 0 else 0

for light in bpy.data.lights:  # glTF (and three.js) lights are punctual
    light.shadow_soft_size = 0
    if light.type == "SUN":
        light.angle = 0

# three.js culls back faces of single-sided materials (and the pathtracer skips them): make them transparent
for material in bpy.data.materials:
    if not material.use_backface_culling or not material.node_tree:
        continue
    tree = material.node_tree
    surface = next(node for node in tree.nodes if node.type == "OUTPUT_MATERIAL").inputs["Surface"]
    shader = surface.links[0].from_socket
    mix = tree.nodes.new("ShaderNodeMixShader")
    tree.links.new(tree.nodes.new("ShaderNodeNewGeometry").outputs["Backfacing"], mix.inputs["Fac"])
    tree.links.new(shader, mix.inputs[1])
    tree.links.new(tree.nodes.new("ShaderNodeBsdfTransparent").outputs["BSDF"], mix.inputs[2])
    tree.links.new(mix.outputs["Shader"], surface)

world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
background = world.node_tree.nodes["Background"]
environment = job.get("environment")
if environment:
    texture = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
    texture.image = bpy.data.images.load(environment["path"])
    # Conjugate inverse Three.js XYZ environment rotation into Blender coordinates.
    rx, ry, rz = environment["rotation"]
    c1, c2, c3 = (math.cos(v / 2) for v in (rx, ry, rz))
    s1, s2, s3 = (math.sin(v / 2) for v in (rx, ry, rz))
    q = Quaternion((c1*c2*c3-s1*s2*s3, s1*c2*c3+c1*s2*s3, c1*s2*c3-s1*c2*s3, c1*c2*s3+s1*s2*c3))
    rotation = coordinate.to_3x3() @ q.to_matrix().transposed() @ coordinate.to_3x3().transposed()
    mapping = world.node_tree.nodes.new("ShaderNodeMapping")
    mapping.vector_type = "VECTOR"
    mapping.inputs["Rotation"].default_value = rotation.to_euler()
    texcoord = world.node_tree.nodes.new("ShaderNodeTexCoord")
    world.node_tree.links.new(texcoord.outputs["Generated"], mapping.inputs["Vector"])
    world.node_tree.links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
    world.node_tree.links.new(texture.outputs["Color"], background.inputs["Color"])
    background.inputs["Strength"].default_value = environment["intensity"]
else:
    background.inputs["Color"].default_value = (0, 0, 0, 1)

scene.render.engine = "CYCLES"
cycles = scene.cycles
cycles.samples = job["samples"]
# adaptive sampling only stops sampling a pixel early once it has converged within the threshold: free speed, no bias
cycles.use_adaptive_sampling = True
cycles.adaptive_threshold = job["adaptiveThreshold"]
cycles.seed = job["seed"]
cycles.use_denoising = job["denoise"]
bounces = job["bounces"]
cycles.max_bounces = bounces
cycles.diffuse_bounces = bounces
cycles.glossy_bounces = bounces
cycles.transmission_bounces = bounces
if job["cameraOnlyEmission"]:  # direct: like the pathtracer, emissive surfaces are seen (camera rays) but light nothing
    for material in bpy.data.materials:
        tree = material.node_tree
        for node in list(tree.nodes) if tree else []:
            strength = node.inputs.get("Emission Strength") if node.type == "BSDF_PRINCIPLED" else None
            if strength is None or strength.is_linked:
                continue
            multiply = tree.nodes.new("ShaderNodeMath")
            multiply.operation = "MULTIPLY"
            multiply.inputs[1].default_value = strength.default_value
            tree.links.new(tree.nodes.new("ShaderNodeLightPath").outputs["Is Camera Ray"], multiply.inputs[0])
            tree.links.new(multiply.outputs["Value"], strength)
# unbiased, like the pathtracer (filterGlossyFactor 0, no clamping), box-filtered pixels
cycles.sample_clamp_direct = 0
cycles.sample_clamp_indirect = 0
cycles.blur_glossy = 0
cycles.caustics_reflective = True
cycles.caustics_refractive = True
cycles.pixel_filter_type = "BOX"
cycles.filter_width = 1

preferences = bpy.context.preferences.addons["cycles"].preferences
gpu_found = False
for device_type in (() if job["device"] == "cpu" else ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI")):
    try:
        preferences.compute_device_type = device_type
    except TypeError:
        continue
    preferences.get_devices()
    if any(device.type == device_type for device in preferences.devices):
        for device in preferences.devices:
            device.use = device.type == device_type
        cycles.device = "GPU"
        gpu_found = True
        break

if job["device"] == "gpu" and not gpu_found:
    raise RuntimeError("No supported Cycles GPU device is available")
if not gpu_found:
    cycles.device = "CPU"

# EXR stores scene-linear radiance; do not bake a Blender display transform.
scene.view_settings.view_transform = "Standard"
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
render = scene.render
render.film_transparent = job["transparent"]
render.resolution_x = job["width"]
render.resolution_y = job["height"]
render.resolution_percentage = 100
render.image_settings.file_format = "OPEN_EXR"
render.image_settings.color_depth = "32"
render.image_settings.color_mode = "RGBA"
render.filepath = job["output"]
bpy.ops.render.render(write_still=True)
