/* Import preflight, not an X3D validator or a rendering-conformance verdict.
   Keep recognition separate from fidelity. The bundle supplies a snapshot of
   NODES.json; the active DEFS table, not that tracker, decides recognition. */
BR.capabilities = () => ({
  schemaVersion: 1,
  scope: 'reader-recognition-only',
  registeredTypes: Object.keys(DEFS).sort(),
});

BR.inspect = function (text, options = {}) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Fidelity preflight: invalid XML');
  const root = doc.documentElement;
  if (!root || root.nodeName !== 'X3D') throw new Error('Fidelity preflight: expected X3D root');
  const scene = Array.from(root.children).find((e) => e.nodeName === 'Scene');
  if (!scene) throw new Error('Fidelity preflight: expected Scene');
  const catalog = options.catalog || BR.fidelityCatalog || {};
  const report = { schemaVersion: 1, scope: 'import-preflight',
    conformance: 'not-assessed', rendering: 'not-assessed',
    counts: { occurrences: 0, recognized: 0, unrecognized: 0 },
    types: [], diagnostics: [], parserWarnings: [] };
  const types = new Map(), emitted = new Set(), defs = new Map();
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const structural = new Set(['ROUTE', 'ProtoDeclare', 'ProtoInterface', 'ProtoBody', 'ExternProtoDeclare', 'IS', 'connect', 'field', 'fieldValue']);
  const add = (code, nodeType, message, detail = {}) => {
    const key = code + ':' + nodeType + ':' + (detail.field || '');
    if (emitted.has(key)) return;
    emitted.add(key);
    report.diagnostics.push({ code, severity: 'warning', nodeType, message, ...detail });
  };
  const list = (e, name, d) => e.hasAttribute(name) ? numList(e.getAttribute(name)) : d;
  const visit = (e, dropped) => {
    const type = e.nodeName, language = structural.has(type), known = own(DEFS, type);
    const tracked = own(catalog, type) ? catalog[type] : null;
    if (!language) {
      report.counts.occurrences++;
      report.counts[known ? 'recognized' : 'unrecognized']++;
      if (!types.has(type)) types.set(type, { type, occurrences: 0, recognized: known,
        trackerStatus: tracked ? tracked.status : 'untracked',
        fidelity: tracked && tracked.status === 'gap' ? 'known-gap' : 'unverified',
        insideUnrecognizedSubtree: 0 });
      const row = types.get(type); row.occurrences++;
      if (dropped) row.insideUnrecognizedSubtree++;
      if (!known) add('unrecognized-node', type, 'Not registered in this bundle; the reader skips this node and its subtree.');
      if (known && tracked && tracked.status === 'gap')
        add('tracked-gap', type, tracked.note || 'The tracker records incomplete behavior or fidelity.');
      if (e.hasAttribute('DEF')) defs.set(e.getAttribute('DEF'), type);
      const useType = e.hasAttribute('USE') && defs.get(e.getAttribute('USE'));
      if (useType && ['Transform', 'Shape', 'Switch'].includes(useType))
        add('shared-render-occurrences', useType, 'The body retains one render record per shared node; updates can miss earlier USE occurrences.');
      if (known && !['Script', 'ComposedShader', 'ProtoInstance'].includes(type)) {
        for (const a of e.attributes) if (!SKIP_ATTR.has(a.name) && !a.name.includes(':') && !own(DEFS[type], a.name))
          add('unrecognized-field', type, 'The reader ignores this field.', { field: a.name });
      }
      if (type === 'Transform') {
        const s = list(e, 'scale', [1, 1, 1]), sr = list(e, 'scaleOrientation', [0, 0, 1, 0]);
        if (sr[3] && (s[0] !== s[1] || s[1] !== s[2])) add('transform-shear', type,
          'Rotated nonuniform scale may introduce shear; the Babylon body decomposes the matrix and drops shear.');
      }
      if (type === 'IndexedFaceSet') add('indexed-face-set-fidelity', type,
        'The body uses fan triangulation and incomplete normal, color-index and UV rules; field recognition does not establish mesh fidelity.');
      if (type === 'ColorRGBA') add('vertex-alpha', type,
        'Some geometry/material paths replace vertex alpha with one; transparency requires rendering validation.');
      if (type === 'TextureCoordinateGenerator') add('generated-uv', type,
        'Camera and reflection modes use an object-space approximation in the bridge body.');
      if (type === 'ComposedShader') add('shader-port-required', type,
        'Only explicitly ported shader programs can render; arbitrary X3D GLSL is not a general import path.');
      if (type === 'Script' && BR.allowScripts !== true) add('scripts-disabled', type,
        'Scene scripts are disabled unless the host explicitly enables them.');
      if (type === 'ProtoInstance') add('prototype-preflight', type,
        'This source census does not prove expanded prototype fidelity.');
    } else if (type === 'ProtoDeclare' || type === 'ExternProtoDeclare' || type === 'ProtoInstance') {
      add('prototype-preflight', type, 'This source census does not prove expanded prototype fidelity or external prototype loading.');
    }
    for (const c of e.children) visit(c, dropped || (!known && !language));
  };
  for (const e of scene.children) visit(e, false);
  for (const e of root.getElementsByTagName('unit')) {
    if (Number(e.getAttribute('conversionFactor')) !== 1) add('unit-conversion', 'unit',
      'The reader does not apply nondefault unit declarations.', { field: e.getAttribute('category'), conversionFactor: e.getAttribute('conversionFactor') });
  }
  report.types = Array.from(types.values()).sort((a, b) => a.type.localeCompare(b.type));
  report.summary = report.diagnostics.length ? 'limitations-reported' : 'no-known-limitations-detected';
  return report;
};

// Attach the report to every import made through this bundle, without changing
// permissive rendering. No Script, fetch, tick or Babylon operation runs during
// preflight. Hosts may disable the extra XML pass for measured large-file needs.
{
  const parse = parseX3D;
  parseX3D = function (text) {
    const report = BR.fidelityEnabled === false ? null : BR.inspect(text);
    const world = parse(text);
    if (report) {
      report.parserWarnings = world.warnings.slice();
      if (report.parserWarnings.length) report.summary = 'limitations-reported';
      world.fidelity = report;
    }
    return world;
  };
  R.parseX3D = parseX3D;
}
