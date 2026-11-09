// node run-tests.js [--no-xite] [--babylon babylon.js] NODE...  -> prints one JSON line {env, results:{NODE:{ok, ours, xite, msg, gaps}}}
// Every node has fixtures/NODE.x3d and fixtures/NODE.test.json. The same spec runs in two engines through the SAI both expose:
//   ours  = the reader + SAI shim of x3d.webgpu (headless: no Babylon for mode "events"; mode "scene" adds the Babylon body on SwiftShader WebGPU)
//   xite  = X_ITE ($XITE_DIR, default /tmp/bb/xite/package/dist), the oracle, WebGL2 on SwiftShader
// Spec: {node, mode, steps:[{set:[def,field,value,type?]}, {expect:[def,field,value]}, {event:[def,field,value]}, {noevent:[def,field]}], gaps:[...], xite:false to skip}
// Values: numbers, booleans, strings, arrays; "$time" matches any epoch-scale time. Floats compare at 1e-5.
const fs = require('fs'), path = require('path'), http = require('http');
const BR = path.resolve(__dirname, '..'), SRC = path.resolve(BR, '..', 'demo', 'src');
const args = process.argv.slice(2); const noXite = args.includes('--no-xite');
const bi = args.indexOf('--babylon'); const babylon = bi >= 0 ? args.splice(bi, 2)[1] : (process.env.BABYLON_JS || '/tmp/bb/t/package/babylon.js');
const names = args.filter((a) => !a.startsWith('--'));
const XITE_DIR = process.env.XITE_DIR || '/tmp/bb/xite/package/dist';

const bundle = require('./bundle.js');

// A local-only run is useful, but a missing reference engine must never look like a comparison pass.
// xiteDisagrees documents an assertion disagreement; it cannot excuse an engine that threw or did not run.
function verdict(r, spec, skipXite, pageErrors = []) {
  r.comparison = spec.xite === false ? 'not-applicable' : skipXite ? 'skipped' :
    r.xiteOk === undefined ? 'unavailable' : r.xiteOk ? 'passed' : 'failed';
  const required = spec.xite !== false && !skipXite;
  const disagreement = r.xiteOk === false && !r.xiteError && typeof spec.xiteDisagrees === 'string' && spec.xiteDisagrees.trim();
  r.ok = r.oursOk === true && (!required || r.xiteOk === true || !!disagreement) && !pageErrors.length;
  r.msg = pageErrors.length ? 'page errors during the test' : required && r.xiteOk === undefined ? 'X_ITE required but unavailable; set XITE_DIR or explicitly use --no-xite' :
    r.xiteError ? 'X_ITE could not execute the test' : disagreement ? 'X_ITE differs (' + spec.xiteDisagrees + ')' :
    r.xiteOk === false && r.oursOk ? 'X_ITE disagrees with the spec: check the spec' : '';
  if (pageErrors.length) r.pageErrors = pageErrors.slice();
  return r;
}

