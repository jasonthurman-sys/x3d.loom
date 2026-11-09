/* KANSEI on Babylon WebGPU: what the brain port's reader and body did not have.
   Loaded after body-cam.js and before sai.js. It adds to R.DEFS (reader tables) and patches Body.prototype; the brain page does not load it.
   Added: ElevationGrid (read as an IndexedTriangleSet), TextureProperties / TextureTransform, Background cube skybox, linear Fog, sun shadows,
   SpotLight / PointLight, UnlitMaterial, ColorRGBA vertex colours with alpha, PhysicalMaterial emissive and normal textures, and ParticleSystem
   (sprites and stretched lines through Babylon's own particle system). The page's engine/*.js and main.js are not touched. */

/* ------------------------------------------------------------------ reader tables */
Object.assign(R.DEFS, {
  TextureProperties: { anisotropicDegree: ['SFFloat', IO, 1], generateMipMaps: ['SFBool', IO, true], boundaryModeS: ['SFString', IO, 'REPEAT'], boundaryModeT: ['SFString', IO, 'REPEAT'],
                       minificationFilter: ['SFString', IO, 'FASTEST'], magnificationFilter: ['SFString', IO, 'FASTEST'] },
  TextureTransform: { translation: ['SFVec2f', IO, [0, 0]], rotation: ['SFFloat', IO, 0], scale: ['SFVec2f', IO, [1, 1]], center: ['SFVec2f', IO, [0, 0]] },
  ElevationGrid: { xDimension: ['SFInt32', INIT, 0], zDimension: ['SFInt32', INIT, 0], xSpacing: ['SFFloat', INIT, 1], zSpacing: ['SFFloat', INIT, 1], height: ['MFFloat', INIT, []],
                   creaseAngle: ['SFFloat', INIT, 0], solid: ['SFBool', INIT, true], ccw: ['SFBool', INIT, true], texCoord: ['SFNode', IO, null], color: ['SFNode', IO, null], normal: ['SFNode', IO, null] },
  PolylineEmitter: { ...{ position: ['SFVec3f', IO, [0, 0, 0]], direction: ['SFVec3f', IO, [0, 1, 0]], speed: ['SFFloat', IO, 0], variation: ['SFFloat', IO, 0.25], mass: ['SFFloat', IO, 0],
                        surfaceArea: ['SFFloat', IO, 0], on: ['SFBool', IO, true] }, coord: ['SFNode', IO, null], coordIndex: ['MFInt32', INIT, []] },
  MetadataSet: { name: ['SFString', IO, ''], reference: ['SFString', IO, ''], value: ['MFNode', IO, []] },
  MetadataDouble: { name: ['SFString', IO, ''], value: ['MFFloat', IO, []] },
  MetadataInteger: { name: ['SFString', IO, ''], value: ['MFInt32', IO, []] },
});
Object.assign(R.DEFS.Background, { frontUrl: ['MFString', IO, []], backUrl: ['MFString', IO, []], leftUrl: ['MFString', IO, []], rightUrl: ['MFString', IO, []],
                                    topUrl: ['MFString', IO, []], bottomUrl: ['MFString', IO, []] });
Object.assign(R.DEFS.Appearance, { alphaMode: ['SFString', IO, 'AUTO'], alphaCutoff: ['SFFloat', IO, 0.5] });
Object.assign(R.DEFS.ImageTexture, { textureProperties: ['SFNode', IO, null] });
Object.assign(R.DEFS.WorldInfo, { metadata: ['SFNode', IO, null] });
Object.assign(R.DEFS.PhysicalMaterial, { normalScale: ['SFFloat', IO, 1] });
Object.assign(R.DEFS.UnlitMaterial, { emissiveTexture: ['SFNode', IO, null] });
Object.assign(R.CONTAINER, { ElevationGrid: 'geometry', TextureProperties: 'textureProperties', TextureTransform: 'textureTransform', PolylineEmitter: 'emitter', MetadataSet: 'metadata', MetadataDouble: 'value', MetadataInteger: 'value' });

