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
        camera.matrix_world.translation += coordinate.to_3x3() @ (Quaternion((w, x, y, z)) @ Vector(((left+right)/2, (bottom+top)/2, 0)))
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

dof = selection.get("depthOfField") if isinstance(selection, dict) else None
if dof:
    data = scene.camera.data
    data.dof.use_dof = True
    data.dof.focus_distance = dof["focusDistance"]
    data.dof.aperture_fstop = data.lens / dof["apertureDiameter"]
    data.dof.aperture_blades = dof.get("apertureBlades", 0)
    data.dof.aperture_rotation = dof.get("apertureRotation", 0)

if job["replaceLights"]:
    for obj in list(scene.objects):
        if obj.type == "LIGHT":
            bpy.data.objects.remove(obj, do_unlink=True)
for item in job["lights"]:
    kind = {"directional": "SUN", "point": "POINT", "spot": "SPOT", "area": "AREA"}[item["type"]]
    data = bpy.data.lights.new("three_blender_light", kind)
    data.color = item["color"]
    data.energy = item["intensity"] if kind == "SUN" else item["intensity"] * 4 * math.pi
    obj = bpy.data.objects.new(data.name, data)
    scene.collection.objects.link(obj)
    obj.location = coordinate.to_3x3() @ Vector(item["position"])
    if kind == "AREA":
        data.shape = "ELLIPSE" if item.get("circular") else "RECTANGLE"
        data.size = item["width"]
        data.size_y = item["height"]
        surface = item["width"] * item["height"] * (math.pi / 4 if item.get("circular") else 1)
        data.energy = item["intensity"] * surface * math.pi
        x, y, z, w = item["quaternion"]
        rotation = Quaternion((w, x, y, z)).to_matrix().to_4x4()
        rotation.translation = Vector(item["position"])
        obj.matrix_world = coordinate @ rotation
        obj.visible_camera = False
    elif kind != "POINT":
        direction = coordinate.to_3x3() @ Vector(item["direction"])
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    if kind == "SPOT":
        outer = item["outerConeAngle"]
        data.spot_size = 2 * outer
        data.spot_blend = 1 - item["innerConeAngle"] / outer if outer > 0 else 0

for light in bpy.data.lights:  # glTF (and three.js) lights are punctual
    if light.type in ("POINT", "SPOT", "SUN"):
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
def environment_shader(source, shader):
    texture = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
    texture.image = bpy.data.images.load(source["path"])
    # Conjugate inverse Three.js XYZ environment rotation into Blender coordinates.
    rx, ry, rz = source["rotation"]
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
    world.node_tree.links.new(texture.outputs["Color"], shader.inputs["Color"])
    shader.inputs["Strength"].default_value = source["intensity"]
if environment:
    environment_shader(environment, background)
else:
    background.inputs["Color"].default_value = (0, 0, 0, 1)
    background.inputs["Strength"].default_value = 0
backdrop = job.get("backgroundTexture")
if backdrop:
    nodes, links = world.node_tree.nodes, world.node_tree.links
    shader = nodes.new("ShaderNodeBackground")
    environment_shader(backdrop, shader)
    # Camera and transmission-only paths see the independent background, while other rays see the IBL.
    light_path = nodes.new("ShaderNodeLightPath")
    depth = nodes.new("ShaderNodeMath")
    depth.operation = "SUBTRACT"
    links.new(light_path.outputs["Ray Depth"], depth.inputs[0])
    links.new(light_path.outputs["Transmission Depth"], depth.inputs[1])
    seen = nodes.new("ShaderNodeMath")
    seen.operation = "COMPARE"
    seen.inputs[1].default_value = 1
    seen.inputs[2].default_value = 0.5
    links.new(depth.outputs["Value"], seen.inputs[0])
    mix = nodes.new("ShaderNodeMixShader")
    links.new(seen.outputs["Value"], mix.inputs["Fac"])
    links.new(background.outputs["Background"], mix.inputs[1])
    links.new(shader.outputs["Background"], mix.inputs[2])
    links.new(mix.outputs["Shader"], nodes["World Output"].inputs["Surface"])

scene.render.engine = "CYCLES"
cycles = scene.cycles
cycles.samples = job["samples"]
# adaptive sampling only stops sampling a pixel early once it has converged within the threshold: free speed, no bias
cycles.use_adaptive_sampling = job["adaptiveThreshold"] > 0
cycles.adaptive_threshold = job["adaptiveThreshold"]
cycles.seed = job["seed"]
cycles.use_denoising = job["denoise"]
bounces = job["bounces"]
cycles.max_bounces = bounces
cycles.diffuse_bounces = bounces
cycles.glossy_bounces = bounces
cycles.transmission_bounces = bounces
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
