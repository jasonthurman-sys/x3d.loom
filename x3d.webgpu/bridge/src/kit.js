/* Bridge kit: one registry for the nodes the bridge adds, so each node is a single file (bridge/src/nodes/<Node>.js) and nothing in the older reader files changes.
   Concatenated after brain/reader.js and its extensions inside the same bundle scope (DEFS, PARSE, FLAT, CONTAINER, IO, IN, OUT, INIT, events, receive, parseX3D, R are visible).
   A node file calls BR.node(name, spec); spec may carry:
     defs        the field table, same shape as DEFS (generated from X3DUOM 4.0 by bridge/tools/driver.py scaffold)
     container   the default containerField
     extend      { ExistingNode: { newField: [...] } } fields added to nodes other ports defined
     flat        { 'Node.field': Float32Array|Int32Array } big arrays kept as typed arrays
     init(n, world)           once per parsed world, after the ROUTEs are wired
     dispose(n, world)        optional cleanup when the owner explicitly disposes an unused world
     receive(n, field, v)     an event arrives; return true when it is handled here (the stock handler is skipped)
     tick(n, now)             once per timestamp, before the event queue drains (sensors that poll, followers that move)
     build(body, n, parent, chain)   Babylon side: make what the node draws; return the record body.rec keeps
     geometry(g, body)        Babylon side: vertex data for a geometry node, same shape Body.geometryData returns
     changed(body, n, field)  Babylon side: a field changed after build
     preparse(text)           the scene text before it is parsed (language features that are rewritten into plain nodes, ProtoInstance)
     postparse(world)         the parsed world, before init (ProtoInstance connects its fields)
   The kit never touches a node type it does not own, so every earlier port parses and runs as before. */
const BR = (R.bridge = { specs: new Map(), tickers: new Set(), worlds: [], version: 1 });

// field types the older readers never needed (X3DUOM names them): plain number lists, the parsers the generated tables name
const _nums = (s) => numList(s);
for (const t of ['SFVec2d', 'SFVec3d', 'SFVec4d', 'SFMatrix3f', 'SFMatrix3d', 'SFMatrix4f', 'SFMatrix4d']) {
  const k = { SFVec2d: 2, SFVec3d: 3, SFVec4d: 4, SFMatrix3f: 9, SFMatrix3d: 9, SFMatrix4f: 16, SFMatrix4d: 16 }[t];
  if (!PARSE[t]) PARSE[t] = fixed(k, new Array(k).fill(0));
}
if (!PARSE.MFVec2d) PARSE.MFVec2d = (s) => chunk(_nums(s), 2);
if (!PARSE.MFVec3d) PARSE.MFVec3d = (s) => chunk(_nums(s), 3);
if (!PARSE.MFVec4d) PARSE.MFVec4d = (s) => chunk(_nums(s), 4);
if (!PARSE.MFDouble) PARSE.MFDouble = _nums;
if (!PARSE.MFBool) PARSE.MFBool = (s) => String(s).replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean).map((t) => /^true$/i.test(t));
if (!PARSE.MFMatrix3f) PARSE.MFMatrix3f = (s) => chunk(_nums(s), 9);
if (!PARSE.MFMatrix4f) PARSE.MFMatrix4f = (s) => chunk(_nums(s), 16);
if (!PARSE.SFImage) PARSE.SFImage = (s) => _nums(String(s).replace(/0x[0-9a-f]+/gi, (h) => parseInt(h, 16)));

BR.node = function (name, spec) {
  if (BR.specs.has(name)) throw new Error('bridge: ' + name + ' is registered twice');
  BR.specs.set(name, spec);
  if (spec.defs) {
    if (DEFS[name]) throw new Error('bridge: ' + name + ' is already in the reader; extend it instead');
    DEFS[name] = spec.defs; if (!spec.defs.metadata) DEFS[name].metadata = ['SFNode', IO, null];
    // Material-like and texture-like children join a parent through the node's containerField
    CONTAINER[name] = spec.container || 'children';
  }
  for (const [t, extra] of Object.entries(spec.extend || {})) Object.assign(DEFS[t], extra);
  Object.assign(FLAT, spec.flat || {});
  return spec;
};
BR.fieldOr = (n, f, d) => (n.f[f] === undefined ? d : n.f[f]);
BR.emit = (n, field, value) => { if (!n._disposed) { n.f[field] = value; events.emit(n, field, value); } };   // an output event raised by a bridge node

