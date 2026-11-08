"""CC0 human topology -> editable office character -> verified Cocos FBX.

The frozen office-cast-1 generator remains an independent, unchanged lineage.
This entry point accepts only the pinned Blender human bundle and project roots.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('office_v1', ROOT / 'tools/create-office-cast.py')
V1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V1)
FROZEN = 'abd8f3d38e0735c59e427cae2bca1c3436cb72aa1415e07f4b3a55407630711e'
BASE_ZIP_SHA = '811f43accbb31a88266d932f8f5563b2d13586fca0ba2693aad1f5fe582b3515'
BASE_BLEND_SHA = '3c121505651140ceb4d69fd1d8923f7788ffadd81672f5be14845a5f2c75c137'
BASE_FILE = ROOT / 'game/local/art-source/human-base-meshes-bundle-v1.4.1/human_base_meshes_bundle.blend'
BASE_OBJECT = 'GEO-body_male_realistic'
SUIT_ROOT = ROOT / 'game/local/art-source/suits01/clothes/toigo_male_suit_3'
VERSION = 'office-human-2'
RIG = 'office-humanoid-29-v2'
MATERIAL_NAMES = ['Skin', 'Coat', 'Shirt', 'Trousers', 'Hair', 'Iris', 'Sclera', 'Leather', 'Identity']


def sha(raw): return hashlib.sha256(raw).hexdigest()
def bounded(path, base=ROOT): return V1.bounded(path, base)
def write_json(path, value): V1.write_json(path, value)


def convert_and_inspect(asset, log_root, source_clips):
    result=V1.convert_and_inspect(asset,log_root)
    gltf=json.loads((log_root/'character.gltf').read_text(encoding='utf-8'))
    times=[]
    for index in {sampler['input'] for animation in gltf['animations'] for sampler in animation['samplers']}:
        accessor=gltf['accessors'][index]; view=gltf['bufferViews'][accessor['bufferView']]
        if accessor['componentType']!=5126 or accessor['type']!='SCALAR': raise ValueError('Animation time accessor mismatch')
        uri=gltf['buffers'][view['buffer']]['uri']; data=bounded(log_root/uri,log_root).read_bytes()
        offset=view.get('byteOffset',0)+accessor.get('byteOffset',0); stride=view.get('byteStride',4)
        times.extend(struct.unpack_from('<f',data,offset+i*stride)[0] for i in range(accessor['count']))
    duration=max(times)-min(times); expected=source_clips[-1]['to']
    if not all(math.isfinite(t) for t in times) or abs(duration-expected)>1/60+.0001:
        raise ValueError(f'Actual FBX animation duration {duration} does not match 60fps source timeline {expected}')
    return {**result,'animationDuration':duration,'animationFps':60}


def sync_imports(asset, manifest, write_splits=True):
    meta=json.loads((asset/'character.fbx.meta').read_text(encoding='utf-8-sig'))
    settings=meta['userData']['animationImportSettings']
    expected=manifest['generated']['mesh']['sourceClips'][-1]['to']
    if len(settings)!=1 or abs(settings[0]['duration']-expected)>1/60+.0001:
        raise ValueError('Creator raw timeline does not match the actual 60fps human source; import updated FBX first')
    return V1.sync_imports(asset,manifest,write_splits=write_splits)


def sanitize_fbx_texture_paths(file):
    """Re-encode fixed FBX7400 texture fields without changing mesh/animation.

    Blender emits an absolute FileName even with path_mode=STRIP. Never permit
    that metadata into the public file: whitelist the one generated fabric image
    and rebuild every absolute node end offset after shortening its properties.
    """
    raw=file.read_bytes()
    if raw[:23]!=b'Kaydara FBX Binary  \x00\x1a\x00' or struct.unpack_from('<I',raw,23)[0]!=7400: raise ValueError('Only FBX7400 is supported')
    changed=[]
    def read_property(position):
        start=position; kind=raw[position:position+1]; position+=1
        sizes={b'Y':2,b'C':1,b'I':4,b'F':4,b'D':8,b'L':8}
        value=None
        if kind in sizes: position+=sizes[kind]
        elif kind in (b'S',b'R'):
            length=struct.unpack_from('<I',raw,position)[0]; position+=4; value=raw[position:position+length]; position+=length
        elif kind in (b'f',b'd',b'l',b'i',b'b',b'c'):
            _,_,length=struct.unpack_from('<III',raw,position); position+=12+length
        else: raise ValueError('Unsupported FBX property encoding')
        return [kind,value,raw[start:position]],position
    def parse(position,parents):
        end,count,prop_bytes,name_len=struct.unpack_from('<IIIB',raw,position)
        name=raw[position+13:position+13+name_len]; cursor=position+13+name_len; props=[]
        for _ in range(count):
            prop,cursor=read_property(cursor); props.append(prop)
        if cursor!=position+13+name_len+prop_bytes: raise ValueError('FBX property table mismatch')
        text=name.decode('ascii','strict'); lineage=parents+[text]
        texture_context='Texture' in parents or 'Video' in parents
        for index,prop in enumerate(props):
            kind,value,_=prop
            path_field=texture_context and text in ('FileName','Filename','RelativeFilename')
            path_property=texture_context and text=='P' and props and props[0][1]==b'Path' and index==len(props)-1
            if kind==b'S' and (path_field or path_property):
                decoded=value.decode('utf-8','strict').replace('\\','/')
                if decoded!='fabric.png':
                    expected=(file.parent/'fabric.png').resolve().as_posix()
                    if decoded.casefold()!=expected.casefold(): raise ValueError('Unexpected FBX texture reference')
                    prop[1]=b'fabric.png'; prop[2]=b'S'+struct.pack('<I',10)+b'fabric.png'; changed.append('/'.join(lineage))
        children=[]; null=False
        while cursor<end:
            if raw[cursor:cursor+13]==bytes(13): cursor+=13; null=True; break
            child,cursor=parse(cursor,lineage); children.append(child)
        if cursor!=end: raise ValueError('FBX child boundary mismatch')
        return {'name':name,'props':props,'children':children,'null':null},end
    position=27; nodes=[]
    while raw[position:position+13]!=bytes(13):
        node,position=parse(position,[]); nodes.append(node)
    footer=raw[position+13:]
    def encode(node,start):
        props=b''.join(prop[2] for prop in node['props']); position=start+13+len(node['name'])+len(props); children=[]
        for child in node['children']:
            data=encode(child,position); children.append(data); position+=len(data)
        tail=bytes(13) if node['null'] else b''; end=position+len(tail)
        return struct.pack('<IIIB',end,len(node['props']),len(props),len(node['name']))+node['name']+props+b''.join(children)+tail
    result=bytearray(raw[:27])
    for node in nodes: result.extend(encode(node,len(result)))
    result.extend(bytes(13)); result.extend(footer); file.write_bytes(result)
    return changed


def default_source():
    source = V1.default_source('manager')
    source.update(assetRevision=3, rigSpecVersion=RIG, generatorVersion=VERSION)
    source['facets']['negative'] = '欺上瞒下，汇报时功劳归自己，出错让下属背锅。'
    source['provenance'] = {
        'kind': 'cc0-derived', 'author': 'Slap Duel project',
        'license': 'CC0 human base; original office customization and production source included',
        'source': 'tools/create-office-human.py'}
    source['baseMesh'] = {
        'version': '1.4.1',
        'url': 'https://download.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip',
        'archiveSha256': BASE_ZIP_SHA, 'blendSha256': BASE_BLEND_SHA,
        'object': BASE_OBJECT, 'authors': ['Dan Ulrich'], 'license': 'CC0'}
    source['clothing'] = {
        'version':'suits01-cc0','url':'https://files2.makehumancommunity.org/asset_packs/suits01/suits01_cc0.zip',
        'archiveSha256':'2b1d8676f3863b188e9eea98c1d8f234543d54c440e791d92b819f8ee1861f19',
        'object':'clothes/toigo_male_suit_3/suit3.obj',
        'objSha256':'1412a998988f19696e00637afd69e64499d727a0c6ab7527f8713129990f0e43',
        'textureSha256':'7a3fa6cf10d3fcc2946469efcf066e2f5898d1a9dfa10a3df4a1ff2495dc17dc','authors':['MRT'],'license':'CC0'}
    source['appearance'].update(skin='#C99B80', cloth='#293C55', shirt='#E8E8E1', dark='#242A34')
    source['proportions'].update(height=1, shoulder=1, waist=1.09, head=1.035, arm=1)
    source['portrait'].update(size=512, samples=24, framing='waist-up-v2')
    source['runtime'] = {
        'boneCount': 29, 'identityMaterial': 8,
        'anchors': {'palm': [0, .001, 0], 'cheekLeft': [.0012, .0007, .00145], 'cheekRight': [-.0012, .0007, .00145]},
        'materials': MATERIAL_NAMES, 'uvStrategy': 'single-tile-atlas', 'restPose': 'human-a-rest-v2'}
    return source


def validate_source(source):
    reference = default_source()
    for name in ('roleId', 'rigSpecVersion', 'generatorVersion', 'blenderVersion', 'baseMesh', 'clothing', 'provenance', 'export', 'guardHand', 'counterHand', 'runtime'):
        if source.get(name) != reference[name]: raise ValueError('Unsupported human source declaration: ' + name)
    if not isinstance(source.get('assetRevision'), int) or source['assetRevision'] < 3: raise ValueError('Invalid human asset revision')
    if not .9 <= source['proportions']['height'] <= 1.1: raise ValueError('Human height is outside supported range')
    if not .95 <= source['proportions']['waist'] <= 1.18: raise ValueError('Human waist is outside supported range')


def make_character(source, output, native, log_root):
    import bpy
    from mathutils import Vector, Matrix, Quaternion, Euler
    from mathutils.bvhtree import BVHTree
    if bpy.app.version_string != '4.5.14 LTS': raise RuntimeError('Verified Blender 4.5.14 required')
    if sha(BASE_FILE.read_bytes()) != BASE_BLEND_SHA: raise ValueError('Pinned human base changed')
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.fps=60; scene.render.fps_base=1
    wanted = [BASE_OBJECT, BASE_OBJECT + '.eye.L', BASE_OBJECT + '.eye.R']
    with bpy.data.libraries.load(str(BASE_FILE), link=False) as (available, loaded):
        if any(name not in available.objects for name in wanted): raise ValueError('Official human objects missing')
        loaded.objects = wanted
    body = next(obj for obj in loaded.objects if obj.name == BASE_OBJECT)
    for obj in loaded.objects: scene.collection.objects.link(obj)
    bpy.context.view_layer.update()
    base_world = body.matrix_world.copy()
    rebased = {obj.name: base_world.inverted() @ obj.matrix_world for obj in loaded.objects}
    originals = []
    for obj in loaded.objects:
        # Capture every hierarchy-derived matrix BEFORE resetting any parent.
        matrix = rebased[obj.name]
        obj.parent = None; obj.matrix_world = Matrix.Identity(4)
        obj.data = obj.data.copy()
        for v in obj.data.vertices: v.co = matrix @ v.co
        obj.modifiers.clear()
        originals.append(obj)
    # A complete anatomical surface is retained. These are shape edits, not a new
    # collection of disconnected facial primitives. Units match the game arena.
    height = source['proportions']['height']; scale = 2.24 / 1.684413194656372 * height
    def shape_point(point):
        x, y, z = point
        belly = math.exp(-((z - 1.02) / .23) ** 2) * max(0, 1 - abs(x) / .28)
        x *= 1 + (source['proportions']['waist'] - 1) * belly
        y -= .018 * belly * max(0, min(1, -y / .1))
        # Broader mature jaw and less protruding nasal tip; the source eye/lip
        # loops and their connected anatomical transitions remain intact.
        face = math.exp(-((z - 1.54) / .13) ** 2)
        x *= 1 + .15 * face
        cheek = math.exp(-((z-1.515)/.065)**2) * math.exp(-((abs(x)-.043)/.045)**2)
        if y<-.055: y -= .009*cheek
        if y < -.10 and abs(x) < .035 and 1.50 < z < 1.60: y += .007 * math.exp(-(x / .035) ** 2)
        if z>1.445: z=1.445+(z-1.445)*.94
        return Vector((x * scale, y * scale, z * scale))
    for obj in originals:
        for vertex in obj.data.vertices: vertex.co = shape_point(vertex.co)
        for p in obj.data.polygons: p.use_smooth = True
    body.name = 'HumanBodySource'
    body.data.calc_loop_triangles()
    reference_vertices=[v.co.copy() for v in body.data.vertices]
    reference_triangles=[tuple(t.vertices) for t in body.data.loop_triangles]
    anatomy_tree=BVHTree.FromPolygons(reference_vertices,reference_triangles,all_triangles=True)
    # Source coordinates are recorded for reproducible anatomical fitting and
    # region-based weights. Both sides have separate rest/bind matrices.
    joints = {
        'Root': ((0, 0, 0), (0, 0, .1), None),
        'Pelvis': ((0, 0, 1.10), (0, 0, 1.28), 'Root'),
        'Spine': ((0, 0, 1.28), (0, 0, 1.55), 'Pelvis'),
        'Chest': ((0, 0, 1.55), (0, 0, 1.81), 'Spine'),
        'Neck': ((0, 0, 1.81), (0, -.01, 1.96), 'Chest'),
        'Head': ((0, -.01, 1.96), (0, -.01, 2.23), 'Neck'),
        'Jaw': ((0, -.035, 2.025), (0, -.09, 1.995), 'Head'),
        'Brow.L': ((.055, -.16, 2.13), (.11, -.15, 2.13), 'Head'),
        'Brow.R': ((-.055, -.16, 2.13), (-.11, -.15, 2.13), 'Head')}
    for sign, suffix in ((1, 'L'), (-1, 'R')):
        shoulder, elbow, wrist = (sign * .273, 0, 1.755), (sign * .379, 0, 1.462), (sign * .493, -.073, 1.196)
        joints.update({
            'Clavicle.'+suffix: ((sign*.07, 0, 1.78), shoulder, 'Chest'),
            'UpperArm.'+suffix: (shoulder, elbow, 'Clavicle.'+suffix),
            'Forearm.'+suffix: (elbow, wrist, 'UpperArm.'+suffix),
            'Hand.'+suffix: (wrist, (sign*.532, -.154, 1.065), 'Forearm.'+suffix),
            'Thumb.'+suffix: ((sign*.493, -.168, 1.10), (sign*.508, -.218, 1.025), 'Hand.'+suffix),
            'Fingers.'+suffix: ((sign*.532, -.154, 1.065), (sign*.567, -.149, .948), 'Hand.'+suffix),
            'Thigh.'+suffix: ((sign*.15, .015, 1.10), (sign*.225, .005, .64), 'Pelvis'),
            'Shin.'+suffix: ((sign*.225, .005, .64), (sign*.245, .04, .105), 'Thigh.'+suffix),
            'Foot.'+suffix: ((sign*.245, .04, .105), (sign*.25, -.12, .06), 'Shin.'+suffix),
            'Toe.'+suffix: ((sign*.25, -.12, .06), (sign*.25, -.24, .045), 'Foot.'+suffix)})
    if len(joints) != 29: raise AssertionError('Human rig must have exactly 29 named bones')
    joints = {name: (tuple(c*height for c in a), tuple(c*height for c in b), parent) for name,(a,b,parent) in joints.items()}
    rig_data = bpy.data.armatures.new('OfficeHumanRig29')
    rig = bpy.data.objects.new('OfficeRig', rig_data); scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig; rig.select_set(True); bpy.ops.object.mode_set(mode='EDIT')
    for name, (a,b,parent) in joints.items():
        bone = rig_data.edit_bones.new(name); bone.head=a; bone.tail=b
        if parent: bone.parent=rig_data.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    # One reusable fabric image, packed into a single 0..1 UV domain. It is an
    # actual FBX diffuse texture; procedural DCC-only shading is not the deliverable.
    if sha((SUIT_ROOT/'suit3.obj').read_bytes())!=source['clothing']['objSha256'] or sha((SUIT_ROOT/'NewSuit3.png').read_bytes())!=source['clothing']['textureSha256']:
        raise ValueError('Pinned CC0 suit input changed')
    texture=bpy.data.images.load(str(SUIT_ROOT/'NewSuit3.png'),check_existing=False); texture.name='OfficeFabric'; texture.scale(1024,1024)
    texture.filepath_raw=str(output/'fabric.png'); texture.file_format='PNG'; texture.save(); V1.strip_png(output/'fabric.png')
    def rgba(hex_color):
        values=[int(hex_color[i:i+2],16)/255 for i in (1,3,5)]
        return tuple(v/12.92 if v<.04045 else ((v+.055)/1.055)**2.4 for v in values)+(1,)
    colors = [source['appearance']['skin'], source['appearance']['cloth'], source['appearance']['shirt'], '#333A47', '#211D1C', '#302016', '#ECEAE5', '#191B20', '#B9A168']
    roughness=[.45,.83,.72,.78,.76,.18,.16,.30,.43]
    materials=[]
    for index,(name,color) in enumerate(zip(MATERIAL_NAMES,colors)):
        mat=bpy.data.materials.new(name); mat.use_nodes=True; mat.diffuse_color=rgba(color)
        shader=mat.node_tree.nodes.get('Principled BSDF'); shader.inputs['Base Color'].default_value=rgba(color); shader.inputs['Roughness'].default_value=roughness[index]
        if index==0: shader.inputs['Subsurface Weight'].default_value=.07
        if index in (1,2,3):
            image=mat.node_tree.nodes.new('ShaderNodeTexImage'); image.image=texture
            mat.node_tree.links.new(image.outputs['Color'],shader.inputs['Base Color'])
        materials.append(mat)
    def slots(obj):
        obj.data.materials.clear()
        for mat in materials: obj.data.materials.append(mat)
    slots(body)
    for face in body.data.polygons: face.material_index=0
    for eye in originals[1:]:
        slots(eye)
        center=sum((v.co for v in eye.data.vertices),Vector())/len(eye.data.vertices)
        for face in eye.data.polygons:
            p=sum((eye.data.vertices[i].co for i in face.vertices),Vector())/len(face.vertices)-center
            face.material_index=5 if p.y<-.011*height and math.hypot(p.x,p.z)<.009*height else 6
    created=list(originals)
    def apply_mod(obj,kind,name,**kwargs):
        bpy.context.view_layer.objects.active=obj
        mod=obj.modifiers.new(name,kind)
        for key,value in kwargs.items(): setattr(mod,key,value)
        bpy.ops.object.modifier_apply(modifier=mod.name)
    def garment(name, select, material, inflate=.014, subdivide=False):
        chosen=[p for p in body.data.polygons if select(sum((body.data.vertices[i].co for i in p.vertices),Vector())/len(p.vertices))]
        indices=sorted({i for p in chosen for i in p.vertices}); remap={old:new for new,old in enumerate(indices)}
        vertices=[]
        for index in indices:
            vertex=body.data.vertices[index]; point=vertex.co+vertex.normal*inflate*height
            # Low amplitude shaping gives cloth ease and folds, without affecting skin.
            point += vertex.normal * (.0025*height*math.sin(point.z*68)*math.exp(-((point.z-1.35*height)/(.6*height))**2))
            vertices.append(point)
        mesh=bpy.data.meshes.new(name); mesh.from_pydata(vertices,[],[tuple(remap[i] for i in p.vertices) for p in chosen]); mesh.update()
        obj=bpy.data.objects.new(name,mesh); scene.collection.objects.link(obj); slots(obj)
        for face in mesh.polygons: face.material_index=material; face.use_smooth=True
        # Face-centre selection is only the rough pattern. Fit the cut edges to
        # explicit neckline/hem/cuff planes and smooth their tangent, before
        # generating thickness; stair-step surface fragments are not tailoring.
        import bmesh
        bm=bmesh.new(); bm.from_mesh(mesh)
        edge_vertices={v for e in bm.edges if e.is_boundary for v in e.verts}
        for _ in range(8):
            positions={v:sum((e.other_vert(v).co for e in v.link_edges if e.is_boundary),Vector())/sum(e.is_boundary for e in v.link_edges) for v in edge_vertices}
            for v,p in positions.items(): v.co=v.co*.5+p*.5
        if name in ('ShirtBody','TailoredJacket'):
            for v in edge_vertices:
                if v.co.z>1.85*height: v.co.z=1.915*height
                elif abs(v.co.x)>.40*height and v.co.z<1.36*height:
                    sign=1 if v.co.x>0 else -1
                    a=Vector((sign*.382,-.006,1.445))*height; b=Vector((sign*.490,-.018,1.115))*height
                    direction=(b-a).normalized(); center=a+(b-a)*(.94 if name=='ShirtBody' else .87)
                    v.co -= direction*(v.co-center).dot(direction)
                elif v.co.z<1.13*height: v.co.z=1.04*height
        elif name=='Trousers':
            for v in edge_vertices:
                if v.co.z>1.0*height: v.co.z=1.13*height
                elif v.co.z<.24*height: v.co.z=.16*height
        bm.to_mesh(mesh); bm.free(); mesh.update()
        if subdivide: apply_mod(obj,'SUBSURF','TailoredSurface',levels=1,render_levels=1)
        apply_mod(obj,'SOLIDIFY','FabricThickness',thickness=.006*height,offset=0)
        created.append(obj); return obj
    def near_arm(p): return abs(p.x)>.31*height and p.z<1.76*height
    # Use the licensed, authored outfit's actual cloth panels, cuffs, lapels and
    # UVs. Its hm08 vertex mappings are NOT used on this unrelated body. Instead
    # the garment is fitted into our measured A-rest, then receives our new skin.
    vertices=[]; texcoords=[]; faces=[]; face_uvs=[]
    for line in (SUIT_ROOT/'suit3.obj').read_text(encoding='utf-8').splitlines():
        parts=line.split()
        if not parts: continue
        if parts[0]=='v': vertices.append(tuple(map(float,parts[1:4])))
        elif parts[0]=='vt': texcoords.append(tuple(map(float,parts[1:3])))
        elif parts[0]=='f':
            corners=[part.split('/') for part in parts[1:]]
            faces.append(tuple(int(part[0])-1 for part in corners)); face_uvs.append(tuple(int(part[1])-1 for part in corners))
    def fit_suit(point):
        x,y,z=point; q=Vector((x*.122,-z*.122,y*.122+1.042)); sign=1 if q.x>=0 else -1
        if q.z<1.04:
            t=max(0,min(1,(1.1-q.z)/.995)); center=.15+(.245-.15)*t; old_center=.126+(.249-.126)*t
            q.x=sign*(center+(abs(q.x)-old_center)*1.10); return q*height
        if abs(q.x)<.24:
            q.x*=1.18; return q*height
        # The source cuff centres come from its actual 24-edge boundary loops,
        # not its maximum-x sleeve buttons or an assumed straight-arm endpoint.
        src_a=Vector((sign*.250,-.02,1.750)); src_b=Vector((sign*.425,-.065,1.525))
        src_c=Vector((.5981,-.2537,1.3521) if sign>0 else (-.5935,-.2732,1.3488))
        dst_a=Vector((sign*.273,0,1.755)); dst_b=Vector((sign*.379,0,1.462)); dst_c=Vector((sign*.493,-.073,1.196))
        def frame_fit(a,b,c,d):
            old=b-a; new=d-c; along=(q-a).dot(old)/old.length_squared; side=q-a-old*along
            return c+new*along+old.normalized().rotation_difference(new.normalized())@side
        upper=frame_fit(src_a,src_b,dst_a,dst_b); lower=frame_fit(src_b,src_c,dst_b,dst_c)
        along=(q-src_a).dot((src_c-src_a).normalized()); elbow=(src_b-src_a).length
        t=max(0,min(1,(along-(elbow-.07))/.14)); t=t*t*(3-2*t)
        arm=upper.lerp(lower,t); blend=max(0,min(1,(abs(q.x)-.24)/.10)); blend=blend*blend*(3-2*blend)
        torso=q.copy(); torso.x*=1.18
        return torso.lerp(arm,blend)*height
    fitted=[fit_suit(vertex) for vertex in vertices]
    suit_data=bpy.data.meshes.new('CC0TailoredSuit'); suit_data.from_pydata(fitted,[],faces); suit_data.update()
    import bmesh
    suit=bpy.data.objects.new('FittedTailoredSuit',suit_data); scene.collection.objects.link(suit); slots(suit)
    layer=suit_data.uv_layers.new(name='UVMap')
    for face,indices in zip(suit_data.polygons,face_uvs):
        center=sum((suit_data.vertices[i].co for i in face.vertices),Vector())/len(face.vertices)
        face.material_index=3 if center.z<1.13*height else 2 if abs(center.x)<.13*height and center.y<-.09*height else 1
        face.use_smooth=True
        for loop,index in zip(face.loop_indices,indices): layer.data[loop].uv=texcoords[index]
    created.append(suit)
    # Tailored details are solid volumes, fitted over the full shaped garment.
    def detail(name,points,material,thickness=.012,bevel=.004):
        data=bpy.data.meshes.new(name); data.from_pydata([Vector(p)*height for p in points],[],[tuple(range(len(points)))]); data.update()
        obj=bpy.data.objects.new(name,data); scene.collection.objects.link(obj); slots(obj)
        for p in data.polygons: p.material_index=material
        apply_mod(obj,'SOLIDIFY','Thickness',thickness=thickness*height,offset=0)
        apply_mod(obj,'BEVEL','SoftTailoring',width=bevel*height,segments=2)
        created.append(obj); return obj
    detail('IdentityPin',[(.165,-.207,1.73),(.196,-.196,1.73),(.196,-.199,1.703),(.165,-.210,1.703)],8,.012,.004)
    def sphere(name,location,scale_vec,material,segments=12):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=8,location=Vector(location)*height)
        obj=bpy.context.object; obj.name=name; obj.scale=Vector(scale_vec)*height
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True); slots(obj)
        for face in obj.data.polygons: face.material_index=material; face.use_smooth=True
        created.append(obj); return obj
    # Sculpted hair cap follows the actual skull and hairline; swept locks add
    # the directional silhouette rather than replacing the face with a sphere.
    def hair_region(p):
        x,y,z=(c/height for c in p)
        front=2.155+.028*max(0,min(1,(abs(x)-.045)/.065))
        return z>(front if y<-.035 else 2.075 if y<.035 else 2.015) or (abs(x)>.11 and y>-.012 and z>2.055)
    chosen=[p for p in body.data.polygons if hair_region(sum((body.data.vertices[i].co for i in p.vertices),Vector())/len(p.vertices))]
    indices=sorted({i for p in chosen for i in p.vertices}); remap={old:new for new,old in enumerate(indices)}
    def hair_volume(p):
        x,y,z=(c/height for c in p); crown=max(0,min(1,(z-2.07)/.15))
        part=math.exp(-((x-.035)/.010)**2)*max(0,1-abs(y)/.14)
        return (.001+.021*crown*(.85 if x<.035 else .50)-.010*part*crown)*height
    hair_data=bpy.data.meshes.new('PartedScalp'); hair_data.from_pydata([body.data.vertices[i].co+body.data.vertices[i].normal*hair_volume(body.data.vertices[i].co) for i in indices],[],[tuple(remap[i] for i in p.vertices) for p in chosen]); hair_data.update()
    cap=bpy.data.objects.new('PartedHair',hair_data); scene.collection.objects.link(cap); slots(cap)
    edge_mesh=bmesh.new(); edge_mesh.from_mesh(hair_data)
    boundary={v for e in edge_mesh.edges if e.is_boundary for v in e.verts}
    for _ in range(6):
        positions={v:sum((e.other_vert(v).co for e in v.link_edges if e.is_boundary),Vector())/sum(e.is_boundary for e in v.link_edges) for v in boundary}
        for vertex,point in positions.items():
            location,normal,_,_=anatomy_tree.find_nearest(vertex.co*.6+point*.4); vertex.co=location+normal*.0008*height
    edge_mesh.to_mesh(hair_data); edge_mesh.free()
    for p in hair_data.polygons: p.material_index=4; p.use_smooth=True
    apply_mod(cap,'SOLIDIFY','HairEdgeThickness',thickness=.001*height,offset=0); created.append(cap)
    def curve_mesh(name,points,radius,material,radii=None):
        data=bpy.data.curves.new(name,'CURVE'); data.dimensions='3D'; data.resolution_u=4; data.bevel_depth=radius*height; data.bevel_resolution=2
        spline=data.splines.new('BEZIER'); spline.bezier_points.add(len(points)-1)
        for index,(p,co) in enumerate(zip(spline.bezier_points,points)):
            p.co=Vector(co)*height; p.handle_left_type=p.handle_right_type='AUTO'
            if radii: p.radius=radii[index]
        obj=bpy.data.objects.new(name,data); scene.collection.objects.link(obj); bpy.context.view_layer.objects.active=obj; obj.select_set(True)
        bpy.ops.object.convert(target='MESH'); obj=bpy.context.object; slots(obj)
        for face in obj.data.polygons: face.material_index=material; face.use_smooth=True
        obj.select_set(False); created.append(obj); return obj
    for x in (-.083,-.050,-.018,.012,.067,.092):
        points=[]
        for index,y in enumerate((-.055,-.025,.005,.035)):
            xx=x+.012*index/3
            hit,normal,_,_=anatomy_tree.ray_cast(Vector((xx*height,y*height,2.6*height)),Vector((0,0,-1)))
            # Outside the scalp's projected footprint, a vertical ray reaches
            # the nape instead. Never turn that hit into a shoulder-length lock.
            if hit is None or hit.z<2.12*height: break
            point=hit+normal*(hair_volume(hit)+.0008*height); points.append(tuple(c/height for c in point))
        if len(points)==4: curve_mesh('SweptHairLock',points,.0025,4,(.35,1,.65,.05))
    bpy.context.view_layer.update()
    from mathutils.bvhtree import BVHTree
    face_tree=BVHTree.FromObject(body,bpy.context.evaluated_depsgraph_get())
    for sign in (-1,1):
        points=[]
        for i in range(9):
            u=i/8; x=sign*(.033+.079*u); z=2.110+.010*math.sin(u*math.pi)
            hit=face_tree.ray_cast(Vector((x*height,-height,z*height)),Vector((0,1,0)))[0]
            if hit is None: raise ValueError('Eyebrow has no anatomical surface')
            points.append((x,hit.y/height-.0030,z))
        curve_mesh('Eyebrow',points,.003,4,[.15+.85*math.sin(i/8*math.pi)**.55 for i in range(9)])
    # Rounded leather uppers, a distinct sole and a seam keep shoes separate
    # from the anatomical toes. This is accessory construction, not a body stub.
    for sign in (-1,1):
        def shoe_volume(name,sole=False):
            rings=[(.13,.071,.13),(.07,.082,.15),(-.07,.105,.115),(-.20,.112,.087),(-.29,.083,.065)]
            verts=[]; faces=[]; segments=16
            for y,width,top in rings:
                for i in range(segments):
                    angle=i/segments*math.tau; bottom=.016 if sole else .038
                    z=bottom+(.017 if sole else top-bottom)*(.5+.5*math.sin(angle))
                    verts.append((sign*.265+width*math.cos(angle),y,z))
            for row in range(len(rings)-1):
                for i in range(segments):
                    a=row*segments+i; b=row*segments+(i+1)%segments; faces.append((a,b,b+segments,a+segments))
            faces.extend([tuple(reversed(range(segments))),tuple((len(rings)-1)*segments+i for i in range(segments))])
            data=bpy.data.meshes.new(name); data.from_pydata([Vector(v)*height for v in verts],[],faces); data.update()
            obj=bpy.data.objects.new(name,data); scene.collection.objects.link(obj); slots(obj)
            for p in data.polygons: p.material_index=3 if sole else 7; p.use_smooth=True
            apply_mod(obj,'BEVEL','ShoeEdges',width=.008*height,segments=2); created.append(obj)
        shoe_volume('OxfordUpper'); shoe_volume('ShoeSole',True)
        curve_mesh('ShoeVampSeam',[(sign*.17,-.11,.108),(sign*.265,-.145,.115),(sign*.36,-.11,.108)],.002,3)
    # Trim only regions fully covered by the authored suit. Preserve continuous
    # neck and wrist lengths underneath its openings; boundary cuts stay hidden
    # inside clothing, not at visible jaw/cuff contours.
    bm=bmesh.new(); bm.from_mesh(body.data)
    # Split the genuine body at precise clothing coverage planes before hiding
    # it. This keeps a continuous neck/wrist overlap under the authored cloth,
    # rather than exposing a face-centre staircase or half the forearm.
    bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),dist=.00001,
        plane_co=Vector((0,0,1.92))*height,plane_no=Vector((0,0,1)))
    wrist_planes={}
    for side in ('L','R'):
        a,b,_=joints['Forearm.'+side]; a,b=Vector(a),Vector(b)
        direction=(b-a).normalized(); cuff=b-direction*.018*height
        wrist_planes[side]=(cuff,direction)
        bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),dist=.00001,
            plane_co=cuff,plane_no=direction)
    def exposed_skin(point):
        x,y,z=(c/height for c in point)
        if z>1.92: return True
        cuff,direction=wrist_planes['L' if x>=0 else 'R']
        return abs(x)>.37 and (point-cuff).dot(direction)>=-.00001*height and z>.86
    bmesh.ops.delete(bm,geom=[f for f in bm.faces if not exposed_skin(f.calc_center_median())],context='FACES')
    # Continue the actual neck cross-section into the shirt. The removed lower
    # region contains the trapezius/shoulders, which are covered by the suit.
    # Extending this exact boundary gives a connected smooth neck instead of
    # retaining shoulder flaps or chopping an exposed side of the nape.
    neck_edges=[e for e in bm.edges if e.is_boundary and all(abs(v.co.z-1.92*height)<.0001*height for v in e.verts)]
    if len(neck_edges)<8: raise ValueError('Anatomical neck opening was not found')
    extension=bmesh.ops.extrude_edge_only(bm,edges=neck_edges)
    neck_vertices=[v for v in extension['geom'] if isinstance(v,bmesh.types.BMVert)]
    for vertex in neck_vertices:
        vertex.co.z-=.07*height; vertex.co.x*=.96; vertex.co.y*=.90
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces)); bm.to_mesh(body.data); bm.free()
    for face in body.data.polygons: face.use_smooth=True
    # Preserve the suit's authored atlas. Unt­extured anatomical surfaces retain
    # local UV fractions; new geometric details receive their own finite tile.
    for obj in created:
        if not obj.data.uv_layers:
            bpy.ops.object.select_all(action='DESELECT'); obj.select_set(True); bpy.context.view_layer.objects.active=obj
            bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.uv.smart_project(angle_limit=math.radians(66),island_margin=.008,correct_aspect=True,scale_to_bounds=True); bpy.ops.object.mode_set(mode='OBJECT')
        obj.data.uv_layers.active.name='UVMap'
        for item in obj.data.uv_layers.active.data:
            item.uv=(max(0,min(1,item.uv.x%1 if item.uv.x<0 or item.uv.x>1 else item.uv.x)),max(0,min(1,item.uv.y%1 if item.uv.y<0 or item.uv.y>1 else item.uv.y)))
    # All pieces are one genuinely skinned mesh with one explicit material table.
    bpy.ops.object.select_all(action='DESELECT')
    for obj in created: obj.select_set(True)
    bpy.context.view_layer.objects.active=body; bpy.ops.object.join(); mesh=body; mesh.name='OfficeHumanMesh'
    bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    # Mesh joining duplicates slots. Remap by actual material identity to the
    # strict ten-slot runtime contract before assigning the skin.
    slot_materials=list(mesh.data.materials)
    indices=[MATERIAL_NAMES.index(slot_materials[p.material_index].name) for p in mesh.data.polygons]
    slots(mesh)
    for face,index in zip(mesh.data.polygons,indices): face.material_index=index; face.use_smooth=True
    def distance_segment(p,a,b):
        a,b=Vector(a),Vector(b); d=b-a; t=max(0,min(1,(p-a).dot(d)/d.length_squared)); return (p-a-d*t).length
    def smooth(a,b,v):
        u=max(0,min(1,(v-a)/(b-a))); return u*u*(3-2*u)
    def weights(p):
        x,y,z=(v/height for v in p); side='L' if x>=0 else 'R'; ax=abs(x)
        if z>1.91:
            if z<2.035 and y<-.115 and ax<.09:
                jaw=.25*(1-smooth(1.99,2.035,z)); return {'Head':1-jaw,'Jaw':jaw}
            if 2.12<z<2.155 and y<-.13 and .02<ax<.13:
                brow=.35; return {'Head':1-brow,'Brow.'+side:brow}
            return {'Head':1}
        if z>1.79 and ax<.15:
            t=smooth(1.79,1.94,z); return {'Chest':1-t,'Neck':t}
        if z<1.1 and (ax<.39 or z<.86):
            if z<.17: return {'Foot.'+side:1}
            if z<.68:
                t=smooth(.57,.73,z); return {'Shin.'+side:1-t,'Thigh.'+side:t}
            t=smooth(.97,1.13,z); return {'Thigh.'+side:1-t,'Pelvis':t}
        torso={}
        if z<1.30: torso={'Pelvis':1}
        else:
            t=smooth(1.32,1.64,z); torso={'Spine':1-t,'Chest':t}
        arm=smooth(.22,.34,ax) if z>1.0 else smooth(.35,.43,ax)
        if arm<.0001: return {k:v for k,v in torso.items() if v>.00001}
        names=[name+'.'+side for name in ('UpperArm','Forearm','Hand','Fingers','Thumb')]
        candidates=sorted((distance_segment(p,*joints[name][:2]),name) for name in names)
        # Thumb weights apply only to the thumb-side hand surface, not its palm.
        if candidates[0][1].startswith('Thumb') and y>-.075: candidates=[entry for entry in candidates if not entry[1].startswith('Thumb')]
        local={name:1/max(.018*height,d)**4 for d,name in candidates[:2]}; total=sum(local.values())
        result={k:v*(1-arm) for k,v in torso.items()}
        for name,value in local.items(): result[name]=result.get(name,0)+arm*value/total
        result={k:v for k,v in sorted(result.items(),key=lambda entry:-entry[1])[:4] if v>.00001}; total=sum(result.values())
        return {k:v/total for k,v in result.items()}
    groups={name:mesh.vertex_groups.new(name=name) for name in joints}
    # Transfer the anatomical surface's weights barycentrically to cloth and
    # accessories. Independently classifying a sleeve by its inflated x position
    # would give it a different shoulder joint than the arm it surrounds.
    reference_weights=[weights(p) for p in reference_vertices]
    weight_tree=BVHTree.FromPolygons(reference_vertices,reference_triangles,all_triangles=True)
    def surface_weights(point):
        location,_,index,_=weight_tree.find_nearest(point)
        if index is None: raise ValueError('Human weight transfer surface missing')
        indices=reference_triangles[index]; a,b,c=(reference_vertices[i] for i in indices)
        v0=b-a; v1=c-a; v2=location-a; d00=v0.dot(v0); d01=v0.dot(v1); d11=v1.dot(v1); d20=v2.dot(v0); d21=v2.dot(v1)
        denominator=d00*d11-d01*d01
        if abs(denominator)<1e-14: blend=(1,0,0)
        else:
            v=max(0,min(1,(d11*d20-d01*d21)/denominator)); w=max(0,min(1,(d00*d21-d01*d20)/denominator)); u=max(0,1-v-w)
            total=u+v+w; blend=(u/total,v/total,w/total)
        result={}
        for vertex_index,factor in zip(indices,blend):
            for name,value in reference_weights[vertex_index].items(): result[name]=result.get(name,0)+value*factor
        result={name:value for name,value in sorted(result.items(),key=lambda pair:-pair[1])[:4] if value>.00001}; total=sum(result.values())
        return {name:value/total for name,value in result.items()}
    weight_rows=[]
    for vertex in mesh.data.vertices:
        row=surface_weights(vertex.co); weight_rows.append(row)
        for name,value in row.items(): groups[name].add([vertex.index],value,'REPLACE')
    lower=[index for index,v in enumerate(mesh.data.vertices) if v.co.z<.86*height]
    wrong=[index for index in lower if any(name.split('.')[0] in ('UpperArm','Forearm','Hand','Fingers','Thumb') for name in weight_rows[index])]
    if not lower or wrong: raise ValueError('Lower-body vertex received an arm/hand weight')
    skin=mesh.modifiers.new('HumanDeform','ARMATURE'); skin.object=rig; mesh.parent=rig
    def pose_limb(names,target,end_direction,bend_direction):
        upper,fore,hand=(rig.pose.bones[name] for name in names)
        shoulder=upper.head.copy(); desired=Vector(target)*height; direction=desired-shoulder
        distance=min(direction.length,upper.bone.length+fore.bone.length-.002); direction.normalize()
        wrist=shoulder+direction*distance; along=(upper.bone.length**2-fore.bone.length**2+distance**2)/(2*distance)
        bend=Vector(bend_direction); bend=(bend-direction*bend.dot(direction)).normalized()
        elbow=shoulder+direction*along+bend*math.sqrt(max(0,upper.bone.length**2-along**2))
        for bone,start,end in ((upper,shoulder,elbow),(fore,elbow,wrist),(hand,wrist,wrist+Vector(end_direction).normalized()*hand.bone.length)):
            rest=bone.bone.tail_local-bone.bone.head_local
            rotation=rest.rotation_difference(end-start)@bone.bone.matrix_local.to_quaternion()
            bone.matrix=Matrix.Translation(start)@rotation.to_matrix().to_4x4(); bpy.context.view_layer.update()
    profile=source['motionProfile']
    def set_pose(semantic,u):
        for bone in rig.pose.bones:
            bone.rotation_mode='QUATERNION'; bone.location=(0,0,0); bone.rotation_quaternion=(1,0,0,0); bone.scale=(1,1,1)
        def rotate(name,euler): rig.pose.bones[name].rotation_quaternion=Euler(euler,'XYZ').to_quaternion()
        wave=math.sin(u*math.tau); rotate('Head',(profile['chin']*.5,0,0)); rotate('Chest',(0,0,.01*wave))
        rig.pose.bones['Pelvis'].location.y=.004*wave
        left,right=(.42,-.12,1.28),(-.42,-.12,1.28)
        if semantic.startswith('intro'):
            left=(.39,-.27,1.56+.03*math.sin(u*math.pi)); rotate('Head',(.025,.035*wave,-.025 if semantic.endswith('positive') else .045))
        elif semantic=='charge': left=(.68,.06,1.95); rotate('Chest',(0,-.16,0))
        elif semantic.startswith('attack'):
            t=math.sin(u*math.pi/2); left=(.68+.30*t,-.10-.13*t,1.98); rotate('Chest',(.015*math.sin(u*math.pi),-.16+.45*t,0))
        elif semantic=='guard': left=(.19,-.29,2.08)
        elif semantic=='counter':
            left=(.19,-.29,2.08); t=max(0,(u-.30)/.70); right=(-.64+1.54*t,-.23,1.99)
            rig.pose.bones['Pelvis'].location.y=-.13*u/.3 if u<=.3 else -.13+.16*(u-.3)/.7
            rotate('Chest',(.02*math.sin(u*math.pi),-.16+.56*u,0))
        elif semantic in ('counter-recovery','recovery'):
            t=1-u
            if semantic.startswith('counter'): right=(-.42+1.32*t,-.12-.11*t,1.28+.71*t); rotate('Chest',(0,.40*t,0))
            else: left=(.42+.56*t,-.12-.11*t,1.28+.70*t)
        elif semantic=='hit': rotate('Head',(.015,.22*math.sin(u*math.pi),.17*math.sin(u*math.pi)))
        elif semantic=='victory': left=(.35,-.17,1.76); rotate('Head',(-.035,0,-.025))
        elif semantic=='defeat': rotate('Chest',(.11,0,.05)); rotate('Head',(.12,0,-.05))
        bpy.context.view_layer.update()
        for suffix,target in (('L',left),('R',right)): pose_limb([name+'.'+suffix for name in ('UpperArm','Forearm','Hand')],target,(0,0,1),(0,.35,-1))
        for suffix,sign in (('L',1),('R',-1)): pose_limb([name+'.'+suffix for name in ('Thigh','Shin','Foot')],(sign*.245,.04,.105),(0,-1,-.08),(0,-1,0))
    cursor=0; source_clips=[]
    for semantic,duration in V1.CLIPS:
        source_clips.append({'name':semantic,'from':cursor/60,'to':(cursor+duration)/60,'fps':60})
        for index in range(9):
            u=index/8; frame=cursor+duration*u; scene.frame_set(round(frame)); set_pose(semantic,u)
            for bone in rig.pose.bones:
                bone.keyframe_insert('rotation_quaternion',frame=frame,group=bone.name); bone.keyframe_insert('location',frame=frame,group=bone.name)
        cursor+=duration+2
    scene.frame_start=0; scene.frame_end=cursor-2; action=rig.animation_data.action; action.name='OfficeCombatTimeline'
    curves=[curve for layer in action.layers for strip in layer.strips for bag in strip.channelbags for curve in bag.fcurves]
    for curve in curves:
        for key in curve.keyframe_points: key.interpolation='LINEAR'
    def positions(frame):
        scene.frame_set(frame); bpy.context.view_layer.update(); evaluated=mesh.evaluated_get(bpy.context.evaluated_depsgraph_get()); data=evaluated.to_mesh()
        values=[v.co.copy() for v in data.vertices]; evaluated.to_mesh_clear(); return values
    rest=positions(0); changed=positions(round(source_clips[9]['from']*60+30)); displacement=max((a-b).length for a,b in zip(rest,changed))
    if displacement<.2: raise ValueError('Human skin did not deform')
    bounds=[]
    for clip in source_clips:
        values=positions(round((clip['from']+clip['to'])*30))
        low=[min(v[i] for v in values) for i in range(3)]; high=[max(v[i] for v in values) for i in range(3)]
        if any(not math.isfinite(v) for v in low+high) or low[2]<-.30*height or high[2]>2.8*height: raise ValueError('Human clip has an invalid/exploded deformation bound')
        bounds.append({'clip':clip['name'],'min':low,'max':high})
    scene.frame_set(0); bpy.ops.object.select_all(action='DESELECT'); rig.select_set(True); mesh.select_set(True); bpy.context.view_layer.objects.active=rig
    bpy.ops.export_scene.fbx(filepath=str(output/'character.fbx'),use_selection=True,object_types={'ARMATURE','MESH'},global_scale=1,apply_unit_scale=True,
        apply_scale_options='FBX_SCALE_NONE',axis_forward='-Z',axis_up='Y',use_space_transform=True,bake_space_transform=False,add_leaf_bones=False,
        use_armature_deform_only=True,primary_bone_axis='Y',secondary_bone_axis='X',armature_nodetype='NULL',mesh_smooth_type='FACE',bake_anim=True,
        bake_anim_use_all_bones=True,bake_anim_use_all_actions=False,bake_anim_use_nla_strips=False,bake_anim_force_startend_keying=True,
        bake_anim_step=1,bake_anim_simplify_factor=0,path_mode='STRIP',embed_textures=False)
    sanitized=sanitize_fbx_texture_paths(output/'character.fbx')
    scene.render.engine='CYCLES'; scene.cycles.device='CPU'; scene.cycles.samples=source['portrait']['samples']; scene.cycles.seed=151225
    scene.render.resolution_x=scene.render.resolution_y=source['portrait']['size']; scene.render.resolution_percentage=100
    scene.render.film_transparent=True; scene.render.image_settings.file_format='PNG'; scene.render.image_settings.color_mode='RGBA'; scene.render.image_settings.color_depth='8'
    scene.render.use_stamp=False; scene.render.threads_mode='FIXED'; scene.render.threads=8; scene.view_settings.view_transform='AgX'; scene.world.color=(.12,.12,.12)
    def aim(obj,target): obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()
    camera_data=bpy.data.cameras.new('HumanPortraitCamera'); camera=bpy.data.objects.new('HumanPortraitCamera',camera_data); scene.collection.objects.link(camera)
    camera_data.type='ORTHO'; camera_data.ortho_scale=2.60*height; camera.location=(3,-7,3.0); aim(camera,(0,0,1.16*height)); scene.camera=camera
    for name,location,energy,size in (('Key',(3,-4,5),500,4),('Fill',(-3,-2,3),230,4),('Rim',(1,3,4),380,3)):
        data=bpy.data.lights.new(name,'AREA'); data.energy=energy; data.shape='DISK'; data.size=size
        obj=bpy.data.objects.new(name,data); scene.collection.objects.link(obj); obj.location=location; aim(obj,(0,0,1.4))
    frame=round(next(c['from'] for c in source_clips if c['name']=='intro-positive')*60+30); scene.frame_set(frame)
    def render(path): scene.render.filepath=str(path); bpy.ops.render.render(write_still=True); V1.strip_png(path)
    render(log_root/'full-body.png')
    camera_data.ortho_scale=1.55*height; camera.location=(1.7,-6,2.25); aim(camera,(0,-.01,1.62*height))
    native.parent.mkdir(parents=True,exist_ok=True); bpy.ops.wm.save_as_mainfile(filepath=str(native),check_existing=False)
    render(output/'portrait.png')
    camera_data.ortho_scale=.65*height; camera.location=(1.4,-5,2.35); aim(camera,(0,-.01,2.05*height)); render(log_root/'head-detail.png')
    camera_data.ortho_scale=.66*height; camera.location=(1.7,-4,1.6); aim(camera,rig.pose.bones['Hand.L'].head); render(log_root/'hand-detail.png')
    image=bpy.data.images.load(str(output/'portrait.png'),check_existing=False); visible=sum(a>.1 for a in list(image.pixels)[3::4])
    mesh.calc_loop_triangles() if hasattr(mesh,'calc_loop_triangles') else None
    mesh.data.calc_loop_triangles()
    uvs=[loop.uv for loop in mesh.data.uv_layers.active.data]
    atlas={'layers':len(mesh.data.uv_layers),'tileCount':1,'min':[min(uv[i] for uv in uvs) for i in (0,1)],'max':[max(uv[i] for uv in uvs) for i in (0,1)]}
    return {'boneNames':list(joints),'boneCount':29,'vertices':len(mesh.data.vertices),'triangles':len(mesh.data.loop_triangles),
        'maxInfluences':max(map(len,weight_rows)),'blendedVertices':sum(len(w)>1 for w in weight_rows),
        'maxWeightError':max(abs(sum(w.values())-1) for w in weight_rows),'maxEvaluatedDisplacement':displacement,'fcurves':len(curves),
        'sourceClips':source_clips,'visiblePortraitPixels':visible,'portraitPoseFrame':frame,'blenderVersion':bpy.app.version_string,
        'materialNames':MATERIAL_NAMES,'materialCount':len(MATERIAL_NAMES),'restPose':'human-a-rest-v2','baseObject':BASE_OBJECT,
        'uvStrategy':'single-tile-atlas','uvAtlas':atlas,'sourceBaseVertices':10582,'sourceBaseConnected':True,
        'restJoints':{name:{'head':a,'tail':b,'parent':parent} for name,(a,b,parent) in joints.items()},'sanitizedTextureFields':sanitized,
        'semanticWeightAudit':{'lowerBodyVertices':len(lower),'misassignedLowerBody':len(wrong)},'evaluatedClipBounds':bounds,
        'timelineFps':{'fps':scene.render.fps,'fpsBase':scene.render.fps_base}}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role',choices=['manager'],default='manager'); parser.add_argument('--source-root'); parser.add_argument('--output-root')
    parser.add_argument('--sync-imports',action='store_true'); parser.add_argument('--check',action='store_true'); parser.add_argument('--bpy',action='store_true')
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else None)
    if sha((ROOT/'tools/create-office-cast.py').read_bytes())!=FROZEN: raise ValueError('Frozen v1 generator changed')
    source_root=bounded(args.source_root or ROOT); output_root=bounded(args.output_root or ROOT)
    rebuild=ROOT/'game/local/asset-rebuild'
    if any(root!=ROOT and not root.is_relative_to(rebuild) for root in (source_root,output_root)): raise ValueError('Only isolated project rebuild roots allowed')
    asset=bounded(output_root/'game/assets/resources/office-cast/manager'); asset.mkdir(parents=True,exist_ok=True)
    manifest_path=asset/'manifest.json'; source_path=source_root/'game/assets/resources/office-cast/manager/manifest.json'
    old=json.loads(source_path.read_text(encoding='utf-8-sig')) if source_path.exists() else {}
    source=old['source'] if old.get('source',{}).get('generatorVersion')==VERSION else default_source()
    validate_source(source); script=Path(__file__).read_bytes(); source_hash=sha(script+V1.canonical(source))
    manifest={'schemaVersion':1,'source':source,'generated':old.get('generated',{})}
    log_root=bounded(output_root/'game/local/character-production-v2/manager'); log_root.mkdir(parents=True,exist_ok=True)
    if args.bpy:
        mesh=make_character(source,asset,bounded(output_root/'game/local/character-source-v2/manager.blend'),log_root)
        write_json(log_root/'mesh-receipt.json',mesh); return
    if args.sync_imports:
        imports=sync_imports(asset,manifest); write_json(manifest_path,manifest); print(json.dumps({'synced':'manager','imports':imports})); return
    if args.check:
        g=manifest['generated']; assert g['generatorSha256']==sha(script) and g['sourceHash']==source_hash,'Human source changed; regenerate'
        for name,record in g['outputs'].items():
            file=bounded(output_root/record['path']); assert file==asset/name and sha(file.read_bytes())==record['sha256'] and file.stat().st_size==record['bytes']
        skin=convert_and_inspect(asset,log_root,g['mesh']['sourceClips']); assert skin==g['convertedSkin'],'Converted human skin changed'
        actual=sync_imports(asset,manifest,write_splits=False); assert actual==g['imports'],'Actual human import changed'
        print(json.dumps({'passed':True,'role':'manager','sourceHash':source_hash})); return
    backup=bounded(ROOT/'game/local/character-v1-backup/manager')
    if old.get('source',{}).get('generatorVersion')!='office-human-2' and not backup.exists(): shutil.copytree(asset,backup)
    write_json(manifest_path,manifest)
    portable=ROOT/'game/local/toolchain/blender-4.5.14-windows-x64/blender.exe'
    env=dict(os.environ)
    for key,sub in [('TEMP','temp'),('TMP','temp'),('BLENDER_USER_CONFIG','config'),('BLENDER_USER_DATAFILES','data'),('BLENDER_USER_SCRIPTS','scripts'),('BLENDER_USER_EXTENSIONS','extensions')]:
        folder=bounded(log_root/sub); folder.mkdir(exist_ok=True); env[key]=str(folder)
    command=[str(portable),'--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',str(Path(__file__).resolve()),'--','--role','manager','--bpy']
    if args.source_root: command+=['--source-root',str(source_root)]
    if args.output_root: command+=['--output-root',str(output_root)]
    result=subprocess.run(command,cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace')
    (log_root/'blender-stdout.log').write_text(result.stdout,encoding='utf-8'); (log_root/'blender-stderr.log').write_text(result.stderr,encoding='utf-8')
    if result.returncode: raise RuntimeError('Human Blender generation failed; see project-local production-v2 logs')
    mesh=json.loads((log_root/'mesh-receipt.json').read_text()); skin=convert_and_inspect(asset,log_root,mesh['sourceClips'])
    outputs={}
    for name in ('character.fbx','portrait.png','fabric.png'):
        file=asset/name; raw=file.read_bytes(); record={'path':file.relative_to(output_root).as_posix(),'bytes':len(raw),'sha256':sha(raw),'format':'FBX7400' if name.endswith('fbx') else 'PNG-RGBA8'}
        if name.endswith('png'): record.update(width=struct.unpack_from('>I',raw,16)[0],height=struct.unpack_from('>I',raw,20)[0])
        outputs[name]=record
    manifest['generated']={'generatorSha256':sha(script),'sourceHash':source_hash,'portraitReviewed':False,'outputs':outputs,'mesh':mesh,'convertedSkin':skin,'imports':old.get('generated',{}).get('imports')}
    write_json(manifest_path,manifest)
    print(json.dumps({'generated':'manager','sourceHash':source_hash,'mesh':{key:mesh[key] for key in ('vertices','triangles','boneCount','materialCount')},'skin':skin},ensure_ascii=False))


if __name__=='__main__': main()