// ---- the runner both pages share: it only uses the SAI ---------------------------------------------------------------------------------
const RUNNER = `
const plain = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v) || (typeof v.length === 'number' && typeof v !== 'string' && !('x' in v))) return Array.from(v, plain);
  if ('angle' in v && 'x' in v) return [v.x, v.y, v.z, v.angle];
  if ('w' in v && 'x' in v) return [v.x, v.y, v.z, v.w];
  if ('z' in v && 'x' in v) return [v.x, v.y, v.z];
  if ('y' in v && 'x' in v) return [v.x, v.y];
  if ('r' in v && 'a' in v) return [v.r, v.g, v.b, v.a];
  if ('r' in v && 'g' in v) return [v.r, v.g, v.b];
  return v.getNodeName ? '[node ' + v.getNodeName() + ']' : String(v);
};
const close = (a, b) => {
  if (b === '$any') return true;
  if (b === '$time') return typeof a === 'number' && isFinite(a) && a > 1e9;
  if (typeof b === 'number' && typeof a === 'number') return Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b));
  if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((x, i) => close(a[i], x));
  return a === b;
};
const show = (v) => JSON.stringify(v);
async function runSpec(eng, spec, xml) {
  if (!Array.isArray(spec.steps) || !spec.steps.length) throw new Error('test spec requires at least one step');
  const out = { ok: true, steps: 0, fails: [], recorded: [], map: {} }; const X = window.X3D;
  const scene = await eng.open(xml); const nodes = {}; const events = {};
  const node = (d) => (nodes[d] ||= scene.getNamedNode(d));
  const conv = (t, v) => {
    if (!t) return v;
    switch (t) {
      case 'SFVec2f': return new X.SFVec2f(...v); case 'SFVec3f': return new X.SFVec3f(...v); case 'SFRotation': return new X.SFRotation(...v); case 'SFColor': return new X.SFColor(...v);
      case 'MFVec3f': return new X.MFVec3f(...v.map((a) => new X.SFVec3f(...a))); case 'MFVec2f': return new X.MFVec2f(...v.map((a) => new X.SFVec2f(...a)));
      case 'MFVec3d': return eng.name === 'ours' ? Float32Array.from(v.flat()) : new X.MFVec3d(...v.map((a) => new X.SFVec3d(...a)));   // the reader keeps double lists flat
      case 'MFFloat': return new X.MFFloat(...v); case 'MFInt32': return new X.MFInt32(...v); case 'MFString': return new X.MFString(...v);
      default: return v;
    }
  };
  for (const s of spec.steps) for (const k of ["event", "noevent", "atleast"]) if (s[k]) {
    const [d, f] = s[k], key = d + '.' + f;
    if (!events[key]) { events[key] = []; node(d).addFieldCallback('w' + key, f, (v) => events[key].push(plain(v))); }
  }
  for (const [i, s] of spec.steps.entries()) {
    if (s.only && s.only !== eng.name) continue;     // a step that only one engine can take (X_ITE waits for every resource before it hands the world over)
    out.steps++;
    const fail = (m) => { out.ok = false; out.fails.push('step ' + (i + 1) + ': ' + m); };
    try {
      if (s.set) { for (const k in events) events[k].length = 0; const [d, f, v0, t] = s.set; const v = v0 === '$now' ? performance.timeOrigin / 1000 + performance.now() / 1000 : v0; await eng.apply(() => { node(d)[f] = conv(t, v); }); }
      else if (s.settle) await eng.settle(s.settle);
      else if (s.expect) { const [d, f, v] = s.expect; const a = plain(node(d)[f]); if (!close(a, v)) fail(d + '.' + f + ' is ' + show(a) + ', expected ' + show(v)); }
      else if (s.event) { const [d, f, v] = s.event; const l = events[d + '.' + f]; if (v === '$any') out.recorded.push(l.length === 1 ? l[0] : l); if (l.length !== 1) fail(d + '.' + f + ' fired ' + l.length + ' times (' + show(l) + '), expected 1'); else if (!close(l[0], v)) fail(d + '.' + f + ' event ' + show(l[0]) + ', expected ' + show(v)); }
      else if (s.between) { const [d, f, lo, hi] = s.between; const a = plain(node(d)[f]); if (!(a > lo && a < hi)) fail(d + '.' + f + ' is ' + show(a) + ', expected between ' + lo + ' and ' + hi); }
      else if (s.near) { const [d, f, v, tol] = s.near; const a = plain(node(d)[f]); if (!(Math.abs(a - v) <= tol)) fail(d + '.' + f + ' is ' + show(a) + ', expected ' + v + ' within ' + tol); }
      else if (s.nearv) { const [d, f, v, tol] = s.nearv; const fl = (x) => (Array.isArray(x) ? x.flatMap(fl) : [x]); const a = fl(plain(node(d)[f])), vv = fl(v); if (!(a.length === vv.length && vv.every((x, i) => Math.abs(a[i] - x) <= tol))) fail(d + '.' + f + ' is ' + show(a) + ', expected ' + show(v) + ' within ' + tol); }
      else if (s.js) { const [code, v] = s.js; const got = await new Function('return (' + code + ')')(); if (v === '$any') out.recorded.push(got); if (!close(got, v)) fail('js ' + show(got) + ', expected ' + show(v)); }
      else if (s.px) { const [x, y, v, tol] = s.px; const im = new Image(); im.src = eng.name === 'ours' ? await window.__bodyShot() : 'data:image/png;base64,' + await window.__pxraw(x, y); await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); const a = Array.from(g.getImageData(eng.name === 'ours' ? x : 0, eng.name === 'ours' ? y : 0, 1, 1).data).slice(0, 3); if (v === '$any') out.recorded.push(a); else if (!(a.every((q, i) => Math.abs(q - v[i]) <= (tol ?? 24)))) fail('px ' + x + ',' + y + ' is ' + show(a) + ', expected ' + show(v) + ' within ' + (tol ?? 24)); }
      else if (s.shot) out.recorded.push(eng.name === 'ours' ? await window.__bodyShot() : 'data:image/png;base64,' + await window.__shotraw());   // a whole 320 x 240 picture, for demo pages
      else if (s.setnode) { const [d, f, d2] = s.setnode; await eng.apply(() => { node(d)[f] = node(d2); }); }
      else if (s.wait) await new Promise((r) => setTimeout(r, s.wait * 1000));
      else if (s.key) { await window.__key(...s.key); await eng.settle(0.1); }
      else if (s.mouse) { await window.__mouse(...s.mouse); await eng.settle(0.15); }
      else if (s.record) { const [d, f, name] = s.record; out.map[name] = plain(node(d)[f]); }
      else if (s.reset) { for (const k in events) events[k].length = 0; }
      else if (s.atleast) { const [d, f, n] = s.atleast; const l = events[d + '.' + f]; if (l.length < n) fail(d + '.' + f + ' fired ' + l.length + ' times, expected at least ' + n); }
      else if (s.noevent) { const [d, f] = s.noevent; const l = events[d + '.' + f]; if (l.length) fail(d + '.' + f + ' fired ' + show(l) + ', expected nothing'); }
      else fail('unknown or empty test step');
    } catch (e) { fail('threw ' + String(e).slice(0, 160)); }
  }
  return out;
}
`;
const PAGE_OURS = `<!doctype html><meta charset=utf-8><body><script src="/bundle.js"></script><script>${RUNNER}
let ts = performance.timeOrigin / 1000 + performance.now() / 1000;
window.runOurs = async (spec, xml) => (window.__R && (__R.bridge.allowScripts = spec.scripts !== false), runSpec({ name: 'ours',
  open: async (x) => { const sc = await X3DSAI.B.createX3DFromString(x); return sc; },
  apply: async (fn) => { __events.begin(ts += 0.05); fn(); __events.drain(); },
  settle: async (dt) => { const sc = X3DSAI.B.currentScene, steps = Math.max(1, Math.round((dt || 0.05) / 0.05));
    for (let i = 0; i < steps; i++) { __events.begin(ts += 0.05); for (const n of (window.__worlds || [])) for (const t of n.nodes) if (t.type === 'TimeSensor') __R.tickTimeSensor(t, ts); __events.drain(); } },
}, spec, xml));
</script>`;
const PAGE_XITE = `<!doctype html><meta charset=utf-8><link rel=stylesheet href="/x_ite/x_ite.css"><body><x3d-canvas id=c style="width:64px;height:64px"></x3d-canvas><script src="/x_ite/x_ite.min.js"></script><script>${RUNNER}
window.runXite = async (spec, xml) => { const b = X3D.getBrowser('#c'); await b.loadComponents?.(b.getProfile ? b.getProfile('Full') : undefined).catch(() => {});
  return runSpec({ name: 'xite',
    open: async (x) => { const sc = await b.createX3DFromString(x); await b.replaceWorld(sc); await b.nextFrame(); return sc; },
    apply: async (fn) => { fn(); await b.nextFrame(); await b.nextFrame(); },
    settle: async (dt) => { await new Promise((r) => setTimeout(r, (dt || 0.05) * 1000)); await b.nextFrame(); },
  }, spec, xml); };
window.xiteInfo = () => ({ name: X3D.getBrowser('#c').name, version: X3D.getBrowser('#c').version });
</script>`;

