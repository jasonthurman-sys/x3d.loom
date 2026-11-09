#!/usr/bin/env python3 -I
"""X3D 4.0 -> Babylon bridge driver: the tracker, the step-by-step loop and the batch report.

  driver.py init  [--uom X3DUOM.xml]       build/refresh NODES.json (260 concrete nodes) + NODES.md; keeps every node's status
  driver.py status                          totals by status and by component
  driver.py next  [-n 5]                    the next nodes in rank order that nobody has claimed
  driver.py scaffold NODE...                module (field table generated from the UOM) + fixture + test skeleton, never overwrites
  driver.py check NODE... [--no-xite]       fixture vs x3d-4.0.xsd, then the test spec in our reader and in X_ITE; writes receipts/NODE.json
  driver.py batch [-n 5] [--close]          check enough new nodes for a batch of n, run the regression gate, mark passers `bridged`; with --close number the batch of n and write BATCH-NN.md
  driver.py report N                        rewrite BATCH-NN.md from NODES.json and the receipts

Status values: todo | wip (module exists, not yet checked) | base (reader already knew it before this work) | bridged (new here, fixture + test pass)
               | gap (bridged with a logged gap) | claimed (another port thread owns it) | blocked.
Everything the driver counts names its source: UOM file, census (reader parts at a commit), xmllint + XSD, Chromium + X_ITE versions in each receipt.
"""
import argparse, glob, json, os, re, subprocess, sys
from lxml import etree

HERE = os.path.dirname(os.path.abspath(__file__))
BR = os.path.dirname(HERE)                      # x3d.webgpu/bridge
WEBGPU = os.path.dirname(BR)                    # x3d.webgpu
SRC = os.path.join(WEBGPU, 'demo', 'src')
NODES_JSON = os.path.join(BR, 'NODES.json')
UOM_DEFAULT = os.environ.get('X3DUOM', '/home/user/x3d_mcp/src/validation/schemas/X3dUnifiedObjectModel-4.0.xml')
XSD_DEFAULT = os.environ.get('X3DXSD', '/home/user/x3d_mcp/src/validation/schemas/x3d-4.0.xsd')

# --- rank: explicit order first (value for a viewer, then testability), then component weight --------------------------------------------
ORDER = """
BooleanToggle BooleanTrigger IntegerTrigger TimeTrigger PositionInterpolator2D
NormalInterpolator SplinePositionInterpolator SplinePositionInterpolator2D SplineScalarInterpolator SquadOrientationInterpolator
MetadataBoolean MetadataFloat ScalarChaser ScalarDamper PositionChaser PositionDamper OrientationChaser OrientationDamper ColorChaser ColorDamper
PositionChaser2D PositionDamper2D CoordinateChaser CoordinateDamper TexCoordChaser2D TexCoordDamper2D
PlaneSensor SphereSensor CylinderSensor VisibilitySensor TransformSensor KeySensor StringSensor LoadSensor Anchor
TriangleFanSet QuadSet IndexedQuadSet IndexedTriangleFanSet IndexedTriangleStripSet LineSet TriangleSet2D Arc2D ArcClose2D Circle2D Polyline2D Polypoint2D
StaticGroup TextureCoordinateGenerator MultiTexture MultiTextureTransform FillProperties TwoSidedMaterial MovieTexture
Script TextureBackground LocalFog Collision CollisionSensor
""".split()
COMPONENT_ORDER = """Interpolation EventUtilities Followers Core Grouping Shape Geometry3D Geometry2D Rendering Texturing PointingDeviceSensor EnvironmentalSensor
KeyDeviceSensor Navigation Lighting EnvironmentalEffects Time Sound Text Scripting Networking Layering Layout Shaders CubeMapTexturing Texturing3D ParticleSystems Picking
NURBS HAnim CADGeometry Geospatial RigidBodyPhysics VolumeRendering DIS TextureProjection""".split()
KIND = {'Interpolation': 'event', 'EventUtilities': 'event', 'Followers': 'event', 'Core': 'data', 'Time': 'event', 'Scripting': 'event', 'Networking': 'io',
        'Grouping': 'group', 'Layering': 'group', 'Layout': 'group', 'Navigation': 'camera', 'PointingDeviceSensor': 'sensor', 'EnvironmentalSensor': 'sensor',
        'KeyDeviceSensor': 'sensor', 'Picking': 'sensor', 'Shape': 'appearance', 'Texturing': 'texture', 'Texturing3D': 'texture', 'CubeMapTexturing': 'texture',
        'TextureProjection': 'texture', 'Geometry3D': 'geometry', 'Geometry2D': 'geometry', 'Rendering': 'geometry', 'NURBS': 'geometry', 'CADGeometry': 'geometry',
        'Geospatial': 'geometry', 'HAnim': 'geometry', 'Lighting': 'light', 'EnvironmentalEffects': 'env', 'Sound': 'sound', 'Text': 'text', 'Shaders': 'shader',
        'ParticleSystems': 'particles', 'RigidBodyPhysics': 'physics', 'VolumeRendering': 'volume', 'DIS': 'network'}
