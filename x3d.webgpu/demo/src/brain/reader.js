/* x3d reader for the Babylon body: parser, field tables, event model (copied from viewer-v3, extended with the nodes the brain scenes use) */
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; },
};
const m4 = { ident() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; } };
const quat = {
  fromAxisAngle(ax, ang) { const n = v3.norm(ax); if (!n[0] && !n[1] && !n[2]) return [0, 0, 0, 1]; const s = Math.sin(ang / 2); return [n[0] * s, n[1] * s, n[2] * s, Math.cos(ang / 2)]; },
  mul: (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
                  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]],
  norm(a) { const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1; return [a[0] / l, a[1] / l, a[2] / l, a[3] / l]; },
  rotate(q, v) {
    const u = [q[0], q[1], q[2]], w = q[3], uv = v3.cross(u, v), uuv = v3.cross(u, uv);
    return [v[0] + 2 * (w * uv[0] + uuv[0]), v[1] + 2 * (w * uv[1] + uuv[1]), v[2] + 2 * (w * uv[2] + uuv[2])];
  },
  slerp(a, b, t) { // shortest path, as 19775-1 asks of OrientationInterpolator
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (d < 0) { b = b.map((x) => -x); d = -d; }
    if (d > 0.9995) return quat.norm(a.map((x, i) => x + (b[i] - x) * t));
    const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return a.map((x, i) => x * wa + b[i] * wb);
  },
  toAxisAngle(q) {
    const w = clamp(q[3], -1, 1), s = Math.sqrt(1 - w * w);
    if (s < 1e-6) return [0, 0, 1, 0];
    return [q[0] / s, q[1] / s, q[2] / s, 2 * Math.acos(w)];
  },
  fromMat(m) { // rotation part of a column-major matrix with uniform scale (the Viewpoint's parent transform)
    const c = (i) => { const l = Math.hypot(m[i], m[i + 1], m[i + 2]) || 1; return [m[i] / l, m[i + 1] / l, m[i + 2] / l]; };
    const a = c(0), b = c(4), d = c(8), tr = a[0] + b[1] + d[2];
    let q;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(b[2] - d[1]) / s, (d[0] - a[2]) / s, (a[1] - b[0]) / s, s / 4]; }
    else if (a[0] > b[1] && a[0] > d[2]) { const s = Math.sqrt(1 + a[0] - b[1] - d[2]) * 2; q = [s / 4, (b[0] + a[1]) / s, (d[0] + a[2]) / s, (b[2] - d[1]) / s]; }
    else if (b[1] > d[2]) { const s = Math.sqrt(1 + b[1] - a[0] - d[2]) * 2; q = [(b[0] + a[1]) / s, s / 4, (d[1] + b[2]) / s, (d[0] - a[2]) / s]; }
    else { const s = Math.sqrt(1 + d[2] - a[0] - b[1]) * 2; q = [(d[0] + a[2]) / s, (d[1] + b[2]) / s, s / 4, (a[1] - b[0]) / s]; }
    return quat.norm(q);
  },
  toMat(q) {
    const [x, y, z, w] = q, m = m4.ident();
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + w * z); m[2] = 2 * (x * z - w * y);
    m[4] = 2 * (x * y - w * z); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + w * x);
    m[8] = 2 * (x * z + w * y); m[9] = 2 * (y * z - w * x); m[10] = 1 - 2 * (x * x + y * y);
    return m;
  },
};
const R = { hooks: {} };
// IDs identify logical nodes across all execution contexts, including detached
// scenes. Per-parse indices alias event guards and Babylon caches after import.
let nextNodeId = 0;
R.allocNodeId = () => nextNodeId++;
const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : 0; };
const numList = (s) => { const t = String(s).replace(/,/g, ' ').trim(); return t ? t.split(/\s+/).map(num) : []; };
const chunk = (a, n) => { const o = []; for (let i = 0; i + n <= a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const fixed = (n, d) => (s) => { const a = numList(s); while (a.length < n) a.push(d[a.length] ?? 0); return a.slice(0, n); };
function mfString(s) { const out = []; const re = /"((?:[^"\\]|\\.)*)"/g; let m; while ((m = re.exec(s))) out.push(m[1].replace(/\\(.)/g, '$1')); return out.length || !s.trim() ? out : [s.trim()]; }
const PARSE = {
  SFBool: (s) => /^\s*true\s*$/i.test(s), SFString: (s) => s, SFInt32: (s) => parseInt(s, 10) || 0,
  SFFloat: num, SFTime: num, SFDouble: num,
  SFVec2f: fixed(2, [0, 0]), SFVec4f: fixed(4, [0, 0, 0, 0]), SFVec3f: fixed(3, [0, 0, 0]), SFColor: fixed(3, [0, 0, 0]), SFColorRGBA: fixed(4, [0, 0, 0, 1]), SFRotation: fixed(4, [0, 0, 1, 0]),
  MFFloat: numList, MFInt32: (s) => numList(s).map(Math.trunc), MFTime: numList,
  MFVec2f: (s) => chunk(numList(s), 2), MFVec3f: (s) => chunk(numList(s), 3), MFColor: (s) => chunk(numList(s), 3),
  MFColorRGBA: (s) => chunk(numList(s), 4), MFRotation: (s) => chunk(numList(s), 4), MFString: mfString,
};
const IO = 'io', IN = 'in', OUT = 'out', INIT = 'init';
const LIGHT = { on: ['SFBool', IO, true], color: ['SFColor', IO, [1, 1, 1]], intensity: ['SFFloat', IO, 1], ambientIntensity: ['SFFloat', IO, 0],
                global: ['SFBool', IO, false], shadows: ['SFBool', IO, false], shadowIntensity: ['SFFloat', IO, 1] };