const PAGE_OURS_SCENE = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#000"><canvas id=c width=320 height=240 style="width:320px;height:240px;display:block"></canvas><script src="/babylon.js"></script><script src="/bundle-body.js"></script><script>${RUNNER}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
window.sceneReady = (async () => { const body = new Body(document.getElementById('c'), { onNote: (m) => (window.__notes = window.__notes || []).push(m) }); await body.init(); X3DSAI.setBody(body); window.__body = body; })();
window.__bodyShot = async () => {
  const b = window.__body, sc = b.scene, cams = sc.activeCameras && sc.activeCameras.length > 1 ? sc.activeCameras.slice() : null;
  const shot = (cam) => BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(b.engine, cam, { width: 320, height: 240 });
  if (!cams) return shot(sc.activeCamera);
  /* several layer cameras: Babylon draws them one over the other on the canvas; a render target holds one camera, so each is shot alone (later layers on a clear background) and the pictures are stacked in order */
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240; const g = cv.getContext('2d'), keep = sc.clearColor.clone(), keepA = sc.activeCameras;
  try {
    for (let i = 0; i < cams.length; i++) {
      sc.clearColor.a = i ? 0 : keep.a; sc.activeCameras = [cams[i]];
      const im = new Image(); im.src = await shot(cams[i]); await im.decode(); g.drawImage(im, 0, 0);
    }
  } finally { sc.clearColor.copyFrom(keep); sc.activeCameras = keepA; }
  return cv.toDataURL('image/png');
};
window.runScene = async (spec, xml) => { await window.sceneReady; if (window.__R) __R.bridge.allowScripts = spec.scripts !== false; return runSpec({ name: 'ours',
  open: async (x) => { const sc = await X3DSAI.B.createX3DFromString(x); await X3DSAI.B.replaceWorld(sc); await X3DSAI.B.nextFrame(); await X3DSAI.B.nextFrame(); return sc; },
  apply: async (fn) => { fn(); await X3DSAI.B.nextFrame(); await X3DSAI.B.nextFrame(); },
  settle: async (dt) => { await sleep((dt || 0.05) * 1000); await X3DSAI.B.nextFrame(); },
}, spec, xml); };
</script>`;
const PAGE_XITE_SCENE = `<!doctype html><meta charset=utf-8><link rel=stylesheet href="/x_ite/x_ite.css"><body style="margin:0"><x3d-canvas id=c style="width:320px;height:240px;display:block"></x3d-canvas><script src="/x_ite/x_ite.min.js"></script><script>${RUNNER}
window.runScene = async (spec, xml) => { const b = X3D.getBrowser('#c'); await b.loadComponents?.(b.getProfile ? b.getProfile('Full') : undefined).catch(() => {});     // the external components (Layout needs Text's classes) are loaded up front, as in the event runner
  return runSpec({ name: 'xite',
    open: async (x) => { const sc = await b.createX3DFromString(x); await b.replaceWorld(sc); await b.nextFrame(); await b.nextFrame(); return sc; },
    apply: async (fn) => { fn(); await b.nextFrame(); await b.nextFrame(); },
    settle: async (dt) => { await new Promise((r) => setTimeout(r, (dt || 0.05) * 1000)); await b.nextFrame(); },
  }, spec, xml); };
