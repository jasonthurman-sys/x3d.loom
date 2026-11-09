// The bundles the test tools run: "reader" (reader + SAI, no Babylon) and "body" (adds wgsl, body, body-cam and the kit's Babylon side). Same concatenation the page builders use, plus the kit and every src/nodes/*.js.
const fs = require('fs'), path = require('path');
const BR = path.resolve(__dirname, '..'), SRC = path.resolve(BR, '..', 'demo', 'src');
const READER = ['shared/adapter.js', 'brain/reader.js', 'gobbler/reader-ext.js', 'demiurge/reader-ext-dm.js', 'dynasty/reader-ext-dl.js', 'hall/reader-ext-hl.js'];
const rd = (p) => fs.readFileSync(path.join(SRC, p), 'utf8'), own = (p) => fs.readFileSync(path.join(BR, p), 'utf8');
module.exports = function bundle(kind) {
  if (!['reader', 'body'].includes(kind)) throw new Error('unknown bundle kind: ' + kind);
  const nodes = fs.readdirSync(path.join(BR, 'src', 'nodes')).filter((f) => f.endsWith('.js')).sort().map((f) => own('src/nodes/' + f));
  const reader = READER.filter((p) => fs.existsSync(path.join(SRC, p)) && (kind === 'body' || p !== 'shared/adapter.js')).map(rd);
  const catalog = Object.fromEntries(Object.entries(JSON.parse(own('NODES.json')).nodes).map(([name, n]) => [name, { status: n.status, note: n.note || '' }]));
  const parts = [...reader, own('src/kit.js'), ...nodes, own('src/fidelity.js'), 'R.bridge.fidelityCatalog = ' + JSON.stringify(catalog) + ';', ...(kind === 'body' ? [rd('brain/wgsl.js'), rd('brain/body.js'), rd('brain/body-cam.js'), own('src/body-br.js')] : []), rd('brain/sai.js'),
    'window.__R = R; window.__events = events; window.__bridge = R.bridge; window.__worlds = R.bridge.worlds;' + (kind === 'body' ? ' window.Body = Body;' : '')];
  return '(function () {\n"use strict";\n' + parts.join('\n') + '\n})();\n';
};