const GROUP = { children: ['MFNode', IO, []], visible: ['SFBool', IO, true] };
const interp = (t) => ({ key: ['MFFloat', IO, []], keyValue: ['MF' + t, IO, []], set_fraction: ['SFFloat', IN, 0], value_changed: ['SF' + t, OUT, null] });
const solid = { solid: ['SFBool', INIT, true] };
const geomNodes = { coord: ['SFNode', IO, null], normal: ['SFNode', IO, null], color: ['SFNode', IO, null], texCoord: ['SFNode', IO, null], attrib: ['MFNode', IO, []],
                    ccw: ['SFBool', INIT, true], colorPerVertex: ['SFBool', INIT, true], normalPerVertex: ['SFBool', INIT, true], ...solid };
const emitter = { position: ['SFVec3f', IO, [0, 0, 0]], direction: ['SFVec3f', IO, [0, 1, 0]], speed: ['SFFloat', IO, 0], variation: ['SFFloat', IO, 0.25],
                  mass: ['SFFloat', IO, 0], surfaceArea: ['SFFloat', IO, 0], on: ['SFBool', IO, true] };
const DEFS = {
  GaussianSplats: { positions: ['MFVec3f', IO, []], scales: ['MFVec3f', IO, []], orientations: ['MFRotation', IO, []], opacities: ['MFFloat', IO, []],
                    sphericalHarmonicsDegree0Coef0: ['MFColor', IO, []], visible: ['SFBool', IO, true], bboxCenter: ['SFVec3f', INIT, [0, 0, 0]], bboxSize: ['SFVec3f', INIT, [-1, -1, -1]] },
  WorldInfo: { title: ['SFString', IO, ''], info: ['MFString', IO, []] },
  NavigationInfo: { type: ['MFString', IO, ['EXAMINE', 'ANY']], headlight: ['SFBool', IO, true], speed: ['SFFloat', IO, 1], set_bind: ['SFBool', IN, false],
                    transitionType: ['MFString', IO, ['LINEAR']], transitionTime: ['SFTime', IO, 1], visibilityLimit: ['SFFloat', IO, 0],
                    avatarSize: ['MFFloat', IO, [0.25, 1.6, 0.75]], isBound: ['SFBool', OUT, false], bindTime: ['SFTime', OUT, 0] },
  Viewpoint: { position: ['SFVec3f', IO, [0, 0, 10]], orientation: ['SFRotation', IO, [0, 0, 1, 0]], fieldOfView: ['SFFloat', IO, 0.7854],
               centerOfRotation: ['SFVec3f', IO, [0, 0, 0]], description: ['SFString', IO, ''], set_bind: ['SFBool', IN, false], jump: ['SFBool', IO, true],
               retainUserOffsets: ['SFBool', IO, false], nearDistance: ['SFFloat', IO, -1], farDistance: ['SFFloat', IO, -1],
               isBound: ['SFBool', OUT, false], bindTime: ['SFTime', OUT, 0] },
  Background: { skyColor: ['MFColor', IO, [[0, 0, 0]]], skyAngle: ['MFFloat', IO, []], groundColor: ['MFColor', IO, []], groundAngle: ['MFFloat', IO, []],
                transparency: ['SFFloat', IO, 0], set_bind: ['SFBool', IN, false] },
  Fog: { color: ['SFColor', IO, [1, 1, 1]], fogType: ['SFString', IO, 'LINEAR'], visibilityRange: ['SFFloat', IO, 0], set_bind: ['SFBool', IN, false] },
  DirectionalLight: { ...LIGHT, direction: ['SFVec3f', IO, [0, 0, -1]] },
  PointLight: { ...LIGHT, global: ['SFBool', IO, true], location: ['SFVec3f', IO, [0, 0, 0]], radius: ['SFFloat', IO, 100], attenuation: ['SFVec3f', IO, [1, 0, 0]] },
  SpotLight: { ...LIGHT, global: ['SFBool', IO, true], location: ['SFVec3f', IO, [0, 0, 0]], direction: ['SFVec3f', IO, [0, 0, -1]], radius: ['SFFloat', IO, 100],
               attenuation: ['SFVec3f', IO, [1, 0, 0]], beamWidth: ['SFFloat', IO, 0.589049], cutOffAngle: ['SFFloat', IO, 1.570796] },
  Transform: { ...GROUP, translation: ['SFVec3f', IO, [0, 0, 0]], rotation: ['SFRotation', IO, [0, 0, 1, 0]], scale: ['SFVec3f', IO, [1, 1, 1]],
               scaleOrientation: ['SFRotation', IO, [0, 0, 1, 0]], center: ['SFVec3f', IO, [0, 0, 0]] },
  Group: { ...GROUP },
  Switch: { ...GROUP, whichChoice: ['SFInt32', IO, -1] },
  Billboard: { ...GROUP, axisOfRotation: ['SFVec3f', IO, [0, 1, 0]] },
  Shape: { appearance: ['SFNode', IO, null], geometry: ['SFNode', IO, null], castShadow: ['SFBool', IO, true], visible: ['SFBool', IO, true] },
  Appearance: { material: ['SFNode', IO, null], shaders: ['MFNode', IO, []], blendMode: ['SFNode', IO, null], depthMode: ['SFNode', IO, null] },
  ComposedShader: { language: ['SFString', INIT, ''], parts: ['MFNode', IO, []], activate: ['SFBool', IN, false], isSelected: ['SFBool', OUT, false], isValid: ['SFBool', OUT, false] },
  ShaderPart: { url: ['MFString', IO, []], type: ['SFString', INIT, 'VERTEX'] },
  BlendMode: { blendColor: ['SFColorRGBA', IO, [0, 0, 0, 0]], sourceColorFactor: ['SFString', IO, 'SRC_ALPHA'], sourceAlphaFactor: ['SFString', IO, 'ONE'],
               destinationColorFactor: ['SFString', IO, 'ONE_MINUS_SRC_ALPHA'], destinationAlphaFactor: ['SFString', IO, 'ONE_MINUS_SRC_ALPHA'],
               colorEquation: ['SFString', IO, 'FUNC_ADD'], alphaEquation: ['SFString', IO, 'FUNC_ADD'] },
  DepthMode: { polygonOffset: ['SFVec2f', IO, [0, 0]], depthRange: ['SFVec2f', IO, [0, 1]], depthTest: ['SFBool', IO, true], depthFunction: ['SFString', IO, 'LESS_EQUAL'],
               depthMask: ['SFBool', IO, true] },
  Material: { diffuseColor: ['SFColor', IO, [0.8, 0.8, 0.8]], specularColor: ['SFColor', IO, [0, 0, 0]], emissiveColor: ['SFColor', IO, [0, 0, 0]],
              shininess: ['SFFloat', IO, 0.2], ambientIntensity: ['SFFloat', IO, 0.2], transparency: ['SFFloat', IO, 0] },
  PhysicalMaterial: { baseColor: ['SFColor', IO, [1, 1, 1]], metallic: ['SFFloat', IO, 1], roughness: ['SFFloat', IO, 1], emissiveColor: ['SFColor', IO, [0, 0, 0]],
                      occlusionStrength: ['SFFloat', IO, 1], transparency: ['SFFloat', IO, 0] },
  UnlitMaterial: { emissiveColor: ['SFColor', IO, [1, 1, 1]], transparency: ['SFFloat', IO, 0] },
  Box: { size: ['SFVec3f', INIT, [2, 2, 2]], ...solid },
  Sphere: { radius: ['SFFloat', INIT, 1], ...solid },
  Cylinder: { radius: ['SFFloat', INIT, 1], height: ['SFFloat', INIT, 2], top: ['SFBool', IO, true], bottom: ['SFBool', IO, true], side: ['SFBool', IO, true], ...solid },
  Cone: { bottomRadius: ['SFFloat', INIT, 1], height: ['SFFloat', INIT, 2], side: ['SFBool', IO, true], bottom: ['SFBool', IO, true], ...solid },
  Coordinate: { point: ['MFVec3f', IO, []] },
  Normal: { vector: ['MFVec3f', IO, []] },
  FloatVertexAttribute: { name: ['SFString', INIT, ''], numComponents: ['SFInt32', INIT, 4], value: ['MFFloat', IO, []] },
  IndexedTriangleSet: { ...geomNodes, index: ['MFInt32', INIT, []], set_index: ['MFInt32', IN, []] },
  TriangleStripSet: { ...geomNodes, stripCount: ['MFInt32', IO, []] },
  IndexedFaceSet: { ...geomNodes, coordIndex: ['MFInt32', INIT, []], normalIndex: ['MFInt32', INIT, []], colorIndex: ['MFInt32', INIT, []], texCoordIndex: ['MFInt32', INIT, []],
                    convex: ['SFBool', INIT, true], creaseAngle: ['SFFloat', INIT, 0], set_coordIndex: ['MFInt32', IN, []] },
  TimeSensor: { cycleInterval: ['SFTime', IO, 1], enabled: ['SFBool', IO, true], loop: ['SFBool', IO, false], startTime: ['SFTime', IO, 0], stopTime: ['SFTime', IO, 0],
                pauseTime: ['SFTime', IO, 0], resumeTime: ['SFTime', IO, 0], description: ['SFString', IO, ''],
                fraction_changed: ['SFFloat', OUT, 0], time: ['SFTime', OUT, 0], cycleTime: ['SFTime', OUT, 0], isActive: ['SFBool', OUT, false],
                elapsedTime: ['SFTime', OUT, 0], isPaused: ['SFBool', OUT, false] },
  TouchSensor: { enabled: ['SFBool', IO, true], description: ['SFString', IO, ''], touchTime: ['SFTime', OUT, 0], isActive: ['SFBool', OUT, false],
                 isOver: ['SFBool', OUT, false], hitPoint_changed: ['SFVec3f', OUT, [0, 0, 0]], hitNormal_changed: ['SFVec3f', OUT, [0, 0, 1]] },
  IntegerSequencer: interp('Int32'),
  ScalarInterpolator: interp('Float'), PositionInterpolator: interp('Vec3f'), OrientationInterpolator: interp('Rotation'), ColorInterpolator: interp('Color'),
  ParticleSystem: { enabled: ['SFBool', IO, true], createParticles: ['SFBool', IO, true], geometryType: ['SFString', INIT, 'QUAD'], maxParticles: ['SFInt32', IO, 200],
                    particleLifetime: ['SFFloat', IO, 5], lifetimeVariation: ['SFFloat', IO, 0.25], particleSize: ['SFVec2f', IO, [0.02, 0.02]],
                    colorKey: ['MFFloat', INIT, []], color: ['SFNode', INIT, null], emitter: ['SFNode', INIT, null], physics: ['MFNode', INIT, []],
                    appearance: ['SFNode', IO, null], geometry: ['SFNode', IO, null], castShadow: ['SFBool', IO, true], visible: ['SFBool', IO, true],
                    isActive: ['SFBool', OUT, false] },
  PointEmitter: { ...emitter },
  ConeEmitter: { ...emitter, angle: ['SFFloat', IO, 0.7854] },
  ForcePhysicsModel: { force: ['SFVec3f', IO, [0, -9.8, 0]], enabled: ['SFBool', IO, true] },
  WindPhysicsModel: { direction: ['SFVec3f', IO, [1, 0, 0]], speed: ['SFFloat', IO, 0.1], gustiness: ['SFFloat', IO, 0.1], turbulence: ['SFFloat', IO, 0], enabled: ['SFBool', IO, true] },
  Color: { color: ['MFColor', IO, []] },
  ColorRGBA: { color: ['MFColorRGBA', IO, []] },
};
const CONTAINER = { Appearance: 'appearance', Material: 'material', PhysicalMaterial: 'material', UnlitMaterial: 'material',
  Box: 'geometry', Sphere: 'geometry', Cylinder: 'geometry', Cone: 'geometry', IndexedTriangleSet: 'geometry', TriangleStripSet: 'geometry', IndexedFaceSet: 'geometry',
  Color: 'color', ColorRGBA: 'color', Coordinate: 'coord', Normal: 'normal', FloatVertexAttribute: 'attrib',
  ComposedShader: 'shaders', ShaderPart: 'parts', BlendMode: 'blendMode', DepthMode: 'depthMode',
  PointEmitter: 'emitter', ConeEmitter: 'emitter', ForcePhysicsModel: 'physics', WindPhysicsModel: 'physics', BoundedPhysicsModel: 'physics' };