// Detached execution contexts may be imported later, so replacing a world does
// not destroy them. Their owner must explicitly release an unused context.
// This releases runtime ownership; media nodes still need their own dispose hook.
BR.referencesWorld = function (world, activeWorld) {
  if (!activeWorld) return false;
  if (world === activeWorld) return true;
  const owned = new Set(world.nodes), seen = new Set();
  const visit = (n) => {
    if (!n || seen.has(n)) return false;
    if (owned.has(n)) return true;
    seen.add(n);
    for (const [name, [type]] of Object.entries(fdefsOf(n))) {
      if (type === 'SFNode' && visit(n.f[name])) return true;
      if (type === 'MFNode' && (n.f[name] || []).some(visit)) return true;
    }
    return false;
  };
  return (activeWorld.children || []).some(visit);
};
BR.disposeWorld = function (world) {
  if (!world || world.disposed) return false;
  if (BR.referencesWorld(world, BR.body && BR.body.world)) throw new Error('Cannot dispose a world used by the active scene; detach its nodes or replace the scene first.');
  world.disposed = true;
  const nodes = new Set(world.nodes), errors = [];
  const i = BR.worlds.indexOf(world); if (i >= 0) BR.worlds.splice(i, 1);
  for (const n of nodes) { n._disposed = true; BR.tickers.delete(n); }
  const deadRoute = (r) => nodes.has(r.from) || nodes.has(r.to);
  // A route belongs to its source's output list as well as its scene. Retained
  // contexts must release incoming references to nodes in the disposed context.
  for (const liveWorld of BR.worlds) {
    liveWorld.routes = liveWorld.routes.filter((r) => !deadRoute(r));
    for (const n of liveWorld.nodes) if (n.out) for (const field of Object.keys(n.out)) {
      n.out[field] = n.out[field].filter((r) => !deadRoute(r));
      if (!n.out[field].length) delete n.out[field];
    }
  }
  for (const r of events.firedRoutes) if (deadRoute(r)) events.firedRoutes.delete(r);
  world.routes.length = 0;
  const keep = [];
  for (let j = 0; j < events.queue.length; j += 2) { const r = events.queue[j]; if (!nodes.has(r.from) && !nodes.has(r.to)) keep.push(r, events.queue[j + 1]); }
  events.queue.length = 0; for (const item of keep) events.queue.push(item);
  if (BR.body) BR.body.timeSensors = (BR.body.timeSensors || []).filter((n) => !nodes.has(n));
  for (const n of nodes) {
    const s = BR.specs.get(n.type);
    try { if (s && s.dispose) s.dispose(n, world); } catch (e) { errors.push(e); }
    if (n.cbs) for (const c of Object.values(n.cbs)) c.clear();
    n.out = null;
  }
  if (errors.length) throw new AggregateError(errors, 'Bridge world cleanup failed.');
  return true;
};

// every parsed world registers its bridge nodes: init once, then tick each timestamp
const _parse = R.parseX3D;   // preserve extension wrappers (hall converts Disk2D, Rectangle2D and Extrusion here)
parseX3D = function (text) {
  for (const s of BR.specs.values()) if (s.preparse) text = s.preparse(text);      // a node that is a language feature rewrites the text first (ProtoInstance expands PROTOs)
  const w = _parse(text);
  for (const s of BR.specs.values()) if (s.postparse) s.postparse(w);
  BR.worlds.push(w);
  for (const n of w.nodes) { const s = BR.specs.get(n.type); if (!s) continue; if (s.tick) BR.tickers.add(n); }
  for (const n of w.nodes) { const s = BR.specs.get(n.type); if (s && s.init) s.init(n, w); }
  return w;
};
R.parseX3D = parseX3D;

const _recv = receive;
receive = function (node, field, value) {
  if (node._disposed) return;
  if (node.protoIn && node.protoIn[field]) {            // an input of a PROTO instance goes to the nodes it is connected to (and on to the instance's own node when that field is one of its own)
    for (const t of node.protoIn[field]) receive(t.node, t.field, value);
    if (!(node.protoSelf && node.protoSelf[field])) { node.f[field] = value; return; }
  }
  const s = BR.specs.get(node.type);
  if (s && s.receive && s.receive(node, field, value) === true) return;
  return _recv(node, field, value);
};
R.receive = receive;

/* an output of a node that a PROTO instance exposes also reaches the instance's own field: its value is kept there and the page's listeners on the instance hear it */
const _emit = events.emit;
events.emit = function (node, field, value) {
  if (node._disposed) return;
  const r = _emit.call(this, node, field, value);
  if (node.protoOut && node.protoOut[field]) for (const t of node.protoOut[field]) {
    if (t.inst === node && t.name === field) continue;
    t.inst.f[t.name] = value; if (R.hooks && R.hooks.cb) R.hooks.cb(t.inst, t.name, value);
  }
  return r;
};