/* ElevationGrid -> IndexedTriangleSet at parse time (x runs along the first axis, z along the second; counter-clockwise seen from +Y is the front face) */
(function () {
  const parse0 = R.parseX3D;
  R.parseX3D = function (text) {
    const w = parse0(text);
    for (const n of w.nodes) {
      if (n.type !== 'ElevationGrid') continue;
      const f = n.f, xd = f.xDimension, zd = f.zDimension, P = new Float32Array(xd * zd * 3), UV = new Float32Array(xd * zd * 2);
      for (let j = 0; j < zd; j++) for (let i = 0; i < xd; i++) {
        const k = j * xd + i;
        P[k * 3] = i * f.xSpacing; P[k * 3 + 1] = f.height[k] || 0; P[k * 3 + 2] = j * f.zSpacing;
        UV[k * 2] = i / Math.max(1, xd - 1); UV[k * 2 + 1] = j / Math.max(1, zd - 1);
      }
      const idx = new Int32Array((xd - 1) * (zd - 1) * 6); let o = 0;
      for (let j = 0; j < zd - 1; j++) for (let i = 0; i < xd - 1; i++) {
        const a = j * xd + i, b = a + 1, c = a + xd, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
      const co = { type: 'Coordinate', def: null, f: { point: P }, id: R.allocNodeId(), out: null };
      const tc = { type: 'TextureCoordinate', def: null, f: { point: UV }, id: R.allocNodeId(), out: null };
      w.nodes.push(co, tc);
      n.type = 'IndexedTriangleSet';
      n.f = { coord: co, normal: null, color: f.color || null, texCoord: tc, attrib: [], ccw: true, colorPerVertex: true, normalPerVertex: true, solid: f.solid, index: idx, set_index: [] };
    }
    return w;
  };
})();

/* ------------------------------------------------------------------ body */
const DX = { shadowGen: null, bgNode: null };
const B_ = Body.prototype;
const toC3 = (c) => new BABYLON.Color3(c[0], c[1], c[2]);

/* textures: per-node base URL (cars and levels live in different folders), TextureProperties, TextureTransform from the Appearance being built */
B_.tex = function (texNode) {
  if (!texNode || !texNode.f.url || !texNode.f.url.length) return null;
  const tt = this._curTT, key = texNode.id + (tt ? 'T' + tt.id : '');
  const hit = this.texCache.get(key); if (hit) return hit;
  const urls = texNode.f.url.map((u) => this.resolve(u, texNode.base || this.baseUrl));
  const tp = texNode.f.textureProperties && texNode.f.textureProperties.f;
  const t = new BABYLON.Texture(urls[0], this.scene, !(tp && tp.generateMipMaps === false), true, BABYLON.Texture.TRILINEAR_SAMPLINGMODE, null,
    () => { if (urls.length > 1) { t._alt = (t._alt || 0) + 1; if (t._alt < urls.length) t.updateURL(urls[t._alt]); } });
  t.hasAlpha = true;
  const rs = tp ? tp.boundaryModeS !== 'CLAMP_TO_EDGE' && tp.boundaryModeS !== 'CLAMP' : texNode.f.repeatS !== false;
  const rt = tp ? tp.boundaryModeT !== 'CLAMP_TO_EDGE' && tp.boundaryModeT !== 'CLAMP' : texNode.f.repeatT !== false;
  t.wrapU = rs ? BABYLON.Texture.WRAP_ADDRESSMODE : BABYLON.Texture.CLAMP_ADDRESSMODE;
  t.wrapV = rt ? BABYLON.Texture.WRAP_ADDRESSMODE : BABYLON.Texture.CLAMP_ADDRESSMODE;
  if (tp && tp.anisotropicDegree > 1) t.anisotropicFilteringLevel = Math.min(16, tp.anisotropicDegree);
  if (tt) { const f = tt.f; t.uScale = f.scale[0]; t.vScale = f.scale[1]; t.uOffset = f.translation[0]; t.vOffset = f.translation[1]; t.wAng = f.rotation; }
  this.texCache.set(key, t);
  return t;
};

const _materialsFor = B_.materialsFor;
B_.materialsFor = function (shape, g, app) {
  const mat = app && app.f.material;
  if (mat && mat.type === 'UnlitMaterial' && g.type !== 'Text') {
    const tex = app.f.texture || mat.f.emissiveTexture;
    return [{ kind: 'xunlit', mat, tex, deps: [mat, tex].filter(Boolean) }];
  }
  return _materialsFor.call(this, shape, g, app);
};
const _makeMaterial = B_.makeMaterial;
B_.makeMaterial = function (shape, g, spec, mesh) {
  const app = shape.f.appearance; this._curTT = app && app.f.textureTransform;
  try {
    if (spec.kind === 'xunlit') {
      const m = new BABYLON.StandardMaterial('xunlit-' + shape.id, this.scene);
      m.disableLighting = true; m.backFaceCulling = g.f.solid === true; m.specularColor.set(0, 0, 0); m.disableDepthWrite = false;
      const t = this.tex(spec.tex); if (t) { m.emissiveTexture = t; m.opacityTexture = null; m.useAlphaFromDiffuseTexture = false; }
      if (this.opts.ccw !== false) m.sideOrientation = BABYLON.Material.CounterClockWiseSideOrientation;
      this.refreshUnlit(m, spec.mat, g);
      return m;
    }
    const m = _makeMaterial.call(this, shape, g, spec, mesh);
    if (spec.kind === 'pbr') {
      m.maxSimultaneousLights = 8;
      const f = spec.mat.f;
      if (f.emissiveTexture) { const e = this.tex(f.emissiveTexture); if (e) { m.emissiveTexture = e; if (!f.emissiveColor[0] && !f.emissiveColor[1] && !f.emissiveColor[2]) m.emissiveColor = new BABYLON.Color3(1, 1, 1); } }
      if (f.normalTexture) { const nt = this.tex(f.normalTexture); if (nt) { nt.hasAlpha = false; m.bumpTexture = nt; nt.level = f.normalScale * (this.opts.normalGain ?? 0.6); m.invertNormalMapY = !!this.opts.invertNormalY; m.invertNormalMapX = !!this.opts.invertNormalX; } }
      m.environmentIntensity = this.opts.pbrEnv ?? 0;
      if (this.opts.specularOff) m.specularIntensity = 0;
      m.useRadianceOverAlpha = false; m.useSpecularOverAlpha = false;
    }
    if (spec.kind === 'phong') m.maxSimultaneousLights = 8;
    if (app && (spec.kind === 'pbr' || spec.kind === 'xunlit') && (app.f.alphaMode === 'MASK' || app.f.alphaMode === 'BLEND')) {
      m._xalpha = { mode: app.f.alphaMode, cutoff: app.f.alphaCutoff };
      this.applyAlphaMode(m);
    }
    return m;
  } finally { this._curTT = null; }
};
B_.applyAlphaMode = function (m) {
  const x = m._xalpha; if (!x) return;
  if (m instanceof BABYLON.PBRMaterial) m.useAlphaFromAlbedoTexture = true; else m.useAlphaFromDiffuseTexture = true;
  if (x.mode === 'MASK') { m.transparencyMode = BABYLON.Material.MATERIAL_ALPHATEST; m.alphaCutOff = x.cutoff; m.disableDepthWrite = false; }
  else { m.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND; m.disableDepthWrite = true; m.zOffset = -2; }
};
const _refreshPBR = B_.refreshPBR;
B_.refreshPBR = function (m, mat) { _refreshPBR.call(this, m, mat); this.applyAlphaMode(m); };
B_.refreshUnlit = function (m, mat, g) {
  const e = mat.f.emissiveColor; m.emissiveColor.set(e[0], e[1], e[2]); m.diffuseColor.set(0, 0, 0);
  m.alpha = 1 - mat.f.transparency;
  if (g && g.f.color) { m.useVertexColors = false; }
  const trans = m.alpha < 0.999 || (g && g.f.color && g.f.color.type === 'ColorRGBA');
  if (trans) { m.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND; m.disableDepthWrite = true; } else m.transparencyMode = BABYLON.Material.MATERIAL_OPAQUE;
};

/* IndexedFaceSet with creaseAngle: per-corner expansion, Newell face normals, normals averaged over the faces at a vertex that lie within creaseAngle of this corner's face (19775-1 13.3.6) */
const _geometryData0 = B_.geometryData;
B_.geometryData = function (g) {
  if (g.type !== 'IndexedFaceSet' || (g.f.normal && g.f.normal.f.vector.length) || !(g.f.coord && g.f.coord.f.point.length)) return _geometryData0.call(this, g);
  const f = g.f, ver = [g, f.coord, f.color, f.texCoord].map((x) => (x ? x.version || 0 : -1)).join('.');
  const hit = this.geoCache.get(g.id);
  if (hit && hit.ver === ver) return hit;
  const P = f.coord.f.point, ci = f.coordIndex, TC = f.texCoord && f.texCoord.f.point, TI = f.texCoordIndex && f.texCoordIndex.length ? f.texCoordIndex : ci;
  const C = f.color && f.color.type === 'Color' ? f.color.f.color : null, CI = f.colorIndex && f.colorIndex.length ? f.colorIndex : ci;
  const faces = []; let cur = [];
  for (let i = 0; i < ci.length; i++) { if (ci[i] < 0) { if (cur.length >= 3) faces.push(cur); cur = []; } else cur.push([ci[i], TI[i], CI[i]]); }
  if (cur.length >= 3) faces.push(cur);
  const ccw = f.ccw !== false, fn = [];
  for (const face of faces) { // Newell
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < face.length; k++) {
      const a = face[k][0] * 3, b = face[(k + 1) % face.length][0] * 3;
      nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]); ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]); nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    const l = Math.hypot(nx, ny, nz) || 1; const s = ccw ? 1 : -1;
    fn.push([nx / l * s, ny / l * s, nz / l * s]);
  }
  const byV = new Map();
  faces.forEach((face, fi) => { for (const c of face) { let l = byV.get(c[0]); if (!l) byV.set(c[0], l = []); l.push(fi); } });
  const cosCrease = Math.cos(f.creaseAngle || 0), pos = [], nrm = [], uv = [], col = [], idx = [];
  faces.forEach((face, fi) => {
    const base = pos.length / 3, n0 = fn[fi];
    for (const c of face) {
      pos.push(P[c[0] * 3], P[c[0] * 3 + 1], P[c[0] * 3 + 2]);
      let sx = n0[0], sy = n0[1], sz = n0[2];
      if (f.creaseAngle > 0) {
        sx = sy = sz = 0;
        for (const fj of byV.get(c[0])) { const n1 = fn[fj]; if (fj === fi || n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] >= cosCrease - 1e-9) { sx += n1[0]; sy += n1[1]; sz += n1[2]; } }
        const l = Math.hypot(sx, sy, sz) || 1; sx /= l; sy /= l; sz /= l;
      }
      nrm.push(sx, sy, sz);
      if (TC) uv.push(TC[c[1] * 2], TC[c[1] * 2 + 1]);
      if (C) col.push(C[c[2] * 3], C[c[2] * 3 + 1], C[c[2] * 3 + 2]);
    }
    for (let i = 1; i + 1 < face.length; i++) { if (ccw) idx.push(base, base + i, base + i + 1); else idx.push(base, base + i + 1, base + i); }
  });
  const out = { ver, pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), idx: Uint32Array.from(idx), uv: TC ? Float32Array.from(uv) : null, col: C ? Float32Array.from(col) : null };
  this.geoCache.set(g.id, out);
  return out;
};