// big arrays stay flat typed arrays (a 9,000-track event has about 400,000 vertices)
const FLAT = { 'GaussianSplats.positions': Float32Array, 'GaussianSplats.scales': Float32Array, 'GaussianSplats.orientations': Float32Array, 'GaussianSplats.opacities': Float32Array, 'GaussianSplats.sphericalHarmonicsDegree0Coef0': Float32Array,
  'Coordinate.point': Float32Array, 'TextureCoordinate.point': Float32Array, 'Color.color': Float32Array, 'IndexedLineSet.coordIndex': Int32Array, 'Normal.vector': Float32Array, 'FloatVertexAttribute.value': Float32Array, 'IndexedTriangleSet.index': Int32Array,
  'IndexedFaceSet.coordIndex': Int32Array, 'IndexedFaceSet.normalIndex': Int32Array, 'TriangleStripSet.stripCount': Int32Array };
function flatNums(s, T) { const t = String(s).trim(); if (!t) return new T(0); const parts = t.split(/[\s,]+/), a = new T(parts.length); for (let i = 0; i < parts.length; i++) a[i] = +parts[i] || 0; return a; }
const ACCESS = { initializeOnly: INIT, inputOnly: IN, outputOnly: OUT, inputOutput: IO };
const fdefsOf = (n) => n.fdefs || DEFS[n.type];
const fieldType = (n, f) => (fdefsOf(n)[f] || ['SFString'])[0];
const INTERPOLATORS = new Set(['IntegerSequencer', 'ScalarInterpolator', 'PositionInterpolator', 'OrientationInterpolator', 'ColorInterpolator']);
const SKIP_ATTR = new Set(['DEF', 'USE', 'containerField', 'class', 'id', 'style']);
const clone = (v) => (Array.isArray(v) ? v.map(clone) : v);