const _drain = events.drain;
events.drain = function () {
  if (BR.tickers.size) for (const n of BR.tickers) {
    if (n._tickTs === this.ts) continue;     // SAI sets call drain several times in one timestamp; a tick runs once per timestamp
    n._tickTs = this.ts; BR.specs.get(n.type).tick(n, this.ts);
  }
  return _drain.call(this);
};

/* key/keyValue lookup shared by the interpolators before the first key and after the last the end values hold; a zero-width span steps */
BR.lerpKeys = (k, kv, frac, mix) => {
  const N = Math.min(k.length, kv.length);
  if (!N) return null;
  if (frac <= k[0]) return clone(kv[0]);
  if (frac >= k[N - 1]) return clone(kv[N - 1]);
  let i = 0; while (i < N - 1 && frac >= k[i + 1]) i++;
  const j = Math.min(i + 1, N - 1), span = k[j] - k[i];
  return mix(kv[i], kv[j], span > 0 ? (frac - k[i]) / span : 0);
};

/* ---- shared interpolation math ---------------------------------------------------------------------------------------------------------
   keySearch: X3DInterpolatorNode's rule for set_fraction: [index0, index1, weight]; the end values hold outside the key range, a single key holds always. */
BR.keySearch = (key, f) => {
  const N = key.length;
  if (!N) return null;
  if (N === 1) return [0, 0, 0];
  if (f <= key[0]) return [0, 1, 0];
  if (f >= key[N - 1]) return [N - 2, N - 1, 1];
  let i = 0; while (i < N - 2 && f >= key[i + 1]) i++;
  const span = key[i + 1] - key[i];
  return [i, i + 1, span > 0 ? (f - key[i]) / span : 0];
};
{
  const vsub = (a, b) => a.map((x, i) => x - b[i]), vscale = (a, s) => a.map((x) => x * s), vlen = (a) => Math.hypot(...a);
  /* Catmull-Rom tangents for a Hermite spline over n-vectors (SplinePositionInterpolator, ...2D, SplineScalarInterpolator as 1-vectors):
     T[i] = (P[i+1] - P[i-1]) / 2 unless keyVelocity is given; closed wraps the ends; the key spacing scales the two sides (F-); normalizeVelocity rescales given velocities by the path length. */
  BR.splineGen = (closed, key, kv, kvel, normalize) => {
    const n = key.length, T0 = [], T1 = [];
    if (n < 2) { const z = (kv[0] || [0]).map(() => 0); return { T0: [z], T1: [z] }; }
    const Z = () => kv[0].map(() => 0); let T = [];
    if (!kvel.length) {
      T.push(closed ? vscale(vsub(kv[1], kv[kv.length - 2]), 0.5) : Z());
      for (let i = 1; i < kv.length - 1; i++) T.push(vscale(vsub(kv[i + 1], kv[i - 1]), 0.5));
      T.push(T[0].slice());
    } else {
      T = kvel.map((v) => v.slice());
      if (normalize) {
        let D = 0; for (let i = 0; i < kv.length - 1; i++) D += vlen(vsub(kv[i], kv[i + 1]));
        for (let i = 0; i < T.length - 1; i++) { const m = vlen(T[i]); if (m) T[i] = vscale(T[i], D / m); }
      }
    }
    const Fm = [], Fp = [];
    if (closed) { const a = n - 1, b = n - 2, d = key[1] - key[0] + key[a] - key[b]; Fm.push(2 * (key[1] - key[0]) / d); Fp.push(2 * (key[a] - key[b]) / d); }
    else { Fm.push(1); Fp.push(1); }
    for (let i = 1; i < n - 1; i++) { const d = key[i + 1] - key[i - 1]; Fm.push(2 * (key[i + 1] - key[i]) / d); Fp.push(2 * (key[i] - key[i - 1]) / d); }
    Fm.push(Fm[0]); Fp.push(Fp[0]);
    for (let i = 0; i < T.length; i++) { T0.push(vscale(T[i], Fp[i] ?? 1)); T1.push(vscale(T[i], Fm[i] ?? 1)); }
    return { T0, T1 };
  };
  BR.splineAt = (sp, i0, i1, t, kv) => {      // cubic Hermite basis on P[i0], P[i1], T0[i0], T1[i1]
    const t2 = t * t, t3 = t2 * t, h00 = 2 * t3 - 3 * t2 + 1, h01 = -2 * t3 + 3 * t2, h10 = t3 - 2 * t2 + t, h11 = t3 - t2;
    return kv[i0].map((_, c) => h00 * kv[i0][c] + h01 * kv[i1][c] + h10 * sp.T0[i0][c] + h11 * sp.T1[i1][c]);
  };
  /* the node-level driver for the three spline nodes: pads keyValue/keyVelocity to the key count, caches the tangents until a field changes, returns the interpolated vector */
  BR.splineNode = (n, frac, wrap, unwrap) => {
    const f = n.f, key = f.key; if (!key.length) return null;
    let kv = Array.from(f.keyValue, wrap); if (!kv.length) return null;
    const dflt = kv[kv.length - 1].map(() => 0);
    while (kv.length < key.length) kv.push(kv[kv.length - 1].slice());
    let kvel = Array.from(f.keyVelocity, wrap); if (kvel.length) while (kvel.length < key.length) kvel.push(dflt.slice());
    const stamp = [f.keyValue, f.keyVelocity, f.key, f.closed, f.normalizeVelocity];
    if (!n._sp || n._spStamp.some((x, i) => x !== stamp[i])) { n._sp = BR.splineGen(f.closed, key, kv, kvel, f.normalizeVelocity); n._spStamp = stamp; n._spKv = kv; }
    const ks = BR.keySearch(key, frac); if (!ks) return null;
    return unwrap(BR.splineAt(n._sp, ks[0], ks[1], ks[2], n._spKv));
  };
  BR.wrap1 = (x) => [x]; BR.unwrap1 = (a) => a[0]; BR.wrapN = (v) => Array.from(v); BR.unwrapN = (a) => a;

  /* quaternions [x, y, z, w]: log / exp / spline for SQUAD, and a slerp that goes the short way round (the reader's quat.slerp falls back to a normalised lerp very near parallel) */
  const qmul = quat.mul, qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], qneg = (a) => a.map((x) => -x), qinv = (a) => [-a[0], -a[1], -a[2], a[3]];
  const qlog = (q) => { const v = Math.hypot(q[0], q[1], q[2]), m = Math.hypot(v, q[3]); if (v < 1e-12) return [0, 0, 0, Math.log(m)]; const k = Math.acos(clamp(q[3] / m, -1, 1)) / v; return [q[0] * k, q[1] * k, q[2] * k, Math.log(m)]; };
  const qexp = (q) => { const v = Math.hypot(q[0], q[1], q[2]), e = Math.exp(q[3]); if (v < 1e-12) return [0, 0, 0, e]; const k = e * Math.sin(v) / v; return [q[0] * k, q[1] * k, q[2] * k, e * Math.cos(v)]; };
  const qslerp = (a, b, t, short = true) => {
    let c = qdot(a, b); if (short && c < 0) { c = -c; b = qneg(b); }
    if (c >= 1) return a.slice();
    const w = Math.acos(c), s = Math.sin(w); if (s < 1e-12) return a.map((x, i) => x + (b[i] - x) * t);
    const s0 = Math.sin((1 - t) * w) / s, s1 = Math.sin(t * w) / s; return a.map((x, i) => x * s0 + b[i] * s1);
  };
  const qnorm = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
  const qspline = (q0, q1, q2) => {            // the control quaternion s_i of SQUAD: q1 * exp(-(log(q1^-1 q0) + log(q1^-1 q2)) / 4), neighbours put in q1's hemisphere
    if (qdot(q0, q1) < 0) q0 = qneg(q0); if (qdot(q2, q1) < 0) q2 = qneg(q2);
    const i = qinv(q1), a = qlog(qmul(i, q0)), b = qlog(qmul(i, q2));
    return qnorm(qmul(q1, qexp(a.map((x, k) => -(x + b[k]) / 4))));
  };
  BR.squadGen = (closed, key, kv) => {
    const n = key.length, s = [];
    if (n > 1) {
      s.push(closed ? qspline(kv[n - 2], kv[0], kv[1]) : kv[0].slice());
      for (let i = 1; i < n - 1; i++) s.push(qspline(kv[i - 1], kv[i], kv[i + 1]));
      s.push(closed ? qspline(kv[n - 2], kv[n - 1], kv[1]) : kv[n - 1].slice());
    } else if (n) s.push(kv[0].slice());
    return s;
  };
  BR.squadAt = (s, i0, i1, t, kv) => qslerp(qslerp(kv[i0], kv[i1], t), qslerp(s[i0], s[i1], t), 2 * t * (1 - t));
  BR.q = { fromRot: (r) => quat.fromAxisAngle(r, r[3]), toRot: (q) => quat.toAxisAngle(q), slerp: qslerp, mul: qmul, inv: qinv };
}