/* geometry: ColorRGBA with per-vertex alpha, vertex colours multiply the unlit emissive */
const _geometryData = B_.geometryData;
B_.geometryData = function (g) {
  const c = g.f.color;
  if (!c || c.type !== 'ColorRGBA') return _geometryData.call(this, g);
  const ver = [g, g.f.coord, g.f.normal, c, g.f.texCoord].map((x) => (x ? x.version || 0 : -1)).join('.');
  const hit = this.geoCache.get(g.id);
  if (hit && hit.ver === ver) return hit;
  const A = c.f.color, rgb = new Float32Array(A.length * 3), alpha = new Float32Array(A.length);
  for (let i = 0; i < A.length; i++) { rgb[i * 3] = A[i][0]; rgb[i * 3 + 1] = A[i][1]; rgb[i * 3 + 2] = A[i][2]; alpha[i] = A[i][3]; }
  const shim = { type: 'Color', version: c.version || 0, f: { color: rgb } };
  g.f.color = shim;
  let d; try { d = _geometryData.call(this, g); } finally { g.f.color = c; }
  d.colA = alpha; d.ver = ver; this.geoCache.set(g.id, d);
  return d;
};
B_.babylonGeometry = function (g, wantColor) {
  const d = this.geometryData(g);
  const key = g.id + (wantColor ? 'c' : 'n');
  const c = this.geoCache.get(key);
  if (c && c.ver === d.ver) return c.geo;
  if (c) c.geo.dispose();
  const vd = new BABYLON.VertexData();
  vd.positions = d.pos; vd.indices = d.idx;
  vd.normals = d.nrm || (() => { const n = new Float32Array(d.pos.length); BABYLON.VertexData.ComputeNormals(d.pos, d.idx, n, { useRightHandedSystem: true }); return n; })();
  if (d.uv) vd.uvs = d.uv;
  if (d.col || wantColor) {
    const nv = d.pos.length / 3, rgba = new Float32Array(nv * 4);
    for (let i = 0; i < nv; i++) { rgba[i * 4] = d.col ? d.col[i * 3] : 1; rgba[i * 4 + 1] = d.col ? d.col[i * 3 + 1] : 1; rgba[i * 4 + 2] = d.col ? d.col[i * 3 + 2] : 1; rgba[i * 4 + 3] = d.colA ? d.colA[i] : 1; }
    vd.colors = rgba;
  }
  const geo = new BABYLON.Geometry('geo-' + key, this.scene, undefined, true);
  vd.applyToGeometry(geo, false);
  this.geoCache.set(key, { ver: d.ver, geo });
  return geo;
};
/* a Shape with vertex colours: mesh.hasVertexAlpha + useVertexColors on the material */
const _makeMesh = B_.makeMesh;
B_.makeMesh = function (shape, g, spec, passIndex) {
  let mesh;
  if (g.type === 'Cone') {
    mesh = BABYLON.MeshBuilder.CreateCylinder((shape.def || 'shape') + '-cone', { diameterTop: 0, diameterBottom: g.f.bottomRadius * 2, height: g.f.height, tessellation: 24, cap: g.f.bottom ? BABYLON.Mesh.CAP_START : BABYLON.Mesh.NO_CAP }, this.scene);
    mesh.material = this.makeMaterial(shape, g, spec, mesh); mesh.alphaIndex = 0;
  } else mesh = _makeMesh.call(this, shape, g, spec, passIndex);
  if (!mesh) return mesh;
  const m = mesh.material;
  if (g.f && g.f.color && (g.type === 'IndexedTriangleSet' || g.type === 'IndexedFaceSet')) {
    if (m instanceof BABYLON.StandardMaterial && spec.kind === 'xunlit') {
      mesh.hasVertexAlpha = g.f.color.type === 'ColorRGBA';
      m.useVertexColors = true; m.emissiveColor.set(0, 0, 0); m.diffuseColor.set(0, 0, 0); m.disableLighting = true;
      // lit by nothing: the vertex colour is the colour. StandardMaterial adds vertex colour to the diffuse term, so give it a white diffuse and no lights
      m.emissiveColor.set(0, 0, 0); m.useVertexColorsAsEmissive = true;
    }
  }
  if (spec.kind === 'xunlit' && mesh.material && mesh.material.alpha < 0.999) mesh.alphaIndex = 3;
  if (g.f.solid === false && m && m.backFaceCulling !== undefined) m.backFaceCulling = false;
  mesh.renderingGroupId = 1;                        // group 0 is the sky box, drawn first
  this.shadowRegister(shape, mesh);
  return mesh;
};
B_.shadowRegister = function (shape, mesh) {
  if (spec_noShadow(mesh)) return;
  const sg = DX.shadowGen;
  mesh.receiveShadows = true;                       // every drawn shape takes shadows; castShadow=false keeps a shape (road, terrain, decals) out of the shadow map
  if (sg && shape.f.castShadow !== false) sg.addShadowCaster(mesh);
};
function spec_noShadow(mesh) { return !mesh || (mesh.metadata && mesh.metadata.text); }