function parseX3D(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const perr = doc.getElementsByTagName('parsererror')[0];
  if (perr) throw new Error('The XML does not parse: ' + perr.textContent.replace(/\s+/g, ' ').trim().slice(0, 220));
  const root = doc.documentElement;
  if (root.nodeName !== 'X3D') throw new Error('The root element is <' + root.nodeName + '>, not <X3D>.');
  const sceneEl = [...root.children].find((e) => e.nodeName === 'Scene');
  if (!sceneEl) throw new Error('There is no <Scene> element.');
  const ctx = { defs: new Map(), nodes: [], routeEls: [], warnings: [], skipped: new Map() };
  const children = [];
  for (const el of sceneEl.children) { const r = parseNode(el, ctx); if (r) children.push(r.node); }
  const routes = [];
  for (const el of ctx.routeEls) {
    const fn = el.getAttribute('fromNode'), ff = el.getAttribute('fromField'), tn = el.getAttribute('toNode'), tf = el.getAttribute('toField');
    const label = `${fn}.${ff} → ${tn}.${tf}`;
    const a = ctx.defs.get(fn), b = ctx.defs.get(tn);
    if (!a || !b) { ctx.warnings.push(`ROUTE ${label}: no node named ${!a ? fn : tn}.`); continue; }
    const from = resolveField(a, ff, 'out'), to = resolveField(b, tf, 'in');
    if (!from || !to) { ctx.warnings.push(`ROUTE ${label}: ${!from ? a.type + ' has no output ' + ff : b.type + ' has no input ' + tf}.`); continue; }
    const ta = fieldType(a, from), tb = fieldType(b, to);
    if (ta !== tb) { ctx.warnings.push(`ROUTE ${label}: ${ta} cannot feed ${tb}.`); continue; }
    const r = { from: a, fromField: from, to: b, toField: to, label, discrete: /^(SFBool|SFTime|SFInt32|SFString)$/.test(ta) };
    (a.out ||= {})[from] ||= [];
    a.out[from].push(r);
    routes.push(r);
  }
  for (const [k, n] of ctx.skipped) ctx.warnings.push(`${n} × <${k}> is not supported by this small runtime and was skipped.`);
  return { children, nodes: ctx.nodes, defs: ctx.defs, routes, warnings: ctx.warnings };
}
function resolveField(node, name, dir) {
  const fields = fdefsOf(node);
  const f = fields[name];
  if (f && (f[1] === IO || f[1] === (dir === 'out' ? OUT : IN))) return name;
  if (dir === 'out' && name.endsWith('_changed')) { const b = name.slice(0, -8); if (fields[b] && fields[b][1] === IO) return b; }
  if (dir === 'in' && name.startsWith('set_')) { const b = name.slice(4); if (fields[b] && fields[b][1] === IO) return b; }
  return null;
}
function parseNode(el, ctx) {
  const tag = el.nodeName;
  if (tag === 'ROUTE') { ctx.routeEls.push(el); return null; }
  const use = el.getAttribute('USE');
  if (use) {
    const n = ctx.defs.get(use);
    if (!n) { ctx.warnings.push(`USE='${use}' comes before any DEF='${use}'.`); return null; }
    return { node: n, field: el.getAttribute('containerField') || CONTAINER[n.type] || 'children' };
  }
  const def = Object.hasOwn(DEFS, tag) ? DEFS[tag] : null;
  if (!def) { if (!/^(IS|connect|field|fieldValue|meta|head|component|unit)$/.test(tag)) ctx.skipped.set(tag, (ctx.skipped.get(tag) || 0) + 1); return null; }
  const node = { type: tag, def: el.getAttribute('DEF') || null, f: {}, id: R.allocNodeId(), out: null };
  for (const [name, [type, , dflt]] of Object.entries(def)) node.f[name] = type === 'MFNode' ? [] : clone(dflt);
  for (const a of el.attributes) {
    if (SKIP_ATTR.has(a.name) || a.name.includes(':')) continue;
    const fd = Object.hasOwn(def, a.name) ? def[a.name] : null;
    if (!fd || fd[1] === OUT || fd[1] === IN) { ctx.warnings.push(`<${tag}> has no field ${a.name}; ignored.`); continue; }
    const flat = FLAT[tag + '.' + a.name];
    node.f[a.name] = flat ? flatNums(a.value, flat) : PARSE[fd[0]] ? PARSE[fd[0]](a.value) : a.value;
  }
  if (tag === 'ComposedShader') { // author-defined fields (u_phase and friends) join this node's own field table
    node.fdefs = { ...def };
    for (const c of el.children) {
      if (c.nodeName !== 'field') continue;
      const name = c.getAttribute('name'), type = c.getAttribute('type'), acc = ACCESS[c.getAttribute('accessType')];
      if (!name || !type || !acc || /Node$/.test(type) || !PARSE[type]) { ctx.warnings.push(`ComposedShader ${node.def || ''}: field ${name || '?'} (${type}) is not supported here; ignored.`); continue; }
      node.fdefs[name] = [type, acc, null];
      const v = c.getAttribute('value');
      node.f[name] = v != null ? PARSE[type](v) : PARSE[type](type.startsWith('MF') ? '' : type === 'SFBool' ? 'false' : '0');
    }
  }
  if (tag === 'ShaderPart' && !node.f.url.length && el.textContent.trim()) node.f.url = [el.textContent];
  if (node.def) ctx.defs.set(node.def, node);
  ctx.nodes.push(node);
  for (const c of el.children) {
    const r = parseNode(c, ctx);
    if (!r) continue;
    let fld = r.field;
    if (tag === 'ParticleSystem' && fld === 'colorRamp') fld = 'color'; // the X3D 3 name for the same field
    if (tag === 'Switch' && fld === 'choice') fld = 'children';        // the X3D 3 name for Switch children
    const fd = def[fld];
    if (!fd || (fd[0] !== 'MFNode' && fd[0] !== 'SFNode')) { ctx.warnings.push(`<${c.nodeName}> cannot go in ${tag}.${fld}; ignored.`); continue; }
    if (fd[0] === 'MFNode') node.f[fld].push(r.node); else node.f[fld] = r.node;
  }
  return { node, field: el.getAttribute('containerField') || CONTAINER[tag] || 'children' };
}