/* ---- followers (Followers component) ------------------------------------------------------------------------------------------------------
   T converts a node value to an array and back: scalars become [x], vectors stay arrays. Chaser: the 60-stage buffer with a cosine step response over `duration`;
   Damper: `order` cascaded exponential filters with time constant `tau`. Both are driven by the timestamp (tick), not by a frame count, so a slow frame does not slow them. */
BR.T1 = { toA: (v) => [v], fromA: (a) => a[0] };
BR.TN = { toA: (v) => Array.from(v), fromA: (a) => a.slice() };
// lists of vectors (CoordinateChaser, TexCoordChaser2D, ...): followed as one flat array; a list that changes length restarts the buffers at the new length (gap: the new tail starts at 0)
BR.TL = (k) => ({ toA: (v) => Array.from(v).flat(), fromA: (a) => { const o = []; for (let i = 0; i + k <= a.length; i += k) o.push(a.slice(i, i + k)); return o; } });
// rotations as quaternions: slerp the short way, distance = the angle between them, a chaser step turns the output by the stage's delta (OrientationChaser / OrientationDamper)
BR.TR = { toA: (r) => BR.q.fromRot(r), fromA: (q) => BR.q.toRot(q), lerp: (a, b, w) => BR.q.slerp(a, b, w), dist: (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))),
  step: (o, v1, v2, t) => BR.q.slerp(o, BR.q.mul(o, BR.q.mul(BR.q.inv(v2), v1)), t) };
