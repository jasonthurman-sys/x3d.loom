// node smoke.js FIXTURE.x3d [--babylon babylon.js] -> JSON: the fixture loaded into the real Babylon WebGPU body (SwiftShader), a few seconds of frames, page errors, pixel stats.
// Proves the kit and the bridge nodes live inside the full bundle (reader + wgsl + body + SAI), not only in the headless reader.
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const BR = path.resolve(__dirname, '..'), SRC = path.resolve(BR, '..', 'demo', 'src');
const args = process.argv.slice(2); const bi = args.indexOf('--babylon'); const babylon = bi >= 0 ? args.splice(bi, 2)[1] : (process.env.BABYLON_JS || '/tmp/bb/t/package/babylon.js');
const fixture = args[0], secs = +(args[1] || 3);
const bundle = require('./bundle.js')('body');
const html = `<!doctype html><meta charset=utf-8><body style="margin:0"><canvas id=c width=320 height=240 style="width:320px;height:240px"></canvas><script src="/babylon.js"></script><script src="/bundle.js"></script>`;
(async () => {
  if (!fixture || !Number.isFinite(secs) || secs <= 0) throw new Error('usage: node smoke.js FIXTURE.x3d [seconds>0] [--babylon babylon.js]');
  const { chromium } = require('playwright');
  const xml = fs.readFileSync(fixture, 'utf8');
  const files = { '/bundle.js': bundle, '/babylon.js': fs.readFileSync(babylon, 'utf8'), '/index.html': html };
  const s = http.createServer((q, r) => { const u = q.url.split('?')[0]; if (files[u] === undefined) { r.statusCode = 404; return r.end(); } r.setHeader('content-type', u.endsWith('.js') ? 'text/javascript' : 'text/html'); r.end(files[u]); });
  await new Promise((r) => s.listen(0, r));
  let b;
  try {
  b = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--enable-unsafe-webgpu', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-webgpu-adapter=swiftshader'] });
  const p = await b.newPage(), errs = [], notes = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 200))); p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  await p.addInitScript(() => {   // as the earlier port harnesses do (runs/webgpu-dynasty-20261108/dl-play.js): headless draws into an offscreen texture, frames paced at 600 ms
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 300);
    const o = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, op) { if (t !== 'webgpu') return o.call(this, t, op); const canvas = this;
      const ctx = { _t: null, _d: null, _f: 'bgra8unorm', canvas, configure(c) { this._d = c.device; this._f = c.format; }, unconfigure() {},
        getCurrentTexture() { const w = canvas.width, h = canvas.height; if (!this._t || this._t.width !== w || this._t.height !== h) { this._t = this._d.createTexture({ size: [w, h], format: this._f, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING }); } return this._t; } };
      window.__ctx = ctx; return ctx; };
  });
  await p.goto('http://localhost:' + s.address().port + '/index.html');
  const res = await p.evaluate(async ([xml, secs]) => {
    const body = new Body(document.getElementById('c'), { onNote: (m) => (window.__notes = window.__notes || []).push(m) });
    await body.init(); X3DSAI.setBody(body);
    const sc = await X3DSAI.B.createX3DFromString(xml); await X3DSAI.B.replaceWorld(sc);
    const t0 = performance.now(); const seen = {}; 
    for (const n of sc._world.nodes) if (n.def) for (const f of Object.keys(__R.fdefsOf(n))) { const k = n.def + '.' + f; if (__R.fdefsOf(n)[f][1] === 'out' || __R.fdefsOf(n)[f][1] === 'io') { (n.cbs ||= {})[f] = (n.cbs[f] || new Map()); n.cbs[f].set('smoke', () => { seen[k] = (seen[k] || 0) + 1; }); } }
    await new Promise((r) => setTimeout(r, secs * 1000));
    const cv = document.getElementById('c'); const frames = body.stats.frames;
    return { frames, adapter: body.adapterInfo, babylon: BABYLON.Engine.Version, notes: window.__notes || [], warnings: sc._world.warnings, events: seen, switches: sc._world.nodes.filter((n) => n.type === 'Switch').map((n) => n.f.whichChoice) };
  }, [xml, secs]);
  if (process.env.SMOKE_PNG) await p.screenshot({ path: process.env.SMOKE_PNG, clip: { x: 0, y: 0, width: 320, height: 240 } });
  res.pageErrors = errs.slice(0, 6); res.bundle = crypto.createHash('sha256').update(bundle).digest('hex').slice(0, 12);
  res.ok = res.frames > 0 && !errs.length;
  console.log(JSON.stringify(res));
  if (!res.ok) process.exitCode = 1;
  } finally {
    if (b) await b.close();
    await new Promise((resolve) => s.close(resolve));
  }
})().catch((e) => { console.error(e); console.log(JSON.stringify({ ok: false, error: String(e) })); process.exitCode = 1; });