/* ------------------------------------------------------------ the event model
   One timestamp per frame. Each output field fires at most once per timestamp and each
   ROUTE carries at most one event per timestamp, which also breaks loops (19775-1 4.4.8.3). */
const events = {
  queue: [], firedRoutes: new Set(), firedOut: new Set(), traced: new Set(), ts: 0, count: 0, onLog: null,
  begin(ts) { this.ts = ts; this.firedRoutes.clear(); this.firedOut.clear(); this.traced.clear(); this.count = 0; },
  emit(node, field, value) {
    if (node._disposed) return;
    const key = node.id + '.' + field;
    if (this.firedOut.has(key)) return;
    this.firedOut.add(key);
    const rs = node.out && node.out[field];
    if (!rs) return;
    for (const r of rs) { if (this.firedRoutes.has(r)) continue; this.firedRoutes.add(r); this.queue.push(r, value); }
  },
  drain() {
    let guard = 0;
    while (this.queue.length && guard++ < 100000) {
      const r = this.queue.shift(), v = this.queue.shift();
      this.count++;
      // the log follows a cascade that a discrete event (a touch, a start time) set off in this timestamp
      if ((r.discrete || this.traced.has(r.from.id)) && this.onLog) { this.traced.add(r.to.id); this.onLog(r.label, v, fieldType(r.from, r.fromField)); }
      receive(r.to, r.toField, v);
    }
  },
};
function receive(node, field, value) {
  if (node._disposed) return;
  if (field === 'set_bind') { if (node.type === 'Viewpoint' && R.hooks.bind) R.hooks.bind(node, !!value); return; } // other bindables keep the first one
  if (field === 'set_fraction' && INTERPOLATORS.has(node.type)) {
    const out = interpolate(node, value);
    if (out != null) { node.f.value_changed = out; events.emit(node, 'value_changed', out); }
    return;
  }
  if (node.type === 'TimeSensor' && node.state && node.state.active) {
    if (field === 'startTime' || field === 'cycleInterval') return;               // ignored while active
    if (field === 'stopTime' && value <= node.f.startTime) return;
  }
  node.f[field] = clone(value);
  node.version = (node.version || 0) + 1;
  if (R.hooks.changed) R.hooks.changed(node, field);
  events.emit(node, field, value);
}
function rgb2hsv([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0;
  if (d > 0) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h /= 6; if (h < 0) h += 1; }
  return [h, mx > 0 ? d / mx : 0, mx];
}
function hsv2rgb([h, s, v]) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) { case 0: return [v, t, p]; case 1: return [q, v, p]; case 2: return [p, v, t]; case 3: return [p, q, v]; case 4: return [t, p, v]; default: return [v, p, q]; }
}
function hsvLerp(a, b, s) { // ColorInterpolator interpolates in HSV space (19775-1 19.4.2)
  const A = rgb2hsv(a), B = rgb2hsv(b);
  if (A[1] === 0) A[0] = B[0];
  if (B[1] === 0) B[0] = A[0];
  let dh = B[0] - A[0]; if (dh > 0.5) dh -= 1; if (dh < -0.5) dh += 1;
  let h = A[0] + dh * s; h -= Math.floor(h);
  return hsv2rgb([h, A[1] + (B[1] - A[1]) * s, A[2] + (B[2] - A[2]) * s]);
}
function interpolate(n, frac) {
  const k = n.f.key, kv = n.f.keyValue, N = Math.min(k.length, kv.length);
  if (!N) return null;
  let i = 0, j = 0, s = 0;
  if (frac <= k[0]) i = j = 0;
  else if (frac >= k[N - 1]) i = j = N - 1;
  else { while (i < N - 1 && frac >= k[i + 1]) i++; j = Math.min(i + 1, N - 1); const span = k[j] - k[i]; s = span > 0 ? (frac - k[i]) / span : 0; }
  const a = kv[i], b = kv[j];
  if (n.type === 'IntegerSequencer') return kv[frac >= k[N - 1] ? N - 1 : Math.max(0, i)];   // a sequencer steps: the value of the last key at or before the fraction
  switch (n.type) {
    case 'ScalarInterpolator': return a + (b - a) * s;
    case 'PositionInterpolator': return [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * s);
    case 'ColorInterpolator': return hsvLerp(a, b, s);
    case 'OrientationInterpolator': return quat.toAxisAngle(quat.slerp(quat.fromAxisAngle(a, a[3]), quat.fromAxisAngle(b, b[3]), s));
  }
  return null;
}
function tickTimeSensor(n, now) {
  const f = n.f, st = n.state || (n.state = { active: false, cycle: -1 });
  const ci = f.cycleInterval > 0 ? f.cycleInterval : 1;
  const stopValid = f.stopTime > f.startTime;
  if (!f.enabled) { if (st.active) { st.active = false; f.isActive = false; events.emit(n, 'isActive', false); } return; }
  if (!st.active) {
    if (now >= f.startTime && !(stopValid && now >= f.stopTime) && (f.loop || now < f.startTime + ci)) {
      st.active = true; f.isActive = true; events.emit(n, 'isActive', true);
      st.cycle = Math.floor((now - f.startTime) / ci);
      f.cycleTime = now; events.emit(n, 'cycleTime', now);
    } else return;
  }
  const elapsed = now - f.startTime;
  let frac, ending = false;
  if (stopValid && now >= f.stopTime) { ending = true; const e = f.stopTime - f.startTime, k = e / ci; frac = k - Math.floor(k); if (frac === 0 && e > 0) frac = 1; }
  else if (!f.loop && elapsed >= ci) { ending = true; frac = 1; }
  else {
    const k = elapsed / ci; frac = k - Math.floor(k); if (frac === 0 && elapsed > 0) frac = 1;
    const c = Math.floor(k); if (c !== st.cycle) { st.cycle = c; f.cycleTime = now; events.emit(n, 'cycleTime', now); }
  }
  f.fraction_changed = frac; events.emit(n, 'fraction_changed', frac);
  f.time = now; events.emit(n, 'time', now);
  f.elapsedTime = elapsed; events.emit(n, 'elapsedTime', elapsed);
  if (ending) { st.active = false; f.isActive = false; events.emit(n, 'isActive', false); }
}