// colours follow in HSV (ColorChaser / ColorDamper), output converted back to RGB
{
  // HSV lerp the short way round the hue circle (the way ColorInterpolator does), and a distance that does the same, so a path across the hue seam still ends
  const hl = (A, B, w) => { A = A.slice(); B = B.slice(); if (A[1] === 0) A[0] = B[0]; if (B[1] === 0) B[0] = A[0]; let dh = B[0] - A[0]; if (dh > 0.5) dh -= 1; if (dh < -0.5) dh += 1; let h = A[0] + dh * w; h -= Math.floor(h); return [h, A[1] + (B[1] - A[1]) * w, A[2] + (B[2] - A[2]) * w]; };
  BR.TC = { toA: (c) => rgb2hsv(c), fromA: (h) => hsv2rgb(h), lerp: hl,
    dist: (a, b) => { let dh = Math.abs(a[0] - b[0]); dh = Math.min(dh, 1 - dh); return Math.hypot(dh, a[1] - b[1], a[2] - b[2]); },
    step: (o, v1, v2, t) => hl(o, o.map((x, c) => x + v1[c] - v2[c]), t) };
}
{
  const lerp = (a, b, w) => a.map((x, i) => x + (b[i] - x) * w), dist = (a, b) => Math.hypot(...a.map((x, i) => x - b[i])), cp = (a) => a.slice();
  const setActive = (n, on) => { const st = n._fl; if (st.active === on) return; st.active = on; n.f.isActive = on; events.emit(n, 'isActive', on); };
  const fit = (st, len) => { const pad = (a) => { a = a.slice(0, len); while (a.length < len) a.push(0); return a; }; if (st.buf[0].length === len && st.buf.every((b) => b.length === len)) return; st.buf = st.buf.map(pad); if (st.prev) st.prev = pad(st.prev); if (st.dest) st.dest = pad(st.dest); };
  const out = (T, n, a) => { n.f.value_changed = T.fromA(a); events.emit(n, 'value_changed', n.f.value_changed); };
  BR.chaserSpec = (T) => { const L = T.lerp || lerp, D = T.dist || dist, STEP = T.step || ((o, v1, v2, t) => o.map((x, c) => x + (v1[c] - v2[c]) * t)); return {
    init(n) {
      const f = n.f, iv = T.toA(f.initialValue), id = T.toA(f.initialDestination);
      const st = (n._fl = { buf: [cp(id)], prev: cp(iv), dest: cp(id), endTime: null, active: false });
      for (let i = 1; i < 60; i++) st.buf.push(cp(iv));
      if (D(id, iv) < 1e-8) f.value_changed = T.fromA(id); else { st.active = true; f.isActive = true; }
    },
    receive(n, field, v) {
      const st = n._fl; if (!st) return false;
      if (field === 'set_value') { if (!st.active) st.endTime = events.ts; const a = T.toA(v); st.buf = st.buf.map(() => cp(a)); st.prev = cp(a); out(T, n, a); setActive(n, true); return true; }
      if (field === 'set_destination') { st.dest = T.toA(v); fit(st, st.dest.length); if (!st.active) st.endTime = events.ts; setActive(n, true); return true; }
      return false;
    },
    tick(n, now) {
      const st = n._fl; if (!st || !st.active) return;
      if (st.endTime === null) st.endTime = now;
      const NB = 60, dur = Math.max(n.f.duration, 1e-9), stepTime = dur / NB;
      const resp = (t) => (t <= 0 ? 0 : t >= dur ? 1 : 0.5 - 0.5 * Math.cos((t / dur) * Math.PI));
      let fr = (now - st.endTime) / stepTime;
      if (fr >= 1) {
        const s = Math.floor(fr); fr -= s;
        if (s < NB) {
          st.prev = cp(st.buf[NB - s]);
          for (let i = NB - 1; i >= s; --i) st.buf[i] = cp(st.buf[i - s]);
          for (let i = 0; i < s; ++i) st.buf[i] = L(st.dest, st.buf[s], i / s);
        } else { st.prev = cp(s === NB ? st.buf[0] : st.dest); for (let i = 0; i < NB; ++i) st.buf[i] = cp(st.dest); }
        st.endTime += s * stepTime;
      }
      let o = L(st.prev, st.buf[NB - 1], resp((NB - 1 + fr) * stepTime));
      for (let i = NB - 2; i >= 0; --i) o = STEP(o, st.buf[i], st.buf[i + 1], resp((i + fr) * stepTime));
      out(T, n, o);
      if (D(o, st.dest) < 1e-8) setActive(n, false);
    },
  }; };
  BR.damperSpec = (T) => { const L = T.lerp || lerp, D = T.dist || dist; return {
    init(n) {
      const f = n.f, iv = T.toA(f.initialValue), id = T.toA(f.initialDestination), order = clamp(f.order, 0, 5);
      const st = (n._fl = { buf: [cp(id)], active: false, last: null });
      for (let i = 1; i <= order; i++) st.buf.push(cp(iv));
      if (D(id, iv) < (f.tolerance < 0 ? 1e-4 : f.tolerance)) f.value_changed = T.fromA(id); else { st.active = true; f.isActive = true; }
    },
    receive(n, field, v) {
      const st = n._fl; if (!st) return false;
      if (field === 'set_value') { const a = T.toA(v); for (let i = 1; i < st.buf.length; i++) st.buf[i] = cp(a); if (!st.active) st.last = events.ts; out(T, n, a); setActive(n, true); return true; }
      if (field === 'set_destination') { const a = T.toA(v); fit(st, a.length); st.buf[0] = a; if (!st.active) st.last = events.ts; setActive(n, true); return true; }
      return false;
    },
    tick(n, now) {
      const st = n._fl; if (!st || !st.active) return;
      const f = n.f, want = clamp(f.order, 0, 5) + 1, tol = f.tolerance < 0 ? 1e-4 : f.tolerance;
      while (st.buf.length < want) st.buf.push(cp(st.buf[st.buf.length - 1])); st.buf.length = want;
      let order = want - 1;
      if (f.tau) {
        const dt = st.last == null ? 1 / 60 : Math.max(0, now - st.last); st.last = now; const alpha = Math.exp(-dt / f.tau);
        for (let i = 0; i < order; i++) st.buf[i + 1] = L(st.buf[i], st.buf[i + 1], alpha);
        out(T, n, st.buf[order]);
        if (D(st.buf[order], st.buf[0]) >= tol) return;
      } else { out(T, n, st.buf[0]); order = 0; }
      for (let i = 1; i < st.buf.length; i++) st.buf[i] = cp(st.buf[order]);
      setActive(n, false);
    },
  }; };
}