/* geometry changed from the page (skid chunks): rebuild once per frame */
B_.geometryChanged = function (n) { (this._dirtyGeo ||= new Set()).add(n); };
const _frame = B_.frame;
B_.frame = function () {
  if (this._dirtyGeo && this._dirtyGeo.size) {
    const dirty = this._dirtyGeo; this._dirtyGeo = new Set();
    const geos = new Set();
    for (const x of this.world.nodes) {
      if (x.type !== 'IndexedTriangleSet' && x.type !== 'IndexedFaceSet' && x.type !== 'IndexedLineSet') continue;
      if (dirty.has(x) || dirty.has(x.f.color) || dirty.has(x.f.coord) || dirty.has(x.f.normal)) geos.add(x);
    }
    for (const x of geos) {
      this.geoCache.delete(x.id);
      for (const key of [x.id, x.id + 'c', x.id + 'n']) { const c = this.geoCache.get(key); if (c) { c.geo.dispose(); this.geoCache.delete(key); } }
      for (const r of [...this.rec.values()]) if (r.node && r.node.type === 'Shape' && r.node.f.geometry === x && r.tn) this.rebuildShapeIn(r);
    }
  }
  this.followShadow();
  this.followSky();
  return _frame.call(this);
};

/* ------------------------------------------------------------------ build dispatcher: lights and particles inside the scene graph */
const _build = B_.build;
B_.build = function (n, parent, chain) {
  if (n && n.type === 'SpotLight') return this.buildSpot(n, parent, chain);
  if (n && n.type === 'PointLight') return this.buildPoint(n, parent, chain);
  if (n && n.type === 'ParticleSystem') return this.buildParticles(n, parent, chain);
  return _build.call(this, n, parent, chain);
};
const _buildShape = B_.buildShape;
B_.buildShape = function (n, parent, chain) {
  const r = _buildShape.call(this, n, parent, chain);
  return r;
};
B_.buildSpot = function (n, parent, chain) {
  const f = n.f, r = { node: n, chain: [n, ...chain] };
  const l = new BABYLON.SpotLight(n.def || 'spot', new BABYLON.Vector3(f.location[0], f.location[1], f.location[2]), new BABYLON.Vector3(f.direction[0], f.direction[1], f.direction[2]),
    Math.min(3.0, f.cutOffAngle * 2), Math.max(0, Math.min(8, (1 - f.beamWidth / Math.max(f.cutOffAngle, 1e-3)) * 4)), this.scene);
  l.parent = parent; l.node = n; r.light = l; this.rec.set(n.id, r);
  this.refreshPointish(l);
  return r;
};
B_.buildPoint = function (n, parent, chain) {
  const f = n.f, r = { node: n, chain: [n, ...chain] };
  const l = new BABYLON.PointLight(n.def || 'point', new BABYLON.Vector3(f.location[0], f.location[1], f.location[2]), this.scene);
  l.parent = parent; l.node = n; r.light = l; this.rec.set(n.id, r);
  this.refreshPointish(l);
  return r;
};
B_.refreshPointish = function (l) {
  const f = l.node.f, c = f.color;
  l.diffuse = toC3(c); l.specular = toC3(c);
  l.intensity = f.intensity * (this.opts.pointScale ?? this.opts.lightScale ?? 1); l.range = f.radius || 100;
  l.setEnabled(f.on !== false);
  if (l.setDirectionToTarget) { l.position.set(f.location[0], f.location[1], f.location[2]); if (l.direction) l.direction.set(f.direction[0], f.direction[1], f.direction[2]); }
};