/* --------------------------------------------------------------- geometry */

/* ---- nodes added for the brain and torso scenes ---- */
const TEXNODE = { url: ['MFString', IO, []], repeatS: ['SFBool', INIT, true], repeatT: ['SFBool', INIT, true] };
Object.assign(DEFS, {
  ImageTexture: { ...TEXNODE },
  TextureCoordinate: { point: ['MFVec2f', IO, []] },
  IndexedLineSet: { coord: ['SFNode', IO, null], color: ['SFNode', IO, null], coordIndex: ['MFInt32', INIT, []], colorPerVertex: ['SFBool', INIT, true] },
  LineProperties: { applied: ['SFBool', IO, true], linetype: ['SFInt32', IO, 1], linewidthScaleFactor: ['SFFloat', IO, 0] },
  ClipPlane: { enabled: ['SFBool', IO, true], plane: ['SFVec4f', IO, [0, 1, 0, 0]] },
  ComposedCubeMapTexture: { frontTexture: ['SFNode', IO, null], backTexture: ['SFNode', IO, null], leftTexture: ['SFNode', IO, null], rightTexture: ['SFNode', IO, null],
                            topTexture: ['SFNode', IO, null], bottomTexture: ['SFNode', IO, null] },
  EnvironmentLight: { intensity: ['SFFloat', IO, 1], color: ['SFColor', IO, [1, 1, 1]], on: ['SFBool', IO, true], diffuseTexture: ['SFNode', IO, null],
                      specularTexture: ['SFNode', IO, null], diffuseCoefficients: ['MFFloat', IO, []], rotation: ['SFRotation', IO, [0, 0, 1, 0]], global: ['SFBool', IO, false] },
  Text: { string: ['MFString', IO, []], fontStyle: ['SFNode', IO, null], maxExtent: ['SFFloat', IO, 0], length: ['MFFloat', IO, []], solid: ['SFBool', INIT, false] },
  FontStyle: { family: ['MFString', IO, ['SERIF']], size: ['SFFloat', IO, 1], spacing: ['SFFloat', IO, 1], style: ['SFString', IO, 'PLAIN'], justify: ['MFString', IO, ['BEGIN']],
               horizontal: ['SFBool', INIT, true] },
  Sound: { intensity: ['SFFloat', IO, 1], source: ['SFNode', IO, null], location: ['SFVec3f', IO, [0, 0, 0]], spatialize: ['SFBool', INIT, true], priority: ['SFFloat', IO, 0],
           minFront: ['SFFloat', IO, 1], minBack: ['SFFloat', IO, 1], maxFront: ['SFFloat', IO, 10], maxBack: ['SFFloat', IO, 10], direction: ['SFVec3f', IO, [0, 0, 1]] },
  AudioClip: { url: ['MFString', IO, []], loop: ['SFBool', IO, false], startTime: ['SFTime', IO, 0], stopTime: ['SFTime', IO, 0], pitch: ['SFFloat', IO, 1],
               description: ['SFString', IO, ''], isActive: ['SFBool', OUT, false] },
  MetadataString: { name: ['SFString', IO, ''], value: ['MFString', IO, []] },
});
Object.assign(DEFS.PhysicalMaterial, { baseTexture: ['SFNode', IO, null], emissiveTexture: ['SFNode', IO, null], normalTexture: ['SFNode', IO, null],
  metallicRoughnessTexture: ['SFNode', IO, null], occlusionTexture: ['SFNode', IO, null] });