/* every node can carry a metadata child (19775-1 7.2.2 X3DNode.metadata): add the field to the older tables that lack it */
for (const t of Object.keys(DEFS)) if (!DEFS[t].metadata) DEFS[t].metadata = ['SFNode', IO, null];

/* ---- pointer drag sensors (PointingDeviceSensor) -----------------------------------------------------------------------------------------------
   The Babylon body (body-br.js) turns a pointer press on a Shape into dragStart/dragMove/dragEnd calls on the sensors that are children of the Shape's nearest group. The ray
   arrives in that group's local frame as it was at the press (the group may move while it is dragged, the frame does not). The sensor does the geometry and raises its outputs
   through BR.fire. Tests call the same three methods through BR.drag with synthetic rays. */
BR.fire = (n, f, v) => { if (!n._disposed) return R.hooks && R.hooks.fire ? R.hooks.fire(n, f, v) : (n.f[f] = v, events.emit(n, f, v)); };
BR.drag = {
  start(n, c) { const s = BR.specs.get(n.type); if (n.f.enabled === false) return; n._dragging = true; s.dragStart(n, c); },
  move(n, c) { if (n._dragging) BR.specs.get(n.type).dragMove(n, c); },
  end(n) { if (n._dragging) { n._dragging = false; BR.specs.get(n.type).dragEnd(n); } },
};
{
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], len = (a) => Math.hypot(a[0], a[1], a[2]);
  BR.geo = {
    dot, sub, len,
    at: (o, d, t) => [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]],
    /* ray against a sphere about the origin: the nearest hit in front, else the point of the sphere nearest to the ray */
    raySphere(o, d, r) {
      const a = dot(d, d), b = 2 * dot(o, d), c = dot(o, o) - r * r, disc = b * b - 4 * a * c;
      if (disc >= 0 && a > 1e-12) { const q = Math.sqrt(disc); let t = (-b - q) / (2 * a); if (t < 0) t = (-b + q) / (2 * a); if (t >= 0) return BR.geo.at(o, d, t); }
      const t = a > 1e-12 ? -b / (2 * a) : 0, p = BR.geo.at(o, d, t), l = len(p) || 1; return p.map((x) => (x / l) * r);
    },
    /* ray against the cylinder x^2 + z^2 = r^2 (axis Y): nearest hit in front, else the nearest point to the ray pushed out to the radius */
    rayCylinder(o, d, r) {
      const a = d[0] * d[0] + d[2] * d[2], b = 2 * (o[0] * d[0] + o[2] * d[2]), c = o[0] * o[0] + o[2] * o[2] - r * r, disc = b * b - 4 * a * c;
      if (a > 1e-12) {
        if (disc >= 0) { const q = Math.sqrt(disc); let t = (-b - q) / (2 * a); if (t < 0) t = (-b + q) / (2 * a); if (t >= 0) return BR.geo.at(o, d, t); }
        const p = BR.geo.at(o, d, -b / (2 * a)), l = Math.hypot(p[0], p[2]) || 1; return [(p[0] / l) * r, p[1], (p[2] / l) * r];
      }
      return null;
    },
  };
}