CLAIMED = {n: 'Library hall port (parallel port thread), 8 Nov 2026' for n in
           'Collision CoordinateInterpolator CoordinateInterpolator2D Disk2D Extrusion MultiTextureCoordinate PointProperties Rectangle2D'.split()}
# nodes that exist only in X_ITE / 4.1, so the reader census may list them but they are not part of the 260
NOT_4_0 = {'GaussianSplats', 'EnvironmentLight', 'BlendMode', 'DepthMode'}


def load(): return json.load(open(NODES_JSON)) if os.path.exists(NODES_JSON) else None
def save(d):
    json.dump(d, open(NODES_JSON, 'w'), indent=1); open(NODES_JSON, 'a').write('\n')
    open(os.path.join(BR, 'NODES.md'), 'w').write(render_md(d))


def git_head():
    try: return subprocess.check_output(['git', '-C', WEBGPU, 'rev-parse', '--short', 'HEAD'], text=True).strip()
    except Exception: return '?'


def census():
    out = subprocess.check_output(['node', os.path.join(HERE, 'census.js'), SRC], text=True)
    return set(json.loads(out)['defs'])


def uom_nodes(path):
    r = etree.parse(path).getroot(); res = {}
    for n in r.xpath('//ConcreteNode'):
        i = n.find('InterfaceDefinition'); ci = i.find('componentInfo')
        cf = i.find('containerField')
        res[n.get('name')] = {'component': ci.get('name'), 'level': int(ci.get('level')), 'base': i.find('Inheritance').get('baseType'),
                              'container': cf.get('default') if cf is not None else 'children', 'appinfo': (i.get('appinfo') or '')[:200],
                              'fields': [f.get('name') for f in i.findall('field') if f.get('inheritedFrom') != 'X3DNode' or f.get('name') == 'metadata']}
    return res


def cmd_init(a):
    uom = uom_nodes(a.uom); old = (load() or {}).get('nodes', {}); read = census()
    names = sorted(uom)
    def key(n):
        c = uom[n]['component']
        return (ORDER.index(n) if n in ORDER else 1000 + (COMPONENT_ORDER.index(c) if c in COMPONENT_ORDER else 99) * 100, uom[n]['level'], n)
    nodes = {}
    for n in names:
        o = old.get(n, {}); u = uom[n]
        st = o.get('status') or ('claimed' if n in CLAIMED else 'base' if n in read else 'todo')
        if st in ('todo', 'base') and n in CLAIMED: st = 'claimed'
        nodes[n] = {'component': u['component'], 'level': u['level'], 'kind': KIND.get(u['component'], 'other'), 'inherits': u['base'], 'container': u['container'],
                    'nfields': len(u['fields']), 'status': st, 'batch': o.get('batch'), 'receipt': o.get('receipt'), 'note': CLAIMED.get(n) or o.get('note') or ''}
    ranked = sorted(names, key=key)
    for i, n in enumerate(ranked): nodes[n]['rank'] = i + 1
    extra = sorted(read - set(uom) - NOT_4_0)
    d = {'meta': {'uom': os.path.basename(a.uom) + ' (x3d_mcp src/validation/schemas)', 'total': len(nodes), 'census_commit': git_head(),
                  'census_parts': 'brain/reader, gobbler/reader-ext, demiurge/reader-ext-dm, dynasty/reader-ext-dl, manifold/manifold-reader-ext, drift/drift-ext',
                  'reader_types_not_in_4_0': sorted((read & NOT_4_0)) + extra}, 'nodes': nodes}
    save(d); print(f'NODES.json: {len(nodes)} concrete nodes (UOM 4.0), reader census {len(read)} types ({len(read & set(nodes))} in X3D 4.0, {len(read & NOT_4_0)} X_ITE/4.1 only)')


