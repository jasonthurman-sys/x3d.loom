// Reuse the existing fixture assertions against the real reader/SAI in a Node
// VM. These checks establish local event behavior, not X_ITE or pixel parity.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const fs = require('node:fs'), path = require('node:path');
const { loadReader } = require('./test-dom'), { RUNNER } = require('./run-tests');
for (const name of ['BooleanToggle', 'BooleanTrigger', 'IntegerTrigger', 'TimeTrigger', 'PositionInterpolator2D', 'NormalInterpolator', 'SplinePositionInterpolator', 'EaseInEaseOut', '_route-chain']) {
  test('existing local event fixture: ' + name, async () => {
    const { R, X3DSAI, sandbox } = loadReader();
    vm.runInContext(RUNNER, sandbox);
    const dir = path.join(__dirname, '..', 'fixtures');
    const spec = JSON.parse(fs.readFileSync(path.join(dir, name + '.test.json'), 'utf8'));
    const xml = fs.readFileSync(path.join(dir, name + '.x3d'), 'utf8');
    let ts = Date.now() / 1000;
    const result = await sandbox.runSpec({ name: 'ours',
      open: (x) => X3DSAI.B.createX3DFromString(x),
      apply: (fn) => { R.events.begin(ts += 0.05); fn(); R.events.drain(); },
      settle: (dt) => {
        for (let i = 0, n = Math.max(1, Math.round((dt || 0.05) / 0.05)); i < n; i++) {
          R.events.begin(ts += 0.05);
          for (const w of R.bridge.worlds) for (const node of w.nodes) if (node.type === 'TimeSensor') R.tickTimeSensor(node, ts);
          R.events.drain();
        }
      },
    }, spec, xml);
    assert.ok(result.ok, result.fails.join('\n'));
  });
}