/* key helpers shared by KeySensor and StringSensor: modifier keys, action key codes (X3D: F1-F12 = 1-12, Home 13, End 14, PageUp 15, PageDown 16, arrows 17-20), the text a key stands for */
BR.keys = {
  mod: { Shift: 'shiftKey', Control: 'controlKey', Alt: 'altKey' },
  action: { F1: 1, F2: 2, F3: 3, F4: 4, F5: 5, F6: 6, F7: 7, F8: 8, F9: 9, F10: 10, F11: 11, F12: 12, Home: 13, End: 14, PageUp: 15, PageDown: 16, ArrowUp: 17, ArrowDown: 18, ArrowLeft: 19, ArrowRight: 20 },
  text(e) {
    switch (e.key) {
      case 'AltGraph': case 'CapsLock': case 'Insert': return null;
      case 'Backspace': return String.fromCharCode(8);
      case 'Delete': return String.fromCharCode(127);
      case 'Enter': return '\n';
      case 'Escape': return String.fromCharCode(27);
      case 'Tab': return '\t';
      default: return e.key && e.key.length === 1 ? e.key : null;
    }
  },
};
// a url from a node as the page would load it: through the body's resolver when there is one, else against the page
BR.resolveUrl = (u) => { const b = R.bridge.body; try { return b && b.resolve ? b.resolve(u, b.baseUrl) : new URL(u, document.baseURI).href; } catch (e) { return u; } };

/* ---- geometry sets -------------------------------------------------------------------------------------------------------------------------------
   The node gives its triangles as source vertex numbers (3 per triangle) and the face each triangle belongs to (a fan, a strip, a quad); compose() turns that into the vertex data
   the body draws: one corner per triangle vertex, so per-face colours and normals work. Winding follows ccw. A missing normal is made here: smooth over the shared source vertex when
   normalPerVertex, else flat per face. Colours drop alpha (the body draws RGB). */
