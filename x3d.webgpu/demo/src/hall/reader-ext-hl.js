/* Additive reader nodes for the Library of PolyXandria hall (port #9). Concatenated after brain/reader.js, drift/drift-ext.js and odyssey/odyssey-ext.js in the same bundle scope, so DEFS,
   CONTAINER, FLAT, IO/IN/OUT/INIT, GROUP, INTERPOLATORS and R are visible, and `interpolate` can be wrapped (it is a function declaration of the reader).
   Eight node types are new here; nothing that parses today is changed.

     Collision                  a Group (19775-1 23.4.1); the hall's "no collision" sun shield is one with enabled FALSE
     CoordinateInterpolator     MFVec3f keyValue, MFVec3f value_changed (19775-1 19.4.3), linear
     CoordinateInterpolator2D   the same for MFVec2f (Interpolation level 3)
     MultiTextureCoordinate     a list of TextureCoordinate nodes; a texture names one with its `mapping` (X3D 4.0, 18.4.1), so the lunette patches carry two channels
     PointProperties            pointSizeScaleFactor, min, max and attenuation of a PointSet (19775-1 12.4.3)
     Disk2D, Rectangle2D        the two flat shapes of Geometry2D, turned into an IndexedFaceSet at parse time (as ElevationGrid is in drift-ext)
     Extrusion                  spine, crossSection, scale, orientation, caps, creaseAngle (19775-1 13.3.5), turned into an IndexedFaceSet at parse time

   The two geometry conversions keep the node's own DEF and place; the body sees an IndexedFaceSet and its crease-angle normals. */