def counts(d):
    c = {}
    for v in d['nodes'].values(): c[v['status']] = c.get(v['status'], 0) + 1
    return c


def read_total(d):    # nodes the reader knows: base + everything bridged here
    c = counts(d); return c.get('base', 0) + c.get('bridged', 0) + c.get('gap', 0)


def render_md(d):
    n = len(d['nodes']); c = counts(d)
    L = ['# X3D 4.0 to Babylon bridge: node tracker', '',
         f"Generated by `bridge/tools/driver.py` from NODES.json. Source of the list: {d['meta']['uom']} ({n} concrete nodes). Baseline: reader census over {d['meta']['census_parts']} at x3d.loom {d['meta']['census_commit']}.", '',
         f"**Reader knows {read_total(d)} of {n}** ({100*read_total(d)/n:.1f}%): {c.get('base', 0)} baseline + {c.get('bridged', 0) + c.get('gap', 0)} bridged in this work ({c.get('gap', 0)} of them with a logged gap). "
         f"Todo {c.get('todo', 0)}, wip {c.get('wip', 0)}, claimed by another port {c.get('claimed', 0)}, blocked {c.get('blocked', 0)}.", '',
         'Statuses: base (reader already knew it), bridged (new: fixture validates against x3d-4.0.xsd, test passes in our reader and in X_ITE where it applies), gap, wip, todo, claimed, blocked.', '']
    comps = {}
    for k, v in d['nodes'].items(): comps.setdefault(v['component'], []).append((v['rank'], k, v))
    L += ['| component | nodes | base | bridged | gap | wip | claimed | todo |', '|---|---|---|---|---|---|---|---|']
    for comp in sorted(comps, key=lambda x: min(r for r, _, _ in comps[x])):
        s = {}; [s.__setitem__(v['status'], s.get(v['status'], 0) + 1) for _, _, v in comps[comp]]
        L.append(f"| {comp} | {len(comps[comp])} | {s.get('base', 0)} | {s.get('bridged', 0)} | {s.get('gap', 0)} | {s.get('wip', 0)} | {s.get('claimed', 0)} | {s.get('todo', 0)} |")
    L += ['', '## Every node, in rank order', '', '| # | node | component | lvl | kind | status | batch | note |', '|---|---|---|---|---|---|---|---|']
    for k, v in sorted(d['nodes'].items(), key=lambda kv: kv[1]['rank']):
        L.append(f"| {v['rank']} | {k} | {v['component']} | {v['level']} | {v['kind']} | {v['status']} | {v['batch'] or ''} | {v['note'] or ''} |")
    return '\n'.join(L) + '\n'


def cmd_status(a):
    d = load(); c = counts(d); n = len(d['nodes'])
    print(f"reader knows {read_total(d)}/{n}  |  " + '  '.join(f'{k} {v}' for k, v in sorted(c.items())))


def pick(d, n):
    return [k for k, v in sorted(d['nodes'].items(), key=lambda kv: kv[1]['rank']) if v['status'] in ('todo', 'wip')][:n]


def cmd_next(a):
    d = load()
    for k in pick(d, a.n):
        v = d['nodes'][k]; mod = os.path.exists(os.path.join(BR, 'src', 'nodes', k + '.js'))
        print(f"#{v['rank']:<3} {k:34s} {v['component']:22s} L{v['level']} {v['kind']:10s} {'module' if mod else 'no module'}  {v['status']}")