/* ------------------------------------------------------------------ sun, shadows, fog, sky */
const _buildLights = B_.buildLights;
B_.buildLights = function () {
  if (DX.shadowGen) { try { DX.shadowGen.dispose(); } catch (e) { /* gone with the scene */ } DX.shadowGen = null; }
  _buildLights.call(this);
  this.applyFog();
  const sun = this.lights.find((l) => l.node && l.node.f.shadows);
  if (sun && this.opts.shadows !== false) {
    const sz = this.opts.shadowMap || 2048;
    const sg = new BABYLON.ShadowGenerator(sz, sun);
    sg.usePoissonSampling = true; sg.bias = 0.0004; sg.normalBias = 0.02;
    // X_ITE darkens the whole shaded point by shadowIntensity; here only the sun is taken away, so the shadow is made fully dark for the sun's share
    sg.setDarkness(Math.max(0, 1 - 1.4 * sun.node.f.shadowIntensity));
    sun.autoUpdateExtends = false; sun.autoCalcShadowZBounds = false;
    const half = this.opts.shadowHalf || 45;
    sun.orthoLeft = -half; sun.orthoRight = half; sun.orthoTop = half; sun.orthoBottom = -half;
    sun.shadowMinZ = 1; sun.shadowMaxZ = 260;
    DX.shadowGen = sg; this.sunLight = sun;
    for (const m of this.scene.meshes) { if (m.metadata && m.metadata.shape && !m.metadata.text) { m.receiveShadows = true; if (m.metadata.shape.f.castShadow !== false) sg.addShadowCaster(m); } }
  } else this.sunLight = null;
};
B_.followShadow = function () {
  const s = this.sunLight; if (!s || !this.scene.activeCamera) return;
  const c = this.scene.activeCamera, fwd = c.getForwardRay(1).direction;
  const fx = fwd.x, fz = fwd.z, fl = Math.hypot(fx, fz) || 1;
  const reach = this.opts.shadowReach ?? 18;
  const tx = Math.round(c.position.x + fx / fl * reach), tz = Math.round(c.position.z + fz / fl * reach), ty = Math.round(c.position.y - 2);
  const d = s.direction.normalizeToNew();
  s.position.set(tx - d.x * 130, ty - d.y * 130, tz - d.z * 130);
};
B_.applyFog = function () {
  const fog = this.world && this.world.nodes.find((x) => x.type === 'Fog');
  const sc = this.scene;
  if (!fog || !(fog.f.visibilityRange > 0)) { sc.fogMode = BABYLON.Scene.FOGMODE_NONE; return; }
  sc.fogMode = fog.f.fogType === 'EXPONENTIAL' ? BABYLON.Scene.FOGMODE_EXP : BABYLON.Scene.FOGMODE_LINEAR;
  // Babylon mixes the fog colour in AFTER tone mapping and the sRGB encode; X_ITE mixes it before (in linear). Give Babylon the colour as it would come out of the tone mapper.
  const c = fog.f.color, tm = this.tone === 'aces' || this.tone === 'standard';
  const nar = (x) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14))), enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  sc.fogColor = tm ? new BABYLON.Color3(enc(nar(c[0])), enc(nar(c[1])), enc(nar(c[2]))) : toC3(c); sc.fogStart = 0; sc.fogEnd = fog.f.visibilityRange; sc.fogDensity = 2.5 / fog.f.visibilityRange;
};
const _applyBackground = B_.applyBackground;
B_.applyBackground = function () {
  _applyBackground.call(this);
  const bg = this.world.nodes.find((x) => x.type === 'Background'); if (!bg) return;
  if (this.sky) { this.sky.material.reflectionTexture.dispose(); this.sky.material.dispose(); this.sky.dispose(); this.sky = null; }
  const f = bg.f, base = bg.base || this.baseUrl, S = 256;
  const order = (this.opts.skyOrder || 'right,top,back,left,bottom,front').split(','); // +x +y +z -x -y -z: X3D front looks down -Z, back down +Z
  const url = (k) => (f[k + 'Url'] && f[k + 'Url'].length ? this.resolve(f[k + 'Url'][0], base) : null);
  const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.4) - 0.055);
  const stops = (cols, ang, from) => { const o = []; cols.forEach((c, i) => o.push([i === 0 ? 0 : ang[i - 1], c])); return o; };
  const sky = stops(f.skyColor.length ? f.skyColor : [[0, 0, 0]], f.skyAngle), gnd = f.groundColor && f.groundColor.length ? stops(f.groundColor, f.groundAngle) : null;
  const at = (st, a) => { if (a <= st[0][0]) return st[0][1]; for (let i = 1; i < st.length; i++) if (a <= st[i][0]) { const t = (a - st[i - 1][0]) / Math.max(1e-6, st[i][0] - st[i - 1][0]), A = st[i - 1][1], B = st[i][1]; return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]; } return st[st.length - 1][1]; };
  // direction of a texel on a cube face (face names as X3D sees them from inside)
  const dirOf = (face, u, v) => { const x = 2 * u - 1, y = 1 - 2 * v;
    switch (face) { case 'front': return [x, y, -1]; case 'back': return [-x, y, 1]; case 'left': return [-1, y, -x]; case 'right': return [1, y, x]; case 'top': return [x, 1, y]; default: return [x, -1, -y]; } };
  const pend = order.map((face) => new Promise((res) => {
    const c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'), im = g.createImageData(S, S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const d = dirOf(face, (i + 0.5) / S, (j + 0.5) / S), l = Math.hypot(d[0], d[1], d[2]), ang = Math.acos(Math.max(-1, Math.min(1, d[1] / l)));
      let col; if (ang <= Math.PI / 2 || !gnd) col = at(sky, ang); else { const ga = Math.PI - ang; col = at(gnd, ga); }
      const o = (j * S + i) * 4; im.data[o] = enc(col[0]) * 255; im.data[o + 1] = enc(col[1]) * 255; im.data[o + 2] = enc(col[2]) * 255; im.data[o + 3] = 255; // X3D colours are linear; the canvas holds sRGB
    }
    g.putImageData(im, 0, 0);
    const u = url(face);
    if (!u) return res(c.toDataURL('image/png'));
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { g.drawImage(img, 0, 0, S, S); res(c.toDataURL('image/png')); };
    img.onerror = () => { this.note('sky face ' + face + ' did not load'); res(c.toDataURL('image/png')); };
    img.src = u;
  }));
  Promise.all(pend).then((urls) => {
    const cube = new BABYLON.CubeTexture('', this.scene, null, true, urls, null, (e) => this.note('sky: ' + e), BABYLON.Constants.TEXTUREFORMAT_RGBA, false, '.png');
    cube.coordinatesMode = BABYLON.Texture.SKYBOX_MODE; cube.gammaSpace = true;
    const box = BABYLON.MeshBuilder.CreateBox('sky', { size: 2000 }, this.scene);
    const m = new BABYLON.StandardMaterial('skym', this.scene);
    m.backFaceCulling = false; m.disableLighting = true; m.reflectionTexture = cube; m.diffuseColor.set(0, 0, 0); m.specularColor.set(0, 0, 0); m.fogEnabled = false;
    box.material = m; box.infiniteDistance = true; box.isPickable = false; box.renderingGroupId = 0; box.alwaysSelectAsActiveMesh = true; m.disableDepthWrite = true; // the sky box is only 1 km out; ridges and ground beyond it must still draw over it
    box.applyFog = false; box.metadata = { text: true, sky: true };
    this.sky = box;
  });
};
B_.followSky = function () { /* infiniteDistance keeps it on the eye */ };