(function () {
  /* ------------------------------------------------------------------ tables */
  const FLATF = Float32Array;
  Object.assign(DEFS, {
    Collision: { ...GROUP, enabled: ['SFBool', IO, true], proxy: ['SFNode', INIT, null] },
    CoordinateInterpolator: { key: ['MFFloat', IO, []], keyValue: ['MFVec3f', IO, []], set_fraction: ['SFFloat', IN, 0], value_changed: ['MFVec3f', OUT, null] },
    CoordinateInterpolator2D: { key: ['MFFloat', IO, []], keyValue: ['MFVec2f', IO, []], set_fraction: ['SFFloat', IN, 0], value_changed: ['MFVec2f', OUT, null] },
    MultiTextureCoordinate: { texCoord: ['MFNode', IO, []] },
    PointProperties: { pointSizeScaleFactor: ['SFFloat', IO, 1], pointSizeMinValue: ['SFFloat', IO, 0], pointSizeMaxValue: ['SFFloat', IO, 1], attenuation: ['SFVec3f', IO, [1, 0, 0]] },
    Disk2D: { innerRadius: ['SFFloat', INIT, 0], outerRadius: ['SFFloat', INIT, 1], ...{ solid: ['SFBool', INIT, false] } },
    Rectangle2D: { size: ['SFVec2f', INIT, [2, 2]], solid: ['SFBool', INIT, false] },
    Extrusion: { beginCap: ['SFBool', INIT, true], endCap: ['SFBool', INIT, true], ccw: ['SFBool', INIT, true], convex: ['SFBool', INIT, true], creaseAngle: ['SFFloat', INIT, 0],
                 crossSection: ['MFVec2f', INIT, [[1, 1], [1, -1], [-1, -1], [-1, 1], [1, 1]]], orientation: ['MFRotation', INIT, [[0, 0, 1, 0]]], scale: ['MFVec2f', INIT, [[1, 1]]],
                 spine: ['MFVec3f', INIT, [[0, 0, 0], [0, 1, 0]]], solid: ['SFBool', INIT, true] },
  });
  DEFS.Collision.metadata = ['SFNode', IO, null];
  Object.assign(DEFS.TextureCoordinate, { mapping: ['SFString', IO, ''] });
  Object.assign(DEFS.PhysicalMaterial, { baseTextureMapping: ['SFString', IO, ''], emissiveTextureMapping: ['SFString', IO, ''], normalTextureMapping: ['SFString', IO, ''],
    metallicRoughnessTextureMapping: ['SFString', IO, ''], occlusionTextureMapping: ['SFString', IO, ''] });
  Object.assign(DEFS.Appearance, { pointProperties: ['SFNode', IO, null] });
  Object.assign(CONTAINER, { PointProperties: 'pointProperties', Disk2D: 'geometry', Rectangle2D: 'geometry', Extrusion: 'geometry', MultiTextureCoordinate: 'texCoord' });
  // a MultiTextureCoordinate's own children are TextureCoordinates: the container is its `texCoord` MFNode, which the generic parser already fills
  FLAT['CoordinateInterpolator.keyValue'] = FLATF; FLAT['CoordinateInterpolator2D.keyValue'] = FLATF;
  INTERPOLATORS.add('CoordinateInterpolator'); INTERPOLATORS.add('CoordinateInterpolator2D');

  /* ------------------------------------------------------------ interpolators */
  const _interpolate = interpolate;
  interpolate = function (n, frac) {
    if (n.type !== 'CoordinateInterpolator' && n.type !== 'CoordinateInterpolator2D') return _interpolate(n, frac);
    const k = n.f.key, kv = n.f.keyValue, dim = n.type === 'CoordinateInterpolator' ? 3 : 2, K = k.length;
    if (!K || kv.length < K * dim) return null;
    const m = Math.floor(kv.length / (K * dim)), stride = m * dim;      // points per key
    let i = 0, j = 0, s = 0;
    if (frac <= k[0]) i = j = 0;
    else if (frac >= k[K - 1]) i = j = K - 1;
    else { while (i < K - 1 && frac >= k[i + 1]) i++; j = Math.min(i + 1, K - 1); const span = k[j] - k[i]; s = span > 0 ? (frac - k[i]) / span : 0; }
    const out = new Float32Array(stride);                                 // a new array per event: the geometry holds the last one
    const a = i * stride, b = j * stride;
    if (i === j || s === 0) { for (let q = 0; q < stride; q++) out[q] = kv[a + q]; } else for (let q = 0; q < stride; q++) out[q] = kv[a + q] + (kv[b + q] - kv[a + q]) * s;
    return out;
  };

  /* ---------------------------------------------------------------- geometry */
  const mkNode = (w, type, f) => { const n = { type, def: null, f, id: R.allocNodeId(), out: null }; w.nodes.push(n); return n; };
  const ifs = (w, n, P, UV, ci, ti, crease, ccw, solid) => {
    n.type = 'IndexedFaceSet';
    n.f = { coord: mkNode(w, 'Coordinate', { point: Float32Array.from(P) }), normal: null, color: null, texCoord: mkNode(w, 'TextureCoordinate', { point: Float32Array.from(UV), mapping: '' }), attrib: [],
            ccw, colorPerVertex: true, normalPerVertex: true, solid, coordIndex: Int32Array.from(ci), normalIndex: new Int32Array(0), colorIndex: [], texCoordIndex: Array.from(ti),
            convex: true, creaseAngle: crease, set_coordIndex: [], visible: true };
  };
  function disk(w, n) {
    const f = n.f, R1 = f.outerRadius, R0 = Math.max(0, Math.min(R1, f.innerRadius)), S = 96, P = [], UV = [], ci = [], ti = [];
    const ring = (r) => { for (let i = 0; i < S; i++) { const a = i / S * Math.PI * 2, x = Math.cos(a) * r, y = Math.sin(a) * r; P.push(x, y, 0); UV.push(0.5 + x / (2 * R1), 0.5 + y / (2 * R1)); } };
    if (R0 <= 0) {
      ring(R1); for (let i = 0; i < S; i++) { ci.push(i); ti.push(i); } ci.push(-1); ti.push(-1);
    } else {
      ring(R1); ring(R0);
      for (let i = 0; i < S; i++) { const j = (i + 1) % S; ci.push(i, S + i, S + j, j, -1); ti.push(i, S + i, S + j, j, -1); }
    }
    ifs(w, n, P, UV, ci, ti, 0, true, f.solid);
  }
  function rect(w, n) {
    const sx = n.f.size[0] / 2, sy = n.f.size[1] / 2;
    ifs(w, n, [-sx, -sy, 0, sx, -sy, 0, sx, sy, 0, -sx, sy, 0], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 2, 3, -1], [0, 1, 2, 3, -1], 0, true, n.f.solid);
  }

  /* Extrusion (19775-1 13.3.5): the spine-aligned cross-section plane at every spine point, scaled by `scale`, turned by `orientation`, placed on the spine */
  function extrusion(w, n) {
    const f = n.f, sp = f.spine, cs = f.crossSection, N = sp.length, M = cs.length;
    if (N < 2 || M < 2) { ifs(w, n, [0, 0, 0], [0, 0], [], [], 0, true, f.solid); return; }
    const v = R.v3, eq = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && (a.length < 3 || Math.abs(a[2] - b[2]) < 1e-6);
    const closedSpine = N > 2 && eq(sp[0], sp[N - 1]), closedCS = M > 2 && eq(cs[0], cs[M - 1]);
    const P3 = (i) => sp[closedSpine ? ((i % (N - 1)) + (N - 1)) % (N - 1) : i];
    // spine-aligned frames: Y along the spine tangent, Z the local binormal, X = Y x Z
    const Y = [], Z = [];
    for (let i = 0; i < N; i++) {
      let y;
      if (i === 0) y = closedSpine ? v.sub(sp[1], sp[N - 2]) : v.sub(sp[1], sp[0]);
      else if (i === N - 1) y = closedSpine ? v.sub(sp[1], sp[N - 2]) : v.sub(sp[N - 1], sp[N - 2]);
      else y = v.sub(sp[i + 1], sp[i - 1]);
      Y.push(v.norm(y));
      let z;
      if (i === 0 && closedSpine) z = v.cross(v.sub(sp[1], sp[0]), v.sub(sp[N - 2], sp[0]));
      else if (i === N - 1 && closedSpine) z = Z[0] ? Z[0].slice() : null;
      else if (i > 0 && i < N - 1) z = v.cross(v.sub(sp[i + 1], sp[i]), v.sub(sp[i - 1], sp[i]));
      else z = null;
      Z.push(z && v.len(z) > 1e-9 ? v.norm(z) : null);
    }
    if (!closedSpine) { const first = Z.find((z) => z); if (first) { if (!Z[0]) Z[0] = first.slice(); if (!Z[N - 1]) { for (let i = N - 2; i >= 0; i--) if (Z[i]) { Z[N - 1] = Z[i].slice(); break; } } } }
    if (!Z.some((z) => z)) {   // a straight spine: turn +Y onto the spine direction by the shortest rotation (19775-1 13.3.5)
      const t = Y[0], up = [0, 1, 0], ax = v.cross(up, t), l = v.len(ax), ang = Math.atan2(l, v.dot(up, t));
      const q = l < 1e-9 ? (v.dot(up, t) >= 0 ? [0, 0, 0, 1] : R.quat.fromAxisAngle([1, 0, 0], Math.PI)) : R.quat.fromAxisAngle(v.norm(ax), ang);
      const z0 = R.quat.rotate(q, [0, 0, 1]); for (let i = 0; i < N; i++) Z[i] = z0.slice();
    } else {
      let prev = null;                                                   // a point where three spine points are collinear takes the previous frame
      for (let i = 0; i < N; i++) { if (!Z[i]) Z[i] = prev ? prev.slice() : Z.find((z) => z).slice(); prev = Z[i]; }
      for (let i = 1; i < N; i++) if (v.dot(Z[i], Z[i - 1]) < 0) Z[i] = Z[i].map((x) => -x);   // no flips along the spine
    }
    const pts = new Array(N);
    for (let i = 0; i < N; i++) {
      const X = v.norm(v.cross(Y[i], Z[i])), sc = f.scale[Math.min(i, f.scale.length - 1)] || [1, 1], o = f.orientation[Math.min(i, f.orientation.length - 1)] || [0, 0, 1, 0];
      const q = R.quat.fromAxisAngle([o[0], o[1], o[2]], o[3]);
      pts[i] = cs.map((c) => { const r = R.quat.rotate(q, [c[0] * sc[0], 0, c[1] * sc[1]]); return [sp[i][0] + X[0] * r[0] + Y[i][0] * r[1] + Z[i][0] * r[2], sp[i][1] + X[1] * r[0] + Y[i][1] * r[1] + Z[i][1] * r[2], sp[i][2] + X[2] * r[0] + Y[i][2] * r[1] + Z[i][2] * r[2]]; });
    }
    // coordinate list: one point per (spine, cross-section) pair, with the closing duplicates folded onto the first ones so a crease angle smooths across the seam
    const Nu = closedSpine ? N - 1 : N, Mu = closedCS ? M - 1 : M, P = [], idx = (i, j) => (closedSpine ? i % (N - 1) : i) * Mu + (closedCS ? j % (M - 1) : j);
    for (let i = 0; i < Nu; i++) for (let j = 0; j < Mu; j++) P.push(...pts[i][j]);
    const UV = [], ci = [], ti = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) UV.push(j / (M - 1), i / (N - 1));
    for (let i = 0; i < N - 1; i++) for (let j = 0; j < M - 1; j++) {
      ci.push(idx(i, j), idx(i, j + 1), idx(i + 1, j + 1), idx(i + 1, j), -1);
      ti.push(i * M + j, i * M + j + 1, (i + 1) * M + j + 1, (i + 1) * M + j, -1);
    }
    // caps: the cross-section polygon, planar texture coordinates
    let minx = 1e30, maxx = -1e30, miny = 1e30, maxy = -1e30;
    for (const c of cs) { minx = Math.min(minx, c[0]); maxx = Math.max(maxx, c[0]); miny = Math.min(miny, c[1]); maxy = Math.max(maxy, c[1]); }
    const capUV0 = UV.length / 2;
    for (const c of cs) UV.push((c[0] - minx) / Math.max(1e-9, maxx - minx), (c[1] - miny) / Math.max(1e-9, maxy - miny));
    const cap = (row, rev) => {
      const ring = [], tr = []; for (let j = 0; j < Mu; j++) { ring.push(idx(row, j)); tr.push(capUV0 + j); }
      if (rev) { ring.reverse(); tr.reverse(); }
      ci.push(...ring, -1); ti.push(...tr, -1);
    };
    if (f.beginCap) cap(0, true);
    if (f.endCap) cap(N - 1, false);
    ifs(w, n, P, UV, ci, ti, f.creaseAngle, f.ccw, f.solid);
  }
  const parse0 = R.parseX3D;
  R.parseX3D = function (text) {
    const w = parse0(text);
    for (const n of w.nodes) { if (n.type === 'Disk2D') disk(w, n); else if (n.type === 'Rectangle2D') rect(w, n); else if (n.type === 'Extrusion') extrusion(w, n); }
    return w;
  };
  /* A disabled TimeSensor forgets its pause (19775-1 8.4.2: disabling stops it and resets its state); the demiurge pause kept st.paused and st.shift across a disable, so a
   seek (disable, set the times, enable) of a paused film stayed frozen at the old time. The page seeks that way in both engines. */
const _tickHL = tickTimeSensor;
tickTimeSensor = function (n, now) {
  const st = n.state;
  if (!n.f.enabled && st && (st.paused || st.shift || st.active)) {              // stop it here: the pause rule would otherwise re-pause an active sensor before the disable is seen
    st.paused = false; st.shift = 0; n.f.isPaused = false;
    if (st.active) { st.active = false; n.f.isActive = false; events.emit(n, 'isActive', false); }
    return;
  }
  return _tickHL(n, now);
};
R.tickTimeSensor = tickTimeSensor;

R.hallInfo = { types: ['Collision', 'CoordinateInterpolator', 'CoordinateInterpolator2D', 'Disk2D', 'Extrusion', 'MultiTextureCoordinate', 'PointProperties', 'Rectangle2D'] };
})();