window.xiteInfo = () => ({ name: X3D.getBrowser('#c').name, version: X3D.getBrowser('#c').version });
</script>`;
const STUB = () => {   // as the earlier port harnesses do: headless WebGPU draws into an offscreen texture, frames paced at 300 ms
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 300);
  const o = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, op) { if (t !== 'webgpu') return o.call(this, t, op); const canvas = this;
    const ctx = { _t: null, _d: null, _f: 'bgra8unorm', canvas, configure(c) { this._d = c.device; this._f = c.format; }, unconfigure() {},
      getCurrentTexture() { const w = canvas.width, h = canvas.height; if (!this._t || this._t.width !== w || this._t.height !== h) { this._t = this._d.createTexture({ size: [w, h], format: this._f, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING }); } return this._t; } };
    return ctx; };
};

function serve(files) {
  const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  return new Promise((res) => { const s = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/clip.webm') { r.setHeader('content-type', 'video/webm'); r.setHeader('cache-control', 'no-store'); return fs.createReadStream(path.join(BR, 'fixtures', 'assets', 'clip.webm')).pipe(r); }
    if (u === '/px.png' || u === '/slow.png') { const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'); r.setHeader('content-type', 'image/png'); r.setHeader('cache-control', 'no-store'); return u === '/px.png' ? r.end(png) : setTimeout(() => r.end(png), 2500); }
    if (files[u] !== undefined) { r.setHeader('content-type', mime[path.extname(u)] || 'text/html'); return r.end(files[u]); }
    if (u.startsWith('/x_ite/')) { const f = path.join(XITE_DIR, u.slice(7)); if (fs.existsSync(f) && fs.statSync(f).isFile()) { r.setHeader('content-type', mime[path.extname(f)] || 'application/octet-stream'); return fs.createReadStream(f).pipe(r); } }
    r.statusCode = 404; r.end('no');
  }).listen(0, () => res(s)); });
}

async function main() {
  if (!names.length) throw new Error('name at least one fixture to test');
  const { chromium } = require('playwright');
  // Event-only tests need neither the Babylon distribution nor a GPU body.
  const files = { '/bundle.js': bundle('reader'), '/bundle-body.js': bundle('body'), '/ours.html': PAGE_OURS, '/xite.html': PAGE_XITE, '/ours-scene.html': PAGE_OURS_SCENE, '/xite-scene.html': PAGE_XITE_SCENE };
  const server = await serve(files), base = 'http://localhost:' + server.address().port;
  let b;
  try {
  b = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-webgpu-adapter=swiftshader'] });
  const env = { chromium: b.version(), ours: 'x3d.webgpu reader + SAI shim, headless, bundle sha ' + require('crypto').createHash('sha256').update(files['/bundle.js']).digest('hex').slice(0, 12) };
  const results = {};
  const po = await b.newPage(), errs = []; po.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
  await po.goto(base + '/ours.html');
  let px = null;
  if (!noXite && fs.existsSync(path.join(XITE_DIR, 'x_ite.min.js'))) { px = await b.newPage(); px.on('pageerror', (e) => errs.push('xite: ' + e.message.slice(0, 160))); await px.goto(base + '/xite.html'); await px.waitForFunction(() => window.X3D && X3D.getBrowser('#c'), null, { timeout: 60000 }).catch(() => {}); env.xite = 'X_ITE ' + (await px.evaluate(() => window.xiteInfo && window.xiteInfo().version).catch(() => '?')) + ' (WebGL2, SwiftShader)'; }
  else env.xite = noXite ? 'skipped (--no-xite)' : 'not found at ' + XITE_DIR;
  const startupErrors = errs.slice();
  let pos = null, pxs = null;
  const mouseFor = async (pg) => { await pg.exposeFunction('__mouse', async (k, x, y) => { if (k === 'move') await pg.mouse.move(x, y, { steps: 6 }); else if (k === 'down') { await pg.mouse.move(x, y); await pg.mouse.down(); } else if (k === 'up') { await pg.mouse.move(x, y, { steps: 6 }); await pg.mouse.up(); } }); };
  // px: the composited colour of one canvas pixel, from a 1 x 1 page screenshot decoded in the page; the same route for both engines
  const pxFor = async (pg) => { await pg.exposeFunction('__shotraw', async () => (await pg.screenshot({ clip: { x: 0, y: 0, width: 320, height: 240 }, type: 'png' })).toString('base64')); return pxFor0(pg); };
  const pxFor0 = async (pg) => pg.exposeFunction('__pxraw', async (x, y) => (await pg.screenshot({ clip: { x, y, width: 1, height: 1 }, type: 'png' })).toString('base64'));
  const keyFor = async (pg) => pg.exposeFunction('__key', async (k, a) => {
    if (k === 'focus') { await pg.evaluate(() => document.getElementById('c').focus()); if (!(await pg.evaluate(() => document.activeElement && document.activeElement.id === 'c'))) await pg.mouse.click(4, 4); }
    else if (k === 'down') await pg.keyboard.down(a); else if (k === 'up') await pg.keyboard.up(a); else if (k === 'press') await pg.keyboard.press(a); else if (k === 'type') await pg.keyboard.type(a);
  });
  async function scenePages(needX) {
    if (!files['/babylon.js']) files['/babylon.js'] = fs.readFileSync(babylon, 'utf8');
    if (!pos) { pos = await b.newPage(); pos.on('pageerror', (e) => errs.push('scene: ' + e.message.slice(0, 200))); await pos.addInitScript(STUB); await mouseFor(pos); await pxFor(pos); await keyFor(pos); await pos.goto(base + '/ours-scene.html'); env.babylon = await pos.evaluate(() => window.sceneReady.then(() => BABYLON.Engine.Version)); }
    if (needX && !pxs && fs.existsSync(path.join(XITE_DIR, 'x_ite.min.js'))) { pxs = await b.newPage(); pxs.on('pageerror', (e) => errs.push('xite scene: ' + e.message.slice(0, 160))); await mouseFor(pxs); await pxFor(pxs); await keyFor(pxs); await pxs.goto(base + '/xite-scene.html'); await pxs.waitForFunction(() => window.X3D && X3D.getBrowser('#c'), null, { timeout: 60000 }).catch(() => {}); }
  }
  for (const n of names) {
    const errorStart = errs.length;
    const fx = path.join(BR, 'fixtures', n + '.x3d'), ts = path.join(BR, 'fixtures', n + '.test.json');
    if (!fs.existsSync(fx) || !fs.existsSync(ts)) { results[n] = { ok: false, msg: 'missing fixture or test spec' }; continue; }
    const xml = fs.readFileSync(fx, 'utf8'), spec = JSON.parse(fs.readFileSync(ts, 'utf8'));
    if (spec.mode && !['events', 'scene'].includes(spec.mode)) throw new Error(n + ': unsupported test mode ' + spec.mode);
    const scene = spec.mode === 'scene';
    if (scene) await scenePages(!noXite && spec.xite !== false);
    const P = scene ? pos : po, PX = noXite || spec.xite === false ? null : scene ? pxs : px, fnO = scene ? 'runScene' : 'runOurs', fnX = scene ? 'runScene' : 'runXite';
    const r = { ok: false, ours: '?', xite: PX ? '?' : spec.xite === false ? 'not applicable (fixture)' : noXite ? 'skipped (--no-xite)' : 'unavailable' };
    try { const o = await P.evaluate(([f, s, x]) => window[f](s, x), [fnO, spec, xml]); r.map = o.map; r.ours = o.ok ? `pass ${o.steps}/${o.steps}` : 'FAIL ' + o.fails.join(' | '); r.oursOk = o.ok; if (o.recorded.length) r.recordedOurs = o.recorded; } catch (e) { r.ours = 'ERROR ' + String(e).slice(0, 200); r.oursOk = false; }
    if (PX && spec.xite !== false) { try { const o = await PX.evaluate(([f, s, x]) => window[f](s, x), [fnX, spec, xml]); r.mapX = o.map; r.xite = o.ok ? `pass ${o.steps}/${o.steps}` : 'FAIL ' + o.fails.join(' | '); r.xiteOk = o.ok; if (o.recorded.length) r.recordedXite = o.recorded; } catch (e) { r.xite = 'ERROR ' + String(e).slice(0, 200); r.xiteOk = false; r.xiteError = true; } }
    if (r.map && r.mapX) for (const [name, tol] of spec.agree || []) {   // recorded values must agree between the engines, relative tol
      const fl = (x) => (Array.isArray(x) ? x.flatMap(fl) : [x]), a = fl(r.map[name]), c = fl(r.mapX[name]), sc = Math.max(1, ...c.map(Math.abs));
      if (!(a.length === c.length && a.every((v, i) => Math.abs(v - c[i]) <= tol * sc))) { r.oursOk = false; r.ours += ` | ${name}: ours ${JSON.stringify(r.map[name])} vs X_ITE ${JSON.stringify(r.mapX[name])} (tol ${tol})`; }
    }
    verdict(r, spec, noXite, startupErrors.concat(errs.slice(errorStart)));
    if (spec.gaps && spec.gaps.length) r.gaps = spec.gaps;
    results[n] = r;
  }
  if (errs.length) env.pageErrors = errs.slice(0, 5);
  const ok = Object.values(results).every((r) => r.ok) && !errs.length;
  console.log(JSON.stringify({ ok, scope: noXite ? 'local-only' : 'reference-comparison', env, results }));
  if (!ok) process.exitCode = 1;
  } finally {
    if (b) await b.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { verdict, RUNNER };
if (require.main === module) main().catch((e) => { console.error(e); console.log(JSON.stringify({ ok: false, error: String(e) })); process.exitCode = 1; });