/* ------------------------------------------------------------------ changes from the page */
const _changed = B_.changed;
B_.changed = function (node, field) {
  const t = node.type;
  if (t === 'UnlitMaterial') { for (const m of this.meshesOf.get(node.id) || []) if (m.material instanceof BABYLON.StandardMaterial) this.refreshUnlit(m.material, node, m.metadata && m.metadata.shape && m.metadata.shape.f.geometry); return; }
  if (t === 'Fog') { this.applyFog(); return; }
  if (t === 'ColorRGBA' && node.f && !node.ps) { this.geometryChanged(node); this.psRampChanged(node); return; }
  if (t === 'IndexedTriangleSet' && (field === 'index' || field === 'set_index')) { this.geometryChanged(node); return; }
  if (t === 'SpotLight' || t === 'PointLight') { const r = this.rec.get(node.id); if (r && r.light) this.refreshPointish(r.light); return; }
  if (t === 'ParticleSystem') { this.psChanged(node, field); return; }
  if (t === 'PointEmitter' || t === 'ConeEmitter' || t === 'PolylineEmitter') { this.emitterChanged(node, field); return; }
  if (t === 'DirectionalLight') { _changed.call(this, node, field); return; }
  if (t === 'Coordinate' || t === 'Color' || t === 'Normal') { this.geometryChanged(node); return; }
  if (t === 'Transform' && node.f.children && node.f.children.some((c) => c.type === 'ParticleSystem')) { _changed.call(this, node, field); this.psAnchorMoved(node); return; }
  return _changed.call(this, node, field);
};