# --- scaffold: field table from the UOM -----------------------------------------------------------------------------------------------
ACC = {'initializeOnly': 'INIT', 'inputOnly': 'IN', 'outputOnly': 'OUT', 'inputOutput': 'IO'}
def js_default(t, s):
    if t == 'SFNode': return 'null'
    if t == 'MFNode' or t.startswith('MF'): return '[]'
    if t == 'SFBool': return 'true' if (s or '').lower() == 'true' else 'false'
    if t == 'SFString': return json.dumps(s or '')
    if t in ('SFInt32',): return str(int(float(s))) if s not in (None, '') else '0'
    if t in ('SFFloat', 'SFTime', 'SFDouble'): return s if s not in (None, '') else '0'
    nums = re.split(r'[\s,]+', (s or '').strip()) if s else []
    size = {'SFVec2f': 2, 'SFVec2d': 2, 'SFVec3f': 3, 'SFVec3d': 3, 'SFColor': 3, 'SFVec4f': 4, 'SFVec4d': 4, 'SFColorRGBA': 4, 'SFRotation': 4, 'SFMatrix3f': 9, 'SFMatrix3d': 9, 'SFMatrix4f': 16, 'SFMatrix4d': 16}.get(t)
    if size:
        nums = [x for x in nums if x] or ['0'] * size
        return '[' + ', '.join(nums[:size]) + ']'
    return '[]'


def scaffold_one(name, d, uom_path):
    r = etree.parse(uom_path).getroot()
    n = [x for x in r.xpath('//ConcreteNode') if x.get('name') == name]
    if not n: print('not an X3D 4.0 concrete node:', name); return
    i = n[0].find('InterfaceDefinition'); lines = []
    for f in i.findall('field'):
        if f.get('inheritedFrom') == 'X3DNode' and f.get('name') != 'metadata': continue
        t, acc = f.get('type'), ACC[f.get('accessType')]
        lines.append(f"    {f.get('name')}: ['{t}', {acc}, {js_default(t, f.get('default'))}],")
    cf = i.find('containerField'); ci = i.find('componentInfo')
    mod = os.path.join(BR, 'src', 'nodes', name + '.js'); os.makedirs(os.path.dirname(mod), exist_ok=True)
    if not os.path.exists(mod):
        open(mod, 'w').write(f"""/* {name} ({ci.get('name')} level {ci.get('level')}): {(i.get('appinfo') or '').strip()[:160]}
   Field table generated from X3DUOM 4.0 by driver.py scaffold; the behaviour below is hand written. */
BR.node('{name}', {{
  component: '{ci.get('name')}', level: {ci.get('level')},
  container: '{cf.get('default') if cf is not None else 'children'}',
  defs: {{
{chr(10).join(lines)}
  }},
  // receive(n, field, value): return true when the event is handled here
  // tick(n, now): once per timestamp, before the event queue drains
  // build(body, n, parent, chain): a drawn node
}});
""")
        print('wrote', os.path.relpath(mod, WEBGPU))
    fx = os.path.join(BR, 'fixtures', name + '.x3d'); os.makedirs(os.path.dirname(fx), exist_ok=True)
    if not os.path.exists(fx):
        open(fx, 'w').write(f"""<?xml version="1.0" encoding="UTF-8"?>
<X3D profile="Immersive" version="4.0" xmlns:xsd="http://www.w3.org/2001/XMLSchema-instance" xsd:noNamespaceSchemaLocation="https://www.web3d.org/specifications/x3d-4.0.xsd">
  <head><meta name="title" content="{name}.x3d"/><meta name="description" content="Bridge fixture for {name}"/></head>
  <Scene>
    <{name} DEF="N"/>
  </Scene>
</X3D>
""")
        print('wrote', os.path.relpath(fx, WEBGPU))
    ts = os.path.join(BR, 'fixtures', name + '.test.json')
    if not os.path.exists(ts):
        open(ts, 'w').write(json.dumps({'node': name, 'mode': 'events', 'steps': [{'set': ['N', 'FIELD', None]}, {'expect': ['N', 'FIELD', None]}]}, indent=1) + '\n'); print('wrote', os.path.relpath(ts, WEBGPU))
    if d['nodes'][name]['status'] == 'todo': d['nodes'][name]['status'] = 'wip'