BR.compose = (g, tri, faceOf) => {
  const f = g.f, P = (f.coord && f.coord.f.point) || [], nc = tri.length, flip = f.ccw === false;
  const pos = new Float32Array(nc * 3), idx = new Uint32Array(nc), nrm = new Float32Array(nc * 3), perV = f.normalPerVertex !== false, cperV = f.colorPerVertex !== false;
  const C = f.color && f.color.f.color, cw = f.color && f.color.type === 'ColorRGBA' ? 4 : 3, N = f.normal && f.normal.f.vector, T = f.texCoord && f.texCoord.f.point;
  const col = C ? new Float32Array(nc * 3) : null, uv = T ? new Float32Array(nc * 2) : null;
  for (let c = 0; c < nc; c++) {
    const v = tri[c], face = faceOf[(c / 3) | 0];
    pos[c * 3] = P[v * 3]; pos[c * 3 + 1] = P[v * 3 + 1]; pos[c * 3 + 2] = P[v * 3 + 2];
    if (uv) { uv[c * 2] = T[v * 2]; uv[c * 2 + 1] = T[v * 2 + 1]; }
    if (col) { const k = (cperV ? v : face) * cw; col[c * 3] = C[k]; col[c * 3 + 1] = C[k + 1]; col[c * 3 + 2] = C[k + 2]; }
  }
  for (let t = 0; t < nc; t += 3) { if (flip) { idx[t] = t; idx[t + 1] = t + 2; idx[t + 2] = t + 1; } else { idx[t] = t; idx[t + 1] = t + 1; idx[t + 2] = t + 2; } }
  const fn = new Float32Array(nc);                    // face normal of each triangle, from the emitted order, unnormalised
  const tn = new Array(nc / 3);
  for (let t = 0; t < nc; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, d = idx[t + 2] * 3;
    const u = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]], w = [pos[d] - pos[a], pos[d + 1] - pos[a + 1], pos[d + 2] - pos[a + 2]];
    tn[t / 3] = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  }
  const nl = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  if (N) {
    for (let c = 0; c < nc; c++) { const k = (perV ? tri[c] : faceOf[(c / 3) | 0]) * 3; nrm[c * 3] = N[k]; nrm[c * 3 + 1] = N[k + 1]; nrm[c * 3 + 2] = N[k + 2]; }
  } else if (perV) {
    const acc = new Map();
    for (let t = 0; t < nc / 3; t++) for (let k = 0; k < 3; k++) { const v = tri[t * 3 + k], a = acc.get(v) || [0, 0, 0]; a[0] += tn[t][0]; a[1] += tn[t][1]; a[2] += tn[t][2]; acc.set(v, a); }
    for (let c = 0; c < nc; c++) { const n = nl(acc.get(tri[c])); nrm[c * 3] = n[0]; nrm[c * 3 + 1] = n[1]; nrm[c * 3 + 2] = n[2]; }
  } else {
    for (let c = 0; c < nc; c++) { const n = nl(tn[(c / 3) | 0]); nrm[c * 3] = n[0]; nrm[c * 3 + 1] = n[1]; nrm[c * 3 + 2] = n[2]; }
  }
  return { pos, nrm, col, uv, idx };
};
// index lists with -1 separators -> list of runs
BR.runs = (index) => { const out = []; let cur = []; for (const i of index || []) { if (i < 0) { if (cur.length) out.push(cur); cur = []; } else cur.push(i); } if (cur.length) out.push(cur); return out; };

/* ---- 2D curves and fills ------------------------------------------------------------------------------------------------------------------------
   Arc2D, ArcClose2D, Circle2D follow X_ITE 16.6.0's tessellation (dimension 40 over a full turn): sweep from start to end angle counter-clockwise, equal start and end is a full turn. */
BR.TAU = Math.PI * 2;
BR.interval = (v, lo, hi) => { const d = hi - lo; return (((v - lo) % d) + d) % d + lo; };
BR.sweep = (s, e) => { const a = BR.interval(s, 0, BR.TAU), b = BR.interval(e, 0, BR.TAU); if (a === b) return BR.TAU; const w = Math.abs(b - a); if (a > b) return BR.TAU - w; return isNaN(w) ? 0 : w; };
BR.DIM2D = 40;
/* points of an arc, n of them evenly from start over sweep (the last at start + sweep) */
BR.arc = (r, start, sweep, n) => { const out = new Float32Array(n * 2); for (let i = 0; i < n; i++) { const t = start + sweep * (n === 1 ? 0 : i / (n - 1)); out[i * 2] = r * Math.cos(t); out[i * 2 + 1] = r * Math.sin(t); } return out; };
/* fill a set of triangles given as flat xy corners (3 per triangle): +z normals, texture coordinates from a callback, indices in order */
BR.fill2D = (xy, uvOf) => {
  const n = xy.length / 2, pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), idx = new Uint32Array(n), uv = uvOf ? new Float32Array(n * 2) : null;
  for (let i = 0; i < n; i++) { pos[i * 3] = xy[i * 2]; pos[i * 3 + 1] = xy[i * 2 + 1]; nrm[i * 3 + 2] = 1; idx[i] = i; if (uv) { const u = uvOf(xy[i * 2], xy[i * 2 + 1]); uv[i * 2] = u[0]; uv[i * 2 + 1] = u[1]; } }
  return { pos, nrm, col: null, uv, idx };
};
BR.pt3 = (p) => { const o = new Float32Array(p.length / 2 * 3); for (let i = 0; i < p.length / 2; i++) { o[i * 3] = p[i * 2]; o[i * 3 + 1] = p[i * 2 + 1]; } return o; };   // flat xy -> flat xyz at z = 0