/* ------------------------------------------------------------------ particles */
B_.buildParticles = function (n, parent, chain) {
  const f = n.f, em = f.emitter, r = { node: n, chain: [n, ...chain], kids: [] };
  this.rec.set(n.id, r);
  if (!em) return r;
  const cap = Math.max(10, Math.min(5000, f.maxParticles | 0));
  const ps = new BABYLON.ParticleSystem('ps-' + (n.def || n.id), cap, this.scene);
  const anchor = new BABYLON.TransformNode('psa-' + n.id, this.scene); anchor.parent = parent;
  const emesh = new BABYLON.Mesh('pse-' + n.id, this.scene); emesh.parent = anchor; emesh.isVisible = false; emesh.isPickable = false;
  ps.emitter = emesh;
  r.ps = ps; r.emesh = emesh; r.anchor = anchor; n.ps = r; em.psOwner = n;
  const ap = f.appearance, mat = ap && ap.f.material, tex = ap && ap.f.texture;
  let url = tex && tex.f.url && tex.f.url[0];
  const stretched = f.geometryType === 'LINE' || f.geometryType === 'POINT';
  if (url) ps.particleTexture = new BABYLON.Texture(this.resolve(url, tex.base || this.baseUrl), this.scene, true, false);
  else { const dt = new BABYLON.DynamicTexture('psdot', 16, this.scene, false); const cx = dt.getContext(); cx.fillStyle = '#fff'; cx.fillRect(0, 0, 16, 16); dt.update(); ps.particleTexture = dt; }
  ps.blendMode = (mat && mat.f.emissiveColor && f.geometryType === 'LINE' && !url) ? BABYLON.ParticleSystem.BLENDMODE_ONEONE : BABYLON.ParticleSystem.BLENDMODE_STANDARD;
  if (stretched) ps.billboardMode = BABYLON.ParticleSystem.BILLBOARDMODE_STRETCHED;
  const sz = f.particleSize; ps.minSize = ps.maxSize = 1;
  if (stretched) { ps.minScaleX = ps.maxScaleX = sz[0]; ps.minScaleY = ps.maxScaleY = sz[1]; } else { ps.minScaleX = ps.maxScaleX = sz[0]; ps.minScaleY = ps.maxScaleY = sz[1]; }
  const L = f.particleLifetime, v = f.lifetimeVariation;
  ps.minLifeTime = L * (1 - v); ps.maxLifeTime = L * (1 + v);
  ps.minEmitPower = 1; ps.maxEmitPower = 1; ps.updateSpeed = 1 / 60;
  ps.isLocal = false; ps.disposeOnStop = false;
  r.tint = mat ? mat.f.emissiveColor.slice() : [1, 1, 1];
  this.psEmitter(r); this.psPhysics(r); this.psRamp(r);
  ps.emitRate = f.createParticles ? cap / Math.max(0.05, L) : 0;
  ps.renderingGroupId = 1;
  ps.start();
  r.on = !!f.createParticles;
  return r;
};
B_.psEmitter = function (r) {
  const n = r.node, f = n.f, em = f.emitter, ps = r.ps, ef = em.f;
  r.emesh.position.set(ef.position[0], ef.position[1], ef.position[2]);
  const d = ef.direction, dl = Math.hypot(d[0], d[1], d[2]) || 1, u = [d[0] / dl, d[1] / dl, d[2] / dl], sp = ef.speed || 0, va = Math.min(1, ef.variation || 0);
  ps.minEmitPower = sp * (1 - va); ps.maxEmitPower = Math.max(sp * (1 + va), 0.0001);
  const mass = ef.mass || 1;
  if (em.type === 'ConeEmitter') {
    const ce = ps.createConeEmitter(0.02, Math.max(0.01, ef.angle));
    // Babylon's cone opens around +Y; the page uses +Y
    r.dirIsY = true;
  } else if (em.type === 'PolylineEmitter') {
    const pts = em.f.coord ? em.f.coord.f.point : [], idx = em.f.coordIndex || [];
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < pts.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pts[i + k]); mx[k] = Math.max(mx[k], pts[i + k]); }
    if (pts.length) {
      const dv = new BABYLON.Vector3(u[0], u[1], u[2]);
      ps.createBoxEmitter(dv.clone(), dv.clone(), new BABYLON.Vector3(mn[0], mn[1], mn[2]), new BABYLON.Vector3(mx[0], mx[1], mx[2]));
    }
  } else {
    const dv1 = new BABYLON.Vector3(u[0] - va, u[1] - va, u[2] - va), dv2 = new BABYLON.Vector3(u[0] + va, u[1] + va, u[2] + va);
    ps.createPointEmitter(dv1, dv2);
  }
  r.mass = mass;
};
B_.psPhysics = function (r) {
  const ps = r.ps, ph = r.node.f.physics || [];
  const g = new BABYLON.Vector3(0, 0, 0);
  for (const m of ph) if (m.type === 'ForcePhysicsModel' && m.f.enabled !== false) g.addInPlace(new BABYLON.Vector3(m.f.force[0], m.f.force[1], m.f.force[2]).scale(1 / Math.max(0.01, r.mass || 1)));
  ps.gravity = g;
};
B_.psRamp = function (r) {
  const ps = r.ps, f = r.node.f, ramp = f.color, keys = f.colorKey || [], tn = r.tint || [1, 1, 1];
  ps.removeColorGradient && (ps._colorGradients = null);
  if (!ramp || !ramp.f.color.length) { ps.color1 = new BABYLON.Color4(tn[0], tn[1], tn[2], 1); ps.color2 = ps.color1.clone(); ps.colorDead = new BABYLON.Color4(tn[0], tn[1], tn[2], 0); return; }
  ramp.ps = true;
  const cs = ramp.f.color;
  for (let i = 0; i < cs.length; i++) {
    const k = keys.length === cs.length ? keys[i] : i / Math.max(1, cs.length - 1), c = cs[i];
    ps.addColorGradient(Math.min(1, Math.max(0, k)), new BABYLON.Color4(c[0] * tn[0], c[1] * tn[1], c[2] * tn[2], c[3] ?? 1));
  }
  ramp.owner = r;
};
B_.psRampChanged = function (ramp) {
  const r = ramp.owner; if (!r) { return; }
  r.ps._colorGradients = null;
  this.psRamp(r);
  ramp.ps = false; // ColorRGBA used by a particle system is not a geometry colour
};
B_.psChanged = function (node, field) {
  const r = node.ps; if (!r) return;
  if (field === 'createParticles') { r.on = !!node.f.createParticles; r.ps.emitRate = r.on ? Math.max(10, node.f.maxParticles | 0) / Math.max(0.05, node.f.particleLifetime) : 0; }
};
B_.emitterChanged = function (em, field) {
  const ps = em.psOwner; const r = ps && ps.ps; if (!r) return;
  if (field === 'position') r.emesh.position.set(em.f.position[0], em.f.position[1], em.f.position[2]);
  else if (field === 'speed' || field === 'variation') { const sp = em.f.speed || 0, va = Math.min(1, em.f.variation || 0); r.ps.minEmitPower = sp * (1 - va); r.ps.maxEmitPower = Math.max(sp * (1 + va), 0.0001); }
};
B_.psAnchorMoved = function () {};

/* the game owns the camera: no orbit, pan, zoom or picking from the pointer */
if (!window.__keepNav) for (const k of ['orbit', 'pan', 'zoom', 'userMoved', 'queuePick', 'click']) B_[k] = function () {};   // a page that is not a game (Chirp) keeps the EXAMINE navigation

/* a far ridge sits 3 to 4 km out: the page's NavigationInfo says visibilityLimit 9000 */
const _applyCamera = B_.applyCamera;
B_.applyCamera = function () {
  _applyCamera.call(this);
  const nav = this.world && this.world.nodes.find((n) => n.type === 'NavigationInfo');
  const lim = nav && nav.f.visibilityLimit > 0 ? nav.f.visibilityLimit : 0;
  if (lim) { this.cam.maxZ = lim * 1.05; this.cam.minZ = Math.min(this.cam.minZ, 0.25); }
};