def cmd_scaffold(a):
    d = load()
    for n in a.nodes: scaffold_one(n, d, a.uom)
    save(d)


# --- check ------------------------------------------------------------------------------------------------------------------------------
def xsd_patched(xsd, allow, choice=()):
    """The 4.0 XSD from x3d_mcp has two defects that no scene can work around:
    - LayoutGroup is listed only inside the pick-target content model, in no child content model, so no scene can hold a LayoutGroup and still validate;
    - the children of ComposedTexture3D are written as an xs:sequence of ImageTexture, PixelTexture, MovieTexture, ProtoInstance (repeated), not an xs:choice, so the children must come in fours.
    A test spec may name them in "xsdAllow" (a node added next to ScreenGroup, the child model of the Full profile) and "xsdChoice" (the element's sequence becomes a choice). The fixture is then
    checked against a copy of the XSD with that one change; the receipt says so."""
    s = open(xsd).read(); anchor = '      <xs:element ref="ScreenGroup"/>\n      <xs:element ref="LinePickSensor"/>'
    if allow and anchor not in s: return None
    for n in allow: s = s.replace(anchor, anchor.replace('      <xs:element ref="LinePickSensor"/>', '      <xs:element ref="%s"/>\n      <xs:element ref="LinePickSensor"/>' % n), 1)
    for n in choice:
        i = s.find('<xs:element name="%s">' % n); j = s.find('<xs:sequence minOccurs="0" maxOccurs="unbounded">', i); k = s.find('</xs:sequence>', j)
        if i < 0 or j < 0 or k < 0: return None
        s = s[:j] + '<xs:choice minOccurs="0" maxOccurs="unbounded">' + s[j + len('<xs:sequence minOccurs="0" maxOccurs="unbounded">'):k] + '</xs:choice>' + s[k + len('</xs:sequence>'):]
    tag = '-'.join(list(allow) + ['choice-' + c for c in choice])
    out = os.path.join(os.path.dirname(xsd), '.x3d-4.0.patched-' + tag + '.xsd')
    try: open(out, 'w').write(s)
    except OSError: out = os.path.join('/tmp', 'x3d-4.0.patched-' + tag + '.xsd'); open(out, 'w').write(s)
    return out


def xsd_check(name, xsd):
    fx = os.path.join(BR, 'fixtures', name + '.x3d')
    if not os.path.exists(fx): return {'ok': False, 'msg': 'no fixture'}
    if not os.path.isfile(xsd): return {'ok': False, 'msg': 'X3D schema unavailable: set X3DXSD or --xsd'}
    note = ''
    try: spec = json.load(open(os.path.join(BR, 'fixtures', name + '.test.json')))
    except Exception: spec = {}
    allow, choice = spec.get('xsdAllow') or [], spec.get('xsdChoice') or []
    if allow or choice:
        px = xsd_patched(xsd, allow, choice)
        if px: xsd = px; note = ' + XSD patched: ' + '; '.join([n + ' added to the Full child content model' for n in allow] + [c + ' children as a choice, not a sequence' for c in choice])
    try: p = subprocess.run(['xmllint', '--noout', '--schema', xsd, fx], capture_output=True, text=True)
    except FileNotFoundError: return {'ok': False, 'msg': 'xmllint unavailable: install libxml2-utils (or the platform equivalent)'}
    return {'ok': p.returncode == 0, 'msg': (p.stderr.strip().splitlines() or [''])[-1][:300], 'validator': 'xmllint (libxml2) vs x3d-4.0.xsd from x3d_mcp' + note}


def run_tests(names, xite=True, babylon=None):
    cmd = ['node', os.path.join(HERE, 'run-tests.js')] + (['--no-xite'] if not xite else []) + (['--babylon', babylon] if babylon else []) + names
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=BR)
    sys.stderr.write(p.stderr[-2000:])
    try: return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception: return {'error': 'test runner gave no JSON', 'stdout': p.stdout[-800:]}


