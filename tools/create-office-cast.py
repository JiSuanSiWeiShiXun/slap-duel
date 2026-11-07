"""Original office cast: parameter source -> weighted FBX + same-source portrait.

Uses the project-local, verified Blender portable. No third-party models, textures,
downloads or Python dependencies. Native .blend files and logs stay in game/local.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import zlib

ROOT = Path(__file__).resolve().parent.parent
ROLES = ('manager', 'veteran', 'rookie')
GENERATOR_VERSION = 'office-cast-1'
RIG_VERSION = 'office-humanoid-29-v1'
CLIPS = [('idle', 120), ('intro-positive', 60), ('intro-negative', 60),
         ('charge', 72), ('attack-light', 60), ('attack-heavy', 60), ('recovery', 60),
         ('guard', 60), ('hit', 30), ('counter', 60), ('counter-recovery', 60),
         ('victory', 90), ('defeat', 90)]


def canonical(value):
    def normalize(item):
        if isinstance(item, dict): return {key: normalize(v) for key, v in item.items()}
        if isinstance(item, list): return [normalize(v) for v in item]
        if isinstance(item, float) and item.is_integer(): return int(item)
        return item
    return json.dumps(normalize(value), sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path = bounded(path, ROOT)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def bounded(path, base):
    path = Path(path).absolute()
    if '..' in path.parts:
        raise ValueError('Parent traversal is not permitted')
    resolved = path.resolve()
    if not resolved.is_relative_to(base.resolve()):
        raise ValueError('Output/source is outside the permitted project subtree')
    cursor = path
    while cursor != base.parent:
        if cursor.is_symlink() or cursor.exists() and getattr(cursor.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('Symlink/junction/reparse paths are not supported')
        if cursor == base:
            break
        cursor = cursor.parent
    return resolved


def paths(args):
    source_root = bounded(args.source_root or ROOT, ROOT)
    output_root = bounded(args.output_root or ROOT, ROOT)
    copies = ROOT / 'game/local/asset-rebuild'
    if source_root != ROOT and not source_root.is_relative_to(copies):
        raise ValueError('Only original sources or isolated rebuild sources are allowed')
    if output_root != ROOT and not output_root.is_relative_to(copies):
        raise ValueError('Only project-local rebuild outputs are allowed')
    marker = bounded(output_root / '.office-cast-rebuild', output_root)
    if output_root != ROOT and not marker.exists():
        # Caller owns a fresh copy; don't permit overwriting an existing project.
        if (output_root / 'game/assets/resources/office-cast').exists():
            raise ValueError('Rebuild target already contains generated cast; choose a new copy')
        output_root.mkdir(parents=True, exist_ok=True)
        marker.write_text('office-cast controlled rebuild\n', encoding='utf-8')
    asset = bounded(output_root / 'game/assets/resources/office-cast' / args.role, output_root)
    source = bounded(source_root / 'game/assets/resources/office-cast' / args.role / 'manifest.json', source_root)
    return source_root, output_root, asset, source


def default_source(role):
    common = {'roleId': role, 'assetRevision': 1, 'rigSpecVersion': RIG_VERSION,
              'generatorVersion': GENERATOR_VERSION, 'blenderVersion': '4.5.14 LTS',
              'provenance': {'kind': 'original-procedural', 'author': 'Slap Duel project',
                             'license': 'Project original assets; editable generation source included',
                             'source': 'tools/create-office-cast.py'},
              'guardHand': 'lead', 'counterHand': 'rear',
              'export': {'fps': 60, 'forward': '-Z', 'up': 'Y', 'scale': 1,
                         'leafBones': False, 'allActions': False, 'nla': False,
                         'bakeSpaceTransform': False, 'animationBakeRate': 60},
              'portrait': {'size': 512, 'samples': 20, 'pose': 'intro-positive'}}
    specific = {
        'manager': {'displayName': '职场中层', 'facets': {'positive': '表达有条理，擅长把复杂信息组织成一场清晰的汇报。',
                       'negative': '把同事做出的成果，包装成了自己精心部署的功劳。'},
                    'appearance': {'outfit': 'blazer', 'hair': 'swept', 'glasses': False, 'badge': False,
                                   'skin': '#D7A17F', 'cloth': '#35516D', 'shirt': '#E7E3D8', 'dark': '#292735'},
                    'proportions': {'height': 1.0, 'shoulder': 1.05, 'waist': 1.12, 'head': 1.0, 'arm': 1.0},
                    'motionProfile': {'energy': 0.35, 'slouch': 0.0, 'chin': 0.055, 'lean': 0.0, 'smirk': 0.035}},
        'veteran': {'displayName': '资深同事', 'facets': {'positive': '经验足，评估一件事总能把前因后果想得周全。',
                       'negative': '每个流程都很熟，却总能找到把工作推回去的理由。'},
                    'appearance': {'outfit': 'cardigan', 'hair': 'receding', 'glasses': True, 'badge': False,
                                   'skin': '#C99476', 'cloth': '#66786A', 'shirt': '#D5D1BF', 'dark': '#333439'},
                    'proportions': {'height': 1.0, 'shoulder': 0.93, 'waist': 1.24, 'head': 0.96, 'arm': 0.98},
                    'motionProfile': {'energy': 0.16, 'slouch': 0.12, 'chin': -0.03, 'lean': -0.035, 'smirk': -0.005}},
        'rookie': {'displayName': '职场新人', 'facets': {'positive': '有干劲，对新任务总抱着积极的期待。',
                       'negative': '还没想清楚就一口接下任务，转头把同事也卷了进来。'},
                   'appearance': {'outfit': 'shirt', 'hair': 'tousled', 'glasses': False, 'badge': True,
                                  'skin': '#E2B18E', 'cloth': '#658EAD', 'shirt': '#DDE6EC', 'dark': '#303846'},
                   'proportions': {'height': 1.04, 'shoulder': 0.89, 'waist': 0.85, 'head': 0.97, 'arm': 1.03},
                   'motionProfile': {'energy': 0.85, 'slouch': 0.025, 'chin': 0.015, 'lean': 0.045, 'smirk': 0.015}},
    }[role]
    return {**common, **specific}


def validate_source(source, role):
    if source.get('roleId') != role or source.get('rigSpecVersion') != RIG_VERSION:
        raise ValueError('Role/rig specification mismatch')
    if source.get('provenance', {}).get('kind') != 'original-procedural':
        raise ValueError('An original source record is required')
    supported = default_source(role)
    for key in ('generatorVersion', 'blenderVersion', 'export', 'guardHand', 'counterHand'):
        if source.get(key) != supported[key]:
            raise ValueError('Unsupported production declaration: ' + key)
    if source['provenance'].get('source') != 'tools/create-office-cast.py':
        raise ValueError('Unsupported generator source declaration')
    for key, value in source['proportions'].items():
        if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0.7 <= value <= 1.35:
            raise ValueError('Proportion outside the supported production range: ' + key)
    for key, value in source['motionProfile'].items():
        if not isinstance(value, (int, float)) or not math.isfinite(value) or not -0.3 <= value <= 1.2:
            raise ValueError('Motion profile outside the supported range: ' + key)
    if source['appearance']['outfit'] not in ('blazer', 'cardigan', 'shirt'):
        raise ValueError('Unsupported outfit')
    if source['appearance']['hair'] not in ('swept', 'receding', 'tousled'):
        raise ValueError('Unsupported hair')
    if source['portrait']['size'] not in (256, 512, 768):
        raise ValueError('Unsupported portrait resolution')
    if source['portrait'].get('pose') not in ('intro-positive', 'intro-negative'):
        raise ValueError('Unsupported portrait pose')
    if not 4 <= source['portrait']['samples'] <= 64:
        raise ValueError('Unsupported render samples')


def strip_png(path):
    path = bounded(path, ROOT)
    raw = path.read_bytes()
    assert raw[:8] == b'\x89PNG\r\n\x1a\n'
    clean, offset = bytearray(raw[:8]), 8
    while offset < len(raw):
        size = struct.unpack_from('>I', raw, offset)[0]
        chunk = raw[offset + 4:offset + 8]
        assert size <= 32 * 1024 * 1024 and offset + size + 12 <= len(raw)
        if chunk in (b'IHDR', b'IDAT', b'IEND', b'sRGB', b'gAMA', b'cHRM'):
            clean.extend(raw[offset:offset + size + 12])
        offset += size + 12
    path.write_bytes(clean)


def make_character(source, output, native):
    import bpy
    from mathutils import Vector, Matrix, Quaternion
    if bpy.app.version_string != source['blenderVersion']:
        raise RuntimeError('Blender runtime does not match the recorded source version')
    output, native = bounded(output, ROOT), bounded(native, ROOT)
    for name in ('character.fbx', 'portrait.png'):
        bounded(output / name, ROOT)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.fps = 60
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1
    p, appearance, profile = source['proportions'], source['appearance'], source['motionProfile']
    height, shoulder, waist, head_size, arm_scale = (p[k] for k in ('height', 'shoulder', 'waist', 'head', 'arm'))
    # The character is modeled in metres, upright Z, facing -Y. FBX converts Y-up/+Z-facing.
    joints = {'Root': ((0, 0, 0), (0, 0, .15), None),
              'Pelvis': ((0, 0, .78), (0, 0, 1.0), 'Root'),
              'Spine': ((0, 0, 1.0), (0, 0, 1.22), 'Pelvis'),
              'Chest': ((0, 0, 1.22), (0, 0, 1.50), 'Spine'),
              'Neck': ((0, 0, 1.50), (0, 0, 1.67), 'Chest'),
              'Head': ((0, 0, 1.67), (0, 0, 2.15), 'Neck'),
              'Jaw': ((0, -.13, 1.78), (0, -.16, 1.69), 'Head'),
              'Brow.L': ((.11, -.2, 2.01), (.21, -.2, 2.01), 'Head'),
              'Brow.R': ((-.11, -.2, 2.01), (-.21, -.2, 2.01), 'Head')}
    for sign, suffix in ((1, 'L'), (-1, 'R')):
        x = .33 * shoulder
        elbow, wrist = x + .46 * arm_scale, x + .90 * arm_scale
        joints.update({
            'Clavicle.' + suffix: ((sign * .08, 0, 1.47), (sign * x, 0, 1.47), 'Chest'),
            'UpperArm.' + suffix: ((sign * x, 0, 1.47), (sign * elbow, 0, 1.47), 'Clavicle.' + suffix),
            'Forearm.' + suffix: ((sign * elbow, 0, 1.47), (sign * wrist, 0, 1.47), 'UpperArm.' + suffix),
            'Hand.' + suffix: ((sign * wrist, 0, 1.47), (sign * (wrist + .15), 0, 1.47), 'Forearm.' + suffix),
            'Thumb.' + suffix: ((sign * (wrist + .06), 0, 1.40), (sign * (wrist + .18), 0, 1.31), 'Hand.' + suffix),
            'Fingers.' + suffix: ((sign * (wrist + .15), 0, 1.47), (sign * (wrist + .35), 0, 1.47), 'Hand.' + suffix),
            'Thigh.' + suffix: ((sign * .16, 0, .82), (sign * .18, 0, .46), 'Pelvis'),
            'Shin.' + suffix: ((sign * .18, 0, .46), (sign * .18, 0, .10), 'Thigh.' + suffix),
            'Foot.' + suffix: ((sign * .18, 0, .10), (sign * .18, -.15, .07), 'Shin.' + suffix),
            'Toe.' + suffix: ((sign * .18, -.15, .07), (sign * .18, -.29, .06), 'Foot.' + suffix)})
    joints = {name: (tuple(v * height for v in a), tuple(v * height for v in b), parent) for name, (a, b, parent) in joints.items()}
    assert len(joints) == 29
    rig_data = bpy.data.armatures.new('OfficeRig29')
    rig = bpy.data.objects.new('OfficeRig', rig_data)
    scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name, (start, end, parent) in joints.items():
        bone = rig_data.edit_bones.new(name)
        bone.head, bone.tail = start, end
        if parent:
            bone.parent = rig_data.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    vertices, faces, weights, material_ids = [], [], [], []
    def add_vertex(position, influence):
        vertices.append(tuple(c * height for c in position))
        normalized = {name: max(0, value) for name, value in influence.items() if value > .000001}
        total = sum(normalized.values())
        weights.append({name: value / total for name, value in normalized.items()})
        return len(vertices) - 1
    def surface(rows, columns, evaluate, influence, material, close=True, reverse=False):
        start = len(vertices)
        for row in range(rows + 1):
            for column in range(columns):
                v = evaluate(row / rows, column / columns * math.tau)
                add_vertex(v, influence(v))
        for row in range(rows):
            for column in range(columns if close else columns - 1):
                a = start + row * columns + column
                b = start + row * columns + (column + 1) % columns
                faces.append((a, a + columns, b + columns, b) if reverse else (a, b, b + columns, a + columns)); material_ids.append(material)
    def ellipsoid(center, radii, bone, material, segments=16, rows=10):
        def evaluate(t, angle):
            polar = .001 + t * (math.pi - .002)
            return (center[0] + radii[0] * math.sin(polar) * math.cos(angle),
                    center[1] + radii[1] * math.sin(polar) * math.sin(angle), center[2] + radii[2] * math.cos(polar))
        surface(rows, segments, evaluate, lambda _: {bone: 1}, material, reverse=True)
    def tube(points, radii, bone_weights, material, segments=12):
        start = len(vertices)
        for i, position in enumerate(points):
            direction = Vector(points[min(i + 1, len(points) - 1)]) - Vector(points[max(0, i - 1)])
            direction.normalize()
            across = direction.cross(Vector((0, 1, 0))).normalized()
            normal = across.cross(direction).normalized()
            for j in range(segments):
                angle = j / segments * math.tau
                vertex = Vector(position) + radii[i][0] * math.cos(angle) * across + radii[i][1] * math.sin(angle) * normal
                add_vertex(vertex, bone_weights[i])
        for i in range(len(points) - 1):
            for j in range(segments):
                a = start + i * segments + j; b = start + i * segments + (j + 1) % segments
                faces.append((a, a + segments, b + segments, b)); material_ids.append(material)
        faces.extend([tuple(start + j for j in range(segments)), tuple(start + (len(points) - 1) * segments + j for j in reversed(range(segments)))]); material_ids.extend([material, material])
    def patch(points, material, bone='Chest'):
        if (Vector(points[1]) - Vector(points[0])).cross(Vector(points[2]) - Vector(points[0])).y > 0:
            points = list(reversed(points))
        indices = tuple(add_vertex(v, {bone: 1}) for v in points)
        faces.append(indices); material_ids.append(material)
    # Anatomical contour rings: pelvis to chest, not primitive boxes.
    torso = [(.78, .24 * waist, .15), (.85, .28 * waist, .18), (1.0, .28 * waist, .18),
             (1.20, .30 * shoulder, .19), (1.39, .35 * shoulder, .175), (1.49, .26 * shoulder, .13)]
    def torso_evaluate(t, angle):
        f = t * (len(torso) - 1); i = min(len(torso) - 2, int(f)); u = f - i
        z, rx, ry = [torso[i][j] * (1 - u) + torso[i + 1][j] * u for j in range(3)]
        return (rx * math.cos(angle), ry * math.sin(angle), z)
    def torso_weights(v):
        a = max(0, min(1, (v[2] - 1.04) / .25))
        return {'Spine': 1 - a, 'Chest': a}
    outfit_material = 2 if appearance['outfit'] == 'shirt' else 1
    surface(10, 20, torso_evaluate, torso_weights, outfit_material)
    ellipsoid((0, 0, 1.56), (.105, .105, .17), 'Neck', 0, 14, 7)
    # Visible white shirt and lapels, shaped to the curved torso front.
    if appearance['outfit'] != 'shirt':
        patch([(-.14, -.154, 1.45), (.14, -.154, 1.45), (.10, -.197, 1.12), (-.10, -.197, 1.12)], 2)
        patch([(-.13, -.17, 1.48), (-.31 * shoulder, -.13, 1.41), (-.14, -.197, 1.09), (-.075, -.20, 1.31)], 1)
        patch([(.13, -.17, 1.48), (.31 * shoulder, -.13, 1.41), (.14, -.197, 1.09), (.075, -.20, 1.31)], 1)
    # Collar and tie are model geometry, with no external textures.
    patch([(-.105, -.126, 1.52), (-.155, -.165, 1.44), (-.045, -.187, 1.39), (0, -.15, 1.48)], 2)
    patch([(.105, -.126, 1.52), (.155, -.165, 1.44), (.045, -.187, 1.39), (0, -.15, 1.48)], 2)
    if appearance['outfit'] == 'blazer':
        patch([(0, -.175, 1.46), (-.039, -.207, 1.39), (-.045, -.211, 1.15), (0, -.213, 1.09), (.045, -.211, 1.15), (.039, -.207, 1.39)], 3)
        for z in (1.12, 1.0): ellipsoid((.015, -.205, z), (.018, .012, .018), 'Spine', 3, 8, 5)
        patch([(.16, -.166, 1.31), (.285, -.13, 1.31), (.275, -.14, 1.28), (.16, -.176, 1.28)], 3)
    if appearance['badge']:
        for sign in (-1, 1):
            tube([(sign * .08, -.135, 1.53), (sign * .07, -.208, 1.28), (0, -.216, 1.17)], [(.011, .007)] * 3, [{'Chest': 1}] * 3, 3, 6)
        patch([(-.065, -.222, 1.19), (.065, -.222, 1.19), (.065, -.222, 1.04), (-.065, -.222, 1.04)], 2)
        patch([(-.04, -.225, 1.16), (.04, -.225, 1.16), (.04, -.225, 1.12), (-.04, -.225, 1.12)], 1)
    for sign, suffix in ((1, 'L'), (-1, 'R')):
        thigh, shin, foot = ('Thigh.' + suffix, 'Shin.' + suffix, 'Foot.' + suffix)
        tube([(sign * .16, 0, .84), (sign * .17, 0, .64), (sign * .18, 0, .48), (sign * .18, 0, .41), (sign * .18, 0, .13)],
             [(.14, .145), (.13, .13), (.112, .11), (.10, .10), (.095, .095)],
             [{thigh: 1}, {thigh: 1}, {thigh: .6, shin: .4}, {thigh: .15, shin: .85}, {shin: 1}], 3)
        ellipsoid((sign * .18, -.10, .075), (.12, .25, .085), foot, 3, 14, 7)
        x = .33 * shoulder; elbow = x + .46 * arm_scale; wrist = x + .90 * arm_scale
        upper, fore, hand, fingers, thumb = [name + '.' + suffix for name in ('UpperArm', 'Forearm', 'Hand', 'Fingers', 'Thumb')]
        sleeve_end = wrist - .04 if appearance['outfit'] != 'cardigan' else elbow + .12
        arm_points = [(sign * v, 0, 1.47) for v in (x - .02, x + .13, elbow - .06, elbow + .04, sleeve_end)]
        tube(arm_points, [(.122, .118), (.115, .107), (.102, .098), (.095, .09), (.079, .074)],
             [{upper: .8, 'Chest': .2}, {upper: 1}, {upper: .8, fore: .2}, {upper: .3, fore: .7}, {fore: 1}], outfit_material)
        if sleeve_end < wrist - .04:
            tube([(sign * sleeve_end, 0, 1.47), (sign * wrist, 0, 1.47)], [(.09, .08), (.065, .055)], [{fore: 1}, {fore: .8, hand: .2}], 0)
        else:
            tube([(sign * (wrist - .055), 0, 1.47), (sign * wrist, 0, 1.47)], [(.088, .082), (.083, .075)], [{fore: 1}] * 2, 2)
        ellipsoid((sign * (wrist + .095), 0, 1.47), (.14, .052, .115), hand, 0, 16, 9)
        for index, (offset, length) in enumerate(((-.087, .15), (-.029, .20), (.029, .215), (.087, .17))):
            root_x = wrist + .17
            tube([(sign * root_x, 0, 1.47 + offset), (sign * (root_x + length * .65), -.002, 1.47 + offset), (sign * (root_x + length), -.006, 1.47 + offset)],
                 [(.027, .029), (.023, .025), (.009, .016)], [{hand: .3, fingers: .7}, {fingers: 1}, {fingers: 1}], 0, 8)
        tube([(sign * (wrist + .035), 0, 1.40), (sign * (wrist + .13), -.015, 1.32), (sign * (wrist + .21), -.025, 1.31)],
             [(.045, .037), (.034, .032), (.013, .019)], [{hand: .4, thumb: .6}, {thumb: 1}, {thumb: 1}], 0, 9)
    # Adult face, ears, eyelids, brows and a characteristic controlled half-smile.
    head_center = (0, -.005, 1.91)
    ellipsoid(head_center, (.255 * head_size, .225 * head_size, .325 * head_size), 'Head', 0, 24, 16)
    for sign, suffix in ((1, 'L'), (-1, 'R')):
        ellipsoid((sign * .255 * head_size, 0, 1.91), (.055, .055, .095), 'Head', 0, 12, 8)
        ellipsoid((sign * .100, -.209, 1.97), (.064, .031, .037), 'Head', 2, 14, 8)
        ellipsoid((sign * .10, -.237, 1.967), (.024, .013, .027), 'Head', 3, 12, 8)
        ellipsoid((sign * .105 - .006, -.247, 1.978), (.007, .004, .008), 'Head', 2, 8, 5)
        brow_z = 2.043 + (profile['smirk'] if sign > 0 else 0)
        tube([(sign * .045, -.211, brow_z), (sign * .10, -.221, brow_z + .012), (sign * .171, -.198, brow_z - .006)],
             [(.014, .013)] * 3, [{'Brow.' + suffix: 1}] * 3, 3, 7)
    ellipsoid((0, -.229, 1.909), (.041, .066, .072), 'Head', 0, 14, 9)
    # A mouth curve, not a painted texture, follows the jaw.
    tube([(-.105, -.192, 1.805), (-.045, -.219, 1.785), (.025, -.225, 1.785), (.105, -.192, 1.805 + profile['smirk'])],
         [(.009, .008)] * 4, [{'Jaw': 1}] * 4, 3, 7)
    hair_mode = appearance['hair']
    def hair(t, angle):
        front = max(0, -math.sin(angle))
        edge = 1.48 - (.65 if hair_mode == 'receding' else .48) * front
        polar = .001 + t * edge
        ripple = .015 * math.sin(3 * angle) if hair_mode == 'tousled' else .009 * math.cos(angle)
        return (.262 * head_size * math.sin(polar) * math.cos(angle), -.002 + .234 * head_size * math.sin(polar) * math.sin(angle), 1.91 + (.333 * head_size + ripple) * math.cos(polar))
    surface(8, 24, hair, lambda _: {'Head': 1}, 3, reverse=True)
    if hair_mode in ('swept', 'tousled'):
        count = 3 if hair_mode == 'swept' else 5
        for i in range(count):
            x = -.13 + i * .065
            tube([(x, -.13, 2.17), (x + .07, -.11, 2.25 + (i % 2) * .035), (x + .12, -.02, 2.21)],
                 [(.052, .045), (.048, .04), (.012, .015)], [{'Head': 1}] * 3, 3, 9)
    if appearance['glasses']:
        for sign in (-1, 1):
            points = [(sign * .103 + .075 * math.cos(a), -.252, 1.97 + .055 * math.sin(a)) for a in [j / 16 * math.tau for j in range(17)]]
            tube(points, [(.010, .010)] * len(points), [{'Head': 1}] * len(points), 3, 6)
        tube([(-.025, -.256, 1.98), (0, -.263, 1.989), (.025, -.256, 1.98)], [(.009, .009)] * 3, [{'Head': 1}] * 3, 3, 6)
    mesh_data = bpy.data.meshes.new('OfficeCharacterSurface')
    mesh_data.from_pydata(vertices, [], faces); mesh_data.update()
    mesh = bpy.data.objects.new('OfficeCharacter', mesh_data); scene.collection.objects.link(mesh)
    def color(hex_value):
        srgb = [int(hex_value[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        return tuple(c / 12.92 if c < .04045 else ((c + .055) / 1.055) ** 2.4 for c in srgb) + (1,)
    for key in ('skin', 'cloth', 'shirt', 'dark'):
        material = bpy.data.materials.new(key.title()); material.diffuse_color = color(appearance[key]); material.use_nodes = True
        principled = material.node_tree.nodes.get('Principled BSDF'); principled.inputs['Base Color'].default_value = color(appearance[key]); principled.inputs['Roughness'].default_value = .68
        mesh_data.materials.append(material)
    for polygon, material in zip(mesh_data.polygons, material_ids): polygon.material_index = material; polygon.use_smooth = True
    modifier = mesh.modifiers.new('OfficeSkin', 'ARMATURE'); modifier.object = rig
    for name in joints:
        group = mesh.vertex_groups.new(name=name)
        for index, weight in enumerate(weights):
            if name in weight: group.add([index], weight[name], 'REPLACE')
    mesh.parent = rig
    def pose_limb(names, target, end_direction, bend_direction):
        upper, fore, hand = (rig.pose.bones[name] for name in names)
        shoulder_point = upper.head.copy(); desired = Vector(target) * height
        upper_length, fore_length = upper.bone.length, fore.bone.length
        direction = desired - shoulder_point; distance = min(direction.length, upper_length + fore_length - .002)
        direction.normalize(); wrist = shoulder_point + direction * distance
        along = (upper_length ** 2 - fore_length ** 2 + distance ** 2) / (2 * distance)
        bend = Vector(bend_direction); bend = (bend - direction * bend.dot(direction)).normalized()
        elbow = shoulder_point + direction * along + bend * math.sqrt(max(0, upper_length ** 2 - along ** 2))
        for bone, start, end in ((upper, shoulder_point, elbow), (fore, elbow, wrist), (hand, wrist, wrist + Vector(end_direction).normalized() * hand.bone.length)):
            rest_direction = bone.bone.tail_local - bone.bone.head_local
            rotation = rest_direction.rotation_difference(end - start) @ bone.bone.matrix_local.to_quaternion()
            bone.matrix = Matrix.Translation(start) @ rotation.to_matrix().to_4x4()
            bpy.context.view_layer.update()
    def set_pose(semantic, u):
        for bone in rig.pose.bones:
            bone.rotation_mode = 'QUATERNION'; bone.location = (0, 0, 0); bone.rotation_quaternion = (1, 0, 0, 0); bone.scale = (1, 1, 1)
        energy = profile['energy']; wave = math.sin(u * math.tau)
        def rotate(name, euler):
            from mathutils import Euler
            if name == 'Chest': euler = (euler[0] + profile['slouch'], euler[1], euler[2])
            rig.pose.bones[name].rotation_quaternion = Euler(euler, 'XYZ').to_quaternion()
        rotate('Spine', (profile['lean'], 0, 0)); rotate('Chest', (0, 0, 0)); rotate('Head', (profile['chin'], 0, 0))
        # All vertical body bones use their local Y along Blender world Z.
        rig.pose.bones['Pelvis'].location.y = .006 * (1 + energy) * wave
        left, right = (.48, -.10, 1.10), (-.48, -.10, 1.10)
        if semantic.startswith('intro'):
            left = (.40, -.23, 1.32 + .04 * math.sin(u * math.pi)); right = (-.47, -.13, 1.10)
            rotate('Head', (profile['chin'], .04 * wave, -.045 if semantic.endswith('positive') else .06))
        elif semantic == 'charge': left = (.72, .12, 1.72); rotate('Chest', (0, -.14 - energy * .06, 0))
        elif semantic.startswith('attack'):
            f = math.sin(u * math.pi / 2)
            left = (.72 + .30 * f, -.12 - .12 * f, 1.68)
            rotate('Chest', (energy * .025 * math.sin(u * math.pi), -.10 - energy * .06 + (.26 + energy * .10) * f, 0))
        elif semantic == 'guard': left = (.22, -.31, 1.91)
        elif semantic == 'counter':
            left = (.22, -.31, 1.91); f = max(0, (u - .32) / .68)
            right = (-.65 - energy * .10 * (1 - f) + 1.48 * f, -.25, 1.75 + energy * .045 * math.sin(u * math.pi))
            rig.pose.bones['Pelvis'].location.y = -.04 - (.10 + energy * .03) * u / .30 if u <= .30 else -(.14 + energy * .03) + (.175 + energy * .03) * (u - .30) / .70
            rotate('Chest', (energy * .035 * math.sin(u * math.pi), -.12 - energy * .1 + (.42 + energy * .16) * u, 0))
        elif semantic in ('counter-recovery', 'recovery'):
            f = 1 - u
            if semantic.startswith('counter'):
                right = (-.48 + 1.31 * f, -.1 - .15 * f, 1.10 + .65 * f)
                rig.pose.bones['Pelvis'].location.y = .035 * f
                rotate('Chest', (0, (.30 + energy * .06) * f, 0))
            else: left = (.48 + .54 * f, -.10 - .14 * f, 1.10 + .58 * f)
        elif semantic == 'hit': rotate('Head', (0, .18 * math.sin(u * math.pi), .25 * math.sin(u * math.pi)))
        elif semantic == 'victory': left = (.36, -.14, 1.56); rotate('Head', (-.06, 0, -.06))
        elif semantic == 'defeat': rotate('Chest', (.16, 0, .08)); rotate('Head', (.12, 0, -.08))
        bpy.context.view_layer.update()
        for suffix, target in (('L', left), ('R', right)):
            pose_limb([name + '.' + suffix for name in ('UpperArm', 'Forearm', 'Hand')], target, (0, 0, 1), (0, .35, -1))
        for suffix, sign in (('L', 1), ('R', -1)):
            pose_limb([name + '.' + suffix for name in ('Thigh', 'Shin', 'Foot')], (sign * .18, 0, .10), (0, -.15, -.03), (0, -1, 0))
    source_clips, cursor = [], 0
    for semantic, duration in CLIPS:
        source_clips.append({'name': semantic, 'from': cursor / 60, 'to': (cursor + duration) / 60, 'fps': 60})
        for fraction in (0, .25, .5, .75, 1):
            frame = cursor + duration * fraction; scene.frame_set(round(frame)); set_pose(semantic, fraction)
            for bone in rig.pose.bones:
                bone.keyframe_insert('rotation_quaternion', frame=frame, group=bone.name)
                bone.keyframe_insert('location', frame=frame, group=bone.name)
        cursor += duration + 2
    scene.frame_start, scene.frame_end = 0, cursor - 2
    action = rig.animation_data.action; action.name = 'OfficeCombatTimeline'
    curves = [curve for layer in action.layers for strip in layer.strips for bag in strip.channelbags for curve in bag.fcurves]
    for curve in curves:
        for key in curve.keyframe_points: key.interpolation = 'LINEAR'
    def positions(frame):
        scene.frame_set(frame); bpy.context.view_layer.update(); evaluated = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get()); data = evaluated.to_mesh()
        values = [v.co.copy() for v in data.vertices]; evaluated.to_mesh_clear(); return values
    rest = positions(0); changed = positions(round(source_clips[9]['from'] * 60 + 30))
    displacement = max((a - b).length for a, b in zip(rest, changed)); assert displacement > .2
    # Neutral source frame first. Camera/lighting objects aren't part of the FBX selection.
    scene.frame_set(0); bpy.ops.object.select_all(action='DESELECT'); rig.select_set(True); mesh.select_set(True); bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.fbx(filepath=str(output / 'character.fbx'), use_selection=True, object_types={'ARMATURE', 'MESH'},
        global_scale=1, apply_unit_scale=True, apply_scale_options='FBX_SCALE_NONE', axis_forward='-Z', axis_up='Y', use_space_transform=True,
        bake_space_transform=False, add_leaf_bones=False, use_armature_deform_only=True, primary_bone_axis='Y', secondary_bone_axis='X',
        armature_nodetype='NULL', mesh_smooth_type='FACE', bake_anim=True, bake_anim_use_all_bones=True, bake_anim_use_all_actions=False,
        bake_anim_use_nla_strips=False, bake_anim_force_startend_keying=True, bake_anim_step=1, bake_anim_simplify_factor=0,
        path_mode='STRIP', embed_textures=False)
    scene.render.engine = 'CYCLES'; scene.cycles.device = 'CPU'; scene.cycles.samples = source['portrait']['samples']; scene.cycles.seed = 151225
    scene.render.resolution_x = scene.render.resolution_y = source['portrait']['size']; scene.render.resolution_percentage = 100
    scene.render.film_transparent = True; scene.render.image_settings.file_format = 'PNG'; scene.render.image_settings.color_mode = 'RGBA'; scene.render.image_settings.color_depth = '8'
    scene.render.use_stamp = False; scene.render.use_stamp_note = False; scene.render.filepath = '//portrait.png'
    scene.render.threads_mode = 'FIXED'; scene.render.threads = 8; scene.view_settings.view_transform = 'AgX'
    scene.world.color = (.14, .14, .14)
    def aim(obj, target): obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data = bpy.data.cameras.new('PortraitCamera'); camera = bpy.data.objects.new('PortraitCamera', camera_data); scene.collection.objects.link(camera)
    camera.location = (3.2, -7, 3.0); camera_data.type = 'ORTHO'; camera_data.ortho_scale = 2.6 * height; aim(camera, (0, 0, 1.15 * height)); scene.camera = camera
    for name, location, energy, size in (('Key', (3, -4, 5), 450, 4), ('Fill', (-3, -2, 3), 220, 4), ('Rim', (1, 3, 4), 350, 3)):
        data = bpy.data.lights.new(name, 'AREA'); data.energy = energy; data.shape = 'DISK'; data.size = size
        obj = bpy.data.objects.new(name, data); scene.collection.objects.link(obj); obj.location = location; aim(obj, (0, 0, 1.2))
    portrait_clip = next(clip for clip in source_clips if clip['name'] == source['portrait']['pose'])
    portrait_frame = round(portrait_clip['from'] * 60 + 30); scene.frame_set(portrait_frame)
    native.parent.mkdir(parents=True, exist_ok=True); bpy.ops.wm.save_as_mainfile(filepath=str(native), check_existing=False)
    scene.render.filepath = str(output / 'portrait.png'); bpy.ops.render.render(write_still=True); strip_png(output / 'portrait.png')
    image = bpy.data.images.load(str(output / 'portrait.png'), check_existing=False); alpha = list(image.pixels)[3::4]; visible = sum(a > .1 for a in alpha)
    assert 5000 < visible < source['portrait']['size'] ** 2 * .95
    return {'boneNames': list(joints), 'boneCount': len(joints), 'vertices': len(vertices), 'triangles': sum(len(face) - 2 for face in faces),
            'maxInfluences': max(map(len, weights)), 'blendedVertices': sum(len(w) > 1 for w in weights), 'maxWeightError': max(abs(sum(w.values()) - 1) for w in weights),
            'maxEvaluatedDisplacement': displacement, 'fcurves': len(curves), 'sourceClips': source_clips,
            'visiblePortraitPixels': visible, 'portraitPoseFrame': portrait_frame, 'blenderVersion': bpy.app.version_string}


def convert_and_inspect(asset, log_root):
    # Use the converter already included by the installed Creator, never download a substitute.
    install = Path(os.environ.get('COCOS_INSTALL', 'E:/DevTools/CocosCreator/3.8.8'))
    converter = install / 'resources/app.asar.unpacked/node_modules/@cocos/fbx-gltf-conv/bin/win32/FBX-glTF-conv.exe'
    asset, log_root = bounded(asset, ROOT), bounded(log_root, ROOT)
    target = bounded(log_root / 'character.gltf', ROOT)
    bounded(log_root / 'character.bin', ROOT)
    bounded(log_root / 'converter.log', ROOT)
    bounded(asset / 'character.fbx', ROOT)
    result = subprocess.run([str(converter), str(asset / 'character.fbx'), '--out', str(target), '--animation-bake-rate', '60', '--image-path-mode', 'relative'], capture_output=True, text=True)
    (log_root / 'converter.log').write_text(result.stdout + result.stderr, encoding='utf-8')
    if result.returncode: raise RuntimeError('Creator FBX converter failed; see project-local converter log')
    gltf = json.loads(target.read_text(encoding='utf-8'))
    buffers = []
    for entry in gltf['buffers']:
        uri = entry['uri']
        if Path(uri).is_absolute() or '..' in Path(uri).parts: raise ValueError('Converter external buffer path rejected')
        buffers.append(bounded(log_root / uri, log_root).read_bytes())
    widths = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
    formats = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}
    def accessor(index):
        a = gltf['accessors'][index]; v = gltf['bufferViews'][a['bufferView']]; fmt = '<' + formats[a['componentType']] * widths[a['type']]
        size = struct.calcsize(fmt); stride = v.get('byteStride', size); offset = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        return [struct.unpack_from(fmt, buffers[v['buffer']], offset + stride * i) for i in range(a['count'])]
    assert len(gltf['skins']) == 1
    skin = gltf['skins'][0]; names = [gltf['nodes'][i]['name'] for i in skin['joints']]; assert len(names) == 29
    assert len(accessor(skin['inverseBindMatrices'])) == 29
    mesh = next(n for n in gltf['nodes'] if n.get('skin') == 0)
    total, blended, max_error, max_influences = 0, 0, 0, 0
    for primitive in gltf['meshes'][mesh['mesh']]['primitives']:
        ws = accessor(primitive['attributes']['WEIGHTS_0']); js = accessor(primitive['attributes']['JOINTS_0'])
        for weights, indices in zip(ws, js):
            count = sum(w > .00001 for w in weights); error = abs(sum(weights) - 1)
            assert 1 <= count <= 4 and error < .00001 and all(0 <= i < 29 for i in indices)
            total += 1; blended += count > 1; max_error = max(max_error, error); max_influences = max(max_influences, count)
    animation = gltf['animations'][0]
    assert len(animation['channels']) >= 29
    return {'boneNames': names, 'inverseBindMatrices': 29, 'exportVertices': total, 'blendedVertices': blended,
            'maxWeightError': max_error, 'maxInfluences': max_influences, 'animationName': animation['name'],
            'animationChannels': len(animation['channels']), 'wrapperScale': next(n.get('scale') for n in gltf['nodes'] if n['name'] == 'OfficeRig')}


def sync_imports(asset, manifest, write_splits=True):
    meta_path = bounded(asset / 'character.fbx.meta', ROOT)
    if not meta_path.exists(): raise RuntimeError('First import with Creator before --sync-imports; metadata UUIDs must be real')
    meta = json.loads(meta_path.read_text(encoding='utf-8-sig')); user = meta.setdefault('userData', {})
    settings = user.get('animationImportSettings', [])
    if not settings: raise RuntimeError('Creator has not imported the FBX animation timeline')
    if write_splits:
        for setting in settings:
            previous = {entry['name']: entry.get('previousId') for entry in setting.get('splits', [])}
            setting['splits'] = [{**{'name': clip['name'], 'from': clip['from'], 'to': clip['to'], 'fps': 60, 'wrapMode': 2 if clip['name'] in ('idle', 'charge') else 1},
                                  **({'previousId': previous[clip['name']]} if previous.get(clip['name']) else {})} for clip in manifest['generated']['mesh']['sourceClips']]
        user['animationBakeRate'] = 60; user['mountAllAnimationsOnPrefab'] = True; user['unitConversion'] = 'geometry-level'
        write_json(meta_path, meta)
    # Record only references the actual importer emitted. Run again after the split reimport.
    sub = meta.get('subMetas', {})
    imported = {'modelUuid': meta['uuid'], 'prefabUuid': None, 'skeletonUuid': None, 'clipUuids': {}, 'bonePaths': {}}
    for value in sub.values():
        kind = value.get('importer', ''); name = value.get('name') or value.get('displayName', '')
        if kind == 'gltf-scene': imported['prefabUuid'] = value['uuid']
        if kind == 'gltf-skeleton': imported['skeletonUuid'] = value['uuid']
        if kind == 'gltf-animation': imported['clipUuids'][name.removesuffix('.animation')] = value['uuid']
    imported['rawAnimationNames'] = [s['name'] for s in settings]
    project = asset.parents[4]
    if imported['prefabUuid']:
        prefab = bounded(project / 'game/library' / meta['uuid'][:2] / (imported['prefabUuid'] + '.json'), project)
        if prefab.exists():
            entries = json.loads(prefab.read_text(encoding='utf-8-sig'))
            def node_path(index):
                node = entries[index]; parent = node.get('_parent')
                return (node_path(parent['__id__']) + '/' if parent and entries[parent['__id__']].get('_parent') else '') + node['_name']
            for index, entry in enumerate(entries):
                if entry.get('__type__') == 'cc.Node' and entry.get('_name') in manifest['generated']['mesh']['boneNames']:
                    imported['bonePaths'][entry['_name']] = node_path(index)
    portrait_meta = bounded(asset / 'portrait.png.meta', ROOT)
    if portrait_meta.exists():
        image = json.loads(portrait_meta.read_text(encoding='utf-8-sig'))
        imported['portraitTextureUuid'] = next((m['uuid'] for m in image['subMetas'].values() if m['importer'] == 'texture'), None)
    manifest['generated']['imports'] = imported
    return imported


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', required=True, choices=ROLES)
    parser.add_argument('--source-root'); parser.add_argument('--output-root')
    parser.add_argument('--sync-imports', action='store_true'); parser.add_argument('--check', action='store_true')
    parser.add_argument('--bpy', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else None)
    _, output_root, asset, source_path = paths(args)
    asset.mkdir(parents=True, exist_ok=True)
    manifest_path = bounded(asset / 'manifest.json', output_root)
    manifest = json.loads(source_path.read_text(encoding='utf-8-sig')) if source_path.exists() else {'schemaVersion': 1, 'source': default_source(args.role), 'generated': {}}
    validate_source(manifest['source'], args.role)
    script = Path(__file__).read_bytes(); source_hash = digest(script + canonical(manifest['source']))
    log_root = bounded(output_root / 'game/local/character-production' / args.role, output_root); log_root.mkdir(parents=True, exist_ok=True)
    for name in ('blender-stdout.log', 'blender-stderr.log', 'mesh-receipt.json'):
        bounded(log_root / name, output_root)
    if args.bpy:
        native = bounded(output_root / 'game/local/character-source' / (args.role + '.blend'), output_root)
        mesh = make_character(manifest['source'], asset, native)
        write_json(log_root / 'mesh-receipt.json', mesh)
        return
    if args.sync_imports:
        imports = sync_imports(asset, manifest); write_json(manifest_path, manifest)
        print(json.dumps({'synced': args.role, 'imports': imports})); return
    if args.check:
        generated = manifest['generated']
        assert generated['sourceHash'] == source_hash and generated['generatorSha256'] == digest(script), 'Source code/parameters changed; regenerate this role'
        for name, record in generated['outputs'].items():
            target = bounded(output_root / record['path'], output_root)
            assert target == asset / name and target.stat().st_size == record['bytes'] and digest(target.read_bytes()) == record['sha256']
        skin = convert_and_inspect(asset, log_root)
        assert set(skin['boneNames']) == set(generated['mesh']['boneNames']) and skin['blendedVertices'] > 0
        saved = generated.get('imports')
        actual = sync_imports(asset, manifest, write_splits=False)
        assert saved == actual, 'Resync actual Creator references'
        assert actual['prefabUuid'] and actual['skeletonUuid'] and actual['portraitTextureUuid'], 'Creator asset references incomplete'
        assert set(actual['clipUuids']) == {name for name, _ in CLIPS}, 'Semantic clip import incomplete'
        assert set(actual['bonePaths']) == set(generated['mesh']['boneNames']), 'Real Creator bone paths incomplete'
        print(json.dumps({'passed': True, 'role': args.role, 'sourceHash': source_hash, 'skin': skin}, ensure_ascii=False)); return
    portable = ROOT / 'game/local/toolchain/blender-4.5.14-windows-x64/blender.exe'
    receipt = json.loads(bounded(ROOT / 'game/local/toolchain/blender-receipt.json', ROOT).read_text(encoding='utf-8-sig'))
    bounded(portable, ROOT)
    assert receipt['verified'] and receipt['sha256'] == 'b9533d2397ac1984db4466fb23a7a4649391cca93f6e84209f9bcc60d071c8b9'
    write_json(manifest_path, manifest)
    env = dict(os.environ)
    for name, subdir in [('TEMP', 'temp'), ('TMP', 'temp'), ('BLENDER_USER_CONFIG', 'config'), ('BLENDER_USER_DATAFILES', 'data'), ('BLENDER_USER_SCRIPTS', 'scripts'), ('BLENDER_USER_EXTENSIONS', 'extensions')]:
        target = bounded(log_root / subdir, output_root); target.mkdir(exist_ok=True); env[name] = str(target)
    command = [str(portable), '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', str(Path(__file__).resolve()), '--', '--role', args.role, '--bpy']
    if args.source_root: command += ['--source-root', str(args.source_root)]
    if args.output_root: command += ['--output-root', str(args.output_root)]
    result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace')
    (log_root / 'blender-stdout.log').write_text(result.stdout, encoding='utf-8'); (log_root / 'blender-stderr.log').write_text(result.stderr, encoding='utf-8')
    if result.returncode: raise RuntimeError('Blender generation failed; see project-local logs')
    mesh = json.loads((log_root / 'mesh-receipt.json').read_text(encoding='utf-8'))
    skin = convert_and_inspect(asset, log_root)
    outputs = {}
    for name in ('character.fbx', 'portrait.png'):
        target = asset / name; raw = target.read_bytes()
        outputs[name] = {'path': target.relative_to(output_root).as_posix(), 'bytes': len(raw), 'sha256': digest(raw), 'format': 'FBX7400' if name.endswith('fbx') else 'PNG-RGBA8'}
        if name.endswith('png'): outputs[name].update(width=struct.unpack_from('>I', raw, 16)[0], height=struct.unpack_from('>I', raw, 20)[0])
    imports = manifest.get('generated', {}).get('imports')
    manifest['generated'] = {'generatorSha256': digest(script), 'sourceHash': source_hash, 'portraitReviewed': False,
                             'outputs': outputs, 'mesh': mesh, 'convertedSkin': skin, 'imports': imports}
    write_json(manifest_path, manifest)
    print(json.dumps({'generated': args.role, 'sourceHash': source_hash, 'mesh': {k: mesh[k] for k in ('vertices', 'triangles', 'boneCount', 'maxEvaluatedDisplacement')}, 'skin': skin}, ensure_ascii=False))


if __name__ == '__main__':
    main()
