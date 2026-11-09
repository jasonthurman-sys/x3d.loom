const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { DOMParser } = require('./test-dom');
const bundle = require('./bundle');
function runtime() {
  const c = { window: {}, document: { getElementById() { return null; } }, DOMParser, console };
  vm.createContext(c); vm.runInContext(bundle('reader'), c);
  return c.window.__R;
}
const xml = (s, head = '') => `<X3D version="4.0"><head>${head}</head><Scene>${s}</Scene></X3D>`;
test('capabilities reflect the actual bundle, never the aggregate tracker', () => {
  const R = runtime(), c = R.bridge.capabilities();
  assert.equal(c.scope, 'reader-recognition-only');
  assert.ok(c.registeredTypes.includes('CoordinateInterpolator'));
  assert.ok(!c.registeredTypes.includes('ElevationGrid'));
  const r = R.bridge.inspect(xml('<ElevationGrid/>'));
  assert.equal(r.types[0].recognized, false);
  assert.equal(r.types[0].trackerStatus, 'base');
  assert.ok(r.diagnostics.some((d) => d.code === 'unrecognized-node'));
});
test('known fields and passing tracker entries do not imply fidelity', () => {
  const R = runtime(), r = R.bridge.inspect(xml('<BooleanToggle/><ShaderProgram/>'));
  assert.equal(r.types.find((t) => t.type === 'BooleanToggle').fidelity, 'unverified');
  assert.equal(r.types.find((t) => t.type === 'ShaderProgram').fidelity, 'known-gap');
  assert.ok(r.diagnostics.some((d) => d.code === 'tracked-gap' && d.nodeType === 'ShaderProgram'));
  assert.equal(r.rendering, 'not-assessed'); assert.equal(r.conformance, 'not-assessed');
});
test('inherited JavaScript object properties are not declared X3D capabilities', () => {
  const r = runtime().bridge.inspect(xml('<constructor/><Transform toString="x"/>'));
  assert.equal(r.types.find((t) => t.type === 'constructor').recognized, false);
  assert.equal(r.types.find((t) => t.type === 'constructor').trackerStatus, 'untracked');
  assert.ok(r.diagnostics.some((d) => d.code === 'unrecognized-field' && d.field === 'toString'));
});
test('unknown parents expose recognized descendants that will also be dropped', () => {
  const r = runtime().bridge.inspect(xml('<UnknownGroup><Shape><Box/></Shape></UnknownGroup>'));
  assert.equal(r.counts.occurrences, 3);
  assert.equal(r.types.find((t) => t.type === 'Box').insideUnrecognizedSubtree, 1);
});
test('nondefault units, shear, shared occurrences, mesh and field gaps are explicit', () => {
  const r = runtime().bridge.inspect(xml('<Transform DEF="T" scale="2 1 1" scaleOrientation="0 0 1 .7"/><Transform USE="T"/><Shape><IndexedFaceSet bogus="1"/></Shape>', '<unit category="length" name="centimetre" conversionFactor="0.01"/>'));
  for (const code of ['unit-conversion', 'transform-shear', 'shared-render-occurrences', 'indexed-face-set-fidelity', 'unrecognized-field'])
    assert.ok(r.diagnostics.some((d) => d.code === code), code);
});
test('preflight does not parse a runtime world or enable scripts', () => {
  const R = runtime();
  const r = R.bridge.inspect(xml('<Script DEF="S"/>'));
  assert.equal(R.bridge.worlds.length, 0);
  assert.notEqual(R.bridge.allowScripts, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'scripts-disabled'));
});
test('every canonical import carries diagnostics and original reader warnings', () => {
  const R = runtime(), world = R.parseX3D(xml('<Unknown/>'));
  assert.equal(world.fidelity.scope, 'import-preflight');
  assert.ok(world.fidelity.parserWarnings.some((w) => w.includes('Unknown')));
  assert.equal(world.fidelity.counts.unrecognized, 1);
});
test('malformed input fails before world registration; optional extra pass can be disabled', () => {
  const R = runtime();
  assert.throws(() => R.parseX3D('<X3D>'), /invalid XML/);
  assert.equal(R.bridge.worlds.length, 0);
  R.bridge.fidelityEnabled = false;
  assert.equal(R.parseX3D(xml('<Box/>')).fidelity, undefined);
});