def cmd_check(a, names=None):
    d = load(); names = names or a.nodes
    res = run_tests(names, not a.no_xite, getattr(a, 'babylon', None)); out = {}
    for n in names:
        x = xsd_check(n, a.xsd); t = (res.get('results') or {}).get(n, {'ok': False, 'msg': res.get('error', 'no result')})
        ok = x['ok'] and t.get('ok', False) and res.get('ok') is not False and not res.get('error')
        rec = {'node': n, 'pass': ok, 'xsd': x, 'test': t, 'env': res.get('env'), 'driver_commit': git_head()}
        os.makedirs(os.path.join(BR, 'receipts'), exist_ok=True)
        json.dump(rec, open(os.path.join(BR, 'receipts', n + '.json'), 'w'), indent=1); open(os.path.join(BR, 'receipts', n + '.json'), 'a').write('\n')
        if n in d['nodes']: d['nodes'][n]['receipt'] = f'receipts/{n}.json'
        out[n] = rec
        print(f"{'PASS' if ok else 'FAIL'} {n:30s} xsd:{'ok' if x['ok'] else x['msg']}  ours:{t.get('ours', t.get('ok'))}  xite:{t.get('xite', '-')}  {t.get('msg', '')}")
    save(d); return out


def regression_gate(a):
    """The ROUTE chain (every bridged event node in one scene) in our reader + X_ITE, then inside the real Babylon WebGPU body: no page errors, the Switch moves."""
    chain = cmd_check(a, ['_route-chain'])['_route-chain']
    sm = {'error': 'not run'}
    try:
        cmd = ['node', os.path.join(HERE, 'smoke.js'), os.path.join(BR, 'fixtures', '_route-chain.x3d'), '4'] + (['--babylon', a.babylon] if a.babylon else [])
        sm = json.loads(subprocess.run(cmd, capture_output=True, text=True, cwd=BR, timeout=170).stdout.strip().splitlines()[-1])
    except Exception as e: sm = {'error': str(e)[:160]}
    ok = chain["pass"] and sm.get('ok') is True and sm.get('frames', 0) > 0 and not sm.get('error') and not sm.get('pageErrors') and sm.get('switches') == [1] and not sm.get('notes') and (sm.get('events') or {}).get('Ch.value_changed', 0) >= 4 and (sm.get('events') or {}).get('Dm.value_changed', 0) >= 4
    g = {'ok': ok, 'chain': chain['pass'], 'body': {k: sm.get(k) for k in ('frames', 'babylon', 'adapter', 'pageErrors', 'notes', 'switches', 'error')}}; g['body']['follower_events'] = {k: (sm.get('events') or {}).get(k) for k in ('Ch.value_changed', 'Dm.value_changed')}
    json.dump(g, open(os.path.join(BR, 'receipts', '_gate.json'), 'w'), indent=1); print('gate', 'PASS' if ok else 'FAIL', json.dumps(g['body'])[:300]); return g


def unreported(d):
    return [k for k, v in sorted(d['nodes'].items(), key=lambda kv: kv[1]['rank']) if v['status'] in ('bridged', 'gap') and not v['batch']]


def write_report(d, nb, nodes, gate=None):
    c = counts(d); n = len(d['nodes']); gate = gate or json.load(open(os.path.join(BR, 'receipts', '_gate.json')))
    gb = gate['body']; recs = {k: json.load(open(os.path.join(BR, 'receipts', k + '.json'))) for k in nodes}
    env = next((r['env'] for r in recs.values() if r.get('env')), {})
    upto = sum(1 for v in d['nodes'].values() if v['status'] in ('bridged', 'gap') and v['batch'] and v['batch'] <= nb)
    L = [f'# Bridge batch {nb}', '', f'Reader knows **{c.get("base", 0) + upto}/{n}** X3D 4.0 node types after this batch ({upto} bridged in this work so far, {c.get("base", 0)} baseline). Rig: {json.dumps(env)}.', '',
         f"Regression gate (all bridged event nodes in one ROUTE chain, ours + X_ITE): {'PASS' if gate['ok'] else 'FAIL'}; inside the real Babylon {gb.get('babylon')} WebGPU body on {(gb.get('adapter') or {}).get('architecture')}: {gb.get('frames')} frames, page errors {len(gb.get('pageErrors') or [])}, Switch ended on {gb.get('switches')}.", '',
         '| node | component | xsd | ours | X_ITE | verdict | note |', '|---|---|---|---|---|---|---|']
    for k in nodes:
        r = recs[k]; t = r['test']
        L.append(f"| {k} | {d['nodes'][k]['component']} | {'ok' if r['xsd']['ok'] else 'FAIL'} | {t.get('ours', '')} | {t.get('xite', '')} | {'PASS' if r['pass'] else 'FAIL'} | {d['nodes'][k]['note'] or ''} |")
    open(os.path.join(BR, f'BATCH-{nb:02d}.md'), 'w').write('\n'.join(L) + '\n'); return '\n'.join(L)


