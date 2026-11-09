// These tests exercise validation decisions without a browser, Babylon, or X_ITE installation.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { verdict, RUNNER } = require('./run-tests.js');

test('missing X_ITE fails a required reference comparison', () => {
  const r = verdict({ oursOk: true }, {}, false);
  assert.equal(r.ok, false);
  assert.equal(r.comparison, 'unavailable');
  assert.match(r.msg, /X_ITE required/);
});

test('explicit local-only and fixture exemptions remain distinguishable', () => {
  const local = verdict({ oursOk: true }, {}, true);
  assert.equal(local.ok, true);
  assert.equal(local.comparison, 'skipped');
  const exempt = verdict({ oursOk: true }, { xite: false }, false);
  assert.equal(exempt.ok, true);
  assert.equal(exempt.comparison, 'not-applicable');
});

test('a reference disagreement needs a documented reason and an executed test', () => {
  assert.equal(verdict({ oursOk: true, xiteOk: false }, {}, false).ok, false);
  assert.equal(verdict({ oursOk: true, xiteOk: false }, { xiteDisagrees: true }, false).ok, false);
  assert.equal(verdict({ oursOk: true, xiteOk: false }, { xiteDisagrees: 'spec clause differs' }, false).ok, true);
  assert.equal(verdict({ oursOk: true, xiteOk: false, xiteError: true }, { xiteDisagrees: 'spec clause differs' }, false).ok, false);
  assert.equal(verdict({ oursOk: true }, { xiteDisagrees: 'spec clause differs' }, false).ok, false);
});

test('browser errors fail otherwise passing assertions', () => {
  const r = verdict({ oursOk: true, xiteOk: true }, {}, false, ['uncaught event handler exception']);
  assert.equal(r.ok, false);
  assert.equal(r.pageErrors.length, 1);
  assert.equal(verdict({ oursOk: false, xiteOk: true }, {}, false).ok, false);
  assert.equal(verdict({ oursOk: true, xiteOk: true }, {}, false).ok, true);
});

test('the shared spec runner rejects unknown steps and empty specs', async () => {
  const context = vm.createContext({ window: { X3D: {} } });
  vm.runInContext(RUNNER, context);
  const eng = { name: 'ours', open: async () => ({ getNamedNode() {} }) };
  const unknown = await context.runSpec(eng, { steps: [{ exepct: ['N', 'value', 1] }] }, '<X3D/>');
  assert.equal(unknown.ok, false);
  assert.match(unknown.fails[0], /unknown or empty/);
  await assert.rejects(context.runSpec(eng, { steps: [] }, '<X3D/>'), /at least one step/);
});

test('CLI setup failures return nonzero and structured JSON', () => {
  const p = spawnSync(process.execPath, [path.join(__dirname, 'run-tests.js')], { encoding: 'utf8' });
  assert.equal(p.status, 1);
  assert.equal(JSON.parse(p.stdout.trim()).ok, false);
});

test('a failed regression gate cannot close previously unreported nodes', (t) => {
  const probe = spawnSync('python3', ['-c', 'import lxml'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('Python 3 + lxml required for driver regression');
  const source = `
import importlib.util, types
s = importlib.util.spec_from_file_location('bridge_driver', ${JSON.stringify(path.join(__dirname, 'driver.py'))})
d = importlib.util.module_from_spec(s); s.loader.exec_module(d)
state = {'nodes': {'N': {'status': 'bridged', 'batch': None, 'rank': 1}}}
d.load = lambda: state
d.save = lambda _: None
d.cmd_check = lambda a, names: {n: {'pass': True, 'test': {}} for n in names}
d.regression_gate = lambda _: {'ok': False}
d.write_report = lambda *a, **k: (_ for _ in ()).throw(AssertionError('failed gate wrote a batch report'))
a = types.SimpleNamespace(n=1, close=True, no_xite=False)
assert d.cmd_batch(a) is False
assert state['nodes']['N']['batch'] is None
a.no_xite = True
try: d.cmd_batch(a)
except SystemExit as e: assert 'requires X_ITE' in str(e)
else: raise AssertionError('local-only run promoted a batch')
`;
  const p = spawnSync('python3', ['-c', source], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stdout + p.stderr);
});

test('pending nodes are rechecked before closing, even when the shared gate passes', (t) => {
  const probe = spawnSync('python3', ['-c', 'import lxml'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('Python 3 + lxml required for driver regression');
  const source = `
import importlib.util, types
s = importlib.util.spec_from_file_location('bridge_driver', ${JSON.stringify(path.join(__dirname, 'driver.py'))})
d = importlib.util.module_from_spec(s); s.loader.exec_module(d)
state = {'nodes': {'N': {'status': 'bridged', 'batch': None, 'rank': 1}}}
d.load = lambda: state
d.save = lambda _: None
seen = []
def recheck(a, names):
 seen.extend(names)
 return {n: {'pass': False, 'test': {}} for n in names}
d.cmd_check = recheck
d.regression_gate = lambda _: {'ok': True}
d.write_report = lambda *a, **k: (_ for _ in ()).throw(AssertionError('failed recheck wrote a batch report'))
assert d.cmd_batch(types.SimpleNamespace(n=1, close=True, no_xite=False)) is False
assert seen == ['N']
assert state['nodes']['N']['batch'] is None
assert state['nodes']['N']['status'] == 'wip'
`;
  const p = spawnSync('python3', ['-c', source], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stdout + p.stderr);
});