Object.assign(DEFS.Appearance, { texture: ['SFNode', IO, null], lineProperties: ['SFNode', IO, null], textureTransform: ['SFNode', IO, null] });
Object.assign(DEFS.IndexedTriangleSet, { texCoord: ['SFNode', IO, null] });
Object.assign(DEFS.IndexedFaceSet, { texCoord: ['SFNode', IO, null] });
Object.assign(CONTAINER, { ImageTexture: 'texture', TextureCoordinate: 'texCoord', IndexedLineSet: 'geometry', Text: 'geometry', LineProperties: 'lineProperties', FontStyle: 'fontStyle',
  AudioClip: 'source', ComposedCubeMapTexture: 'specularTexture', MetadataString: 'metadata' });
for (const t of ['Appearance','Shape','Group','Switch','Transform','Billboard','Viewpoint','NavigationInfo','Material','PhysicalMaterial']) DEFS[t].metadata = ['SFNode', IO, null];
Object.assign(DEFS.Shape, {});
const R_NOTE = new Set(['MetadataString']);

R.FLAT = FLAT; R.DEFS = DEFS; R.parseX3D = parseX3D; R.events = events; R.receive = receive; R.tickTimeSensor = tickTimeSensor; R.fieldType = fieldType; R.fdefsOf = fdefsOf; R.clone = clone;
R.v3 = v3; R.quat = quat; R.clamp = clamp; R.INTERPOLATORS = INTERPOLATORS; R.mfString = mfString; R.PARSE = PARSE; R.CONTAINER = CONTAINER;
R.resolveField = resolveField; R.FLAT = FLAT;