def cmd_report(a):
    d = load(); nodes = [k for k, v in sorted(d['nodes'].items(), key=lambda kv: kv[1]['rank']) if v['batch'] == a.batch]
    print(write_report(d, a.batch, nodes))


def cmd_batch(a):
    """Check enough new nodes to make a batch of n (counting nodes bridged earlier but not yet reported), then with --close number the batch and write BATCH-NN.md."""
    if a.no_xite: raise SystemExit('batch requires X_ITE comparison; --no-xite is only for local exploratory checks')
    d = load(); have = unreported(d)
    ready = [k for k in pick(d, 10 ** 6) if os.path.exists(os.path.join(BR, 'src', 'nodes', k + '.js'))][:max(0, a.n - len(have))]
    if len(have) + len(ready) < a.n: print(f'{len(have)} unreported + {len(ready)} with a module is less than {a.n}; scaffold + implement the next ones first:', ', '.join(pick(d, a.n)))
    # Pending nodes may have stale or local-only receipts from an intervening
    # check. Recheck the prospective batch, not just freshly scaffolded nodes.
    checked = have[:a.n] + ready
    res = cmd_check(a, checked) if checked else {}
    gate = regression_gate(a)
    d = load()
    for k in checked:
        if res[k]['pass'] and gate['ok']:
            gaps = res[k]['test'].get('gaps'); d['nodes'][k]['status'] = 'gap' if gaps else 'bridged'
            if gaps: d['nodes'][k]['note'] = '; '.join(gaps)
        else: d['nodes'][k]['status'] = 'wip'
    save(d)
    for k in checked: print(f"  {k}: {d['nodes'][k]['status']}")
    have = unreported(d)
    # Existing unreported nodes must not let a failed current gate close a batch.
    if not gate['ok'] or any(not res[k]['pass'] for k in checked):
        print('batch remains open: node checks or regression gate failed')
        return False
    if not a.close or len(have) < a.n: print(f'{len(have)} nodes bridged and not yet in a batch report (need {a.n})'); return
    nb = 1 + max([int(re.sub(r'\D', '', f)) for f in os.listdir(BR) if re.match(r'BATCH-\d+\.md', f)] or [0])
    take = have[:a.n]
    for k in take: d['nodes'][k]['batch'] = nb
    save(d); txt = write_report(d, nb, take, gate)
    print(txt); print(f'\nbatch {nb} closed: {len(take)} nodes; next up:', ', '.join(pick(d, 5)))


def main():
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest='cmd', required=True)
    for name in ('init', 'status', 'next', 'scaffold', 'check', 'batch', 'report'):
        p = sp.add_parser(name); p.add_argument('--uom', default=UOM_DEFAULT); p.add_argument('--xsd', default=XSD_DEFAULT)
        p.add_argument('--no-xite', action='store_true'); p.add_argument('--babylon', default=None)
        if name == 'next': p.add_argument('-n', type=int, default=5)
        if name == 'batch': p.add_argument('-n', type=int, default=5); p.add_argument('--close', action='store_true')
        if name == 'report': p.add_argument('batch', type=int)
        if name in ('scaffold', 'check'): p.add_argument('nodes', nargs='+')
    a = ap.parse_args()
    result = {'init': cmd_init, 'status': cmd_status, 'next': cmd_next, 'scaffold': cmd_scaffold, 'check': cmd_check, 'batch': cmd_batch, 'report': cmd_report}[a.cmd](a)
    if result is False or (a.cmd == 'check' and not all(r['pass'] for r in result.values())): return 1
    return 0


if __name__ == '__main__': sys.exit(main())
