// Test-only XML DOM adapter using the repository's Python prerequisite.
// ElementTree parses XML; this does not attempt to reimplement XML in JavaScript.
const { spawnSync } = require('node:child_process');
class Element {
  constructor(data) {
    this.nodeName = data.name;
    this.attributes = Object.entries(data.attrs).map(([name, value]) => ({ name, value }));
    this.children = data.children.map((c) => new Element(c));
    this.textContent = data.text;
  }
  getAttribute(name) { return this.attributes.find((a) => a.name === name)?.value ?? null; }
  hasAttribute(name) { return this.attributes.some((a) => a.name === name); }
  getElementsByTagName(name) { return this.children.flatMap((c) => [...(c.nodeName === name ? [c] : []), ...c.getElementsByTagName(name)]); }
}
class DOMParser {
  parseFromString(xml) {
    const p = spawnSync('python3', ['-c', `import sys,json,xml.etree.ElementTree as ET
def tree(e):
 return dict(name=e.tag,attrs=e.attrib,text=''.join(e.itertext()),children=[tree(c) for c in e])
try: print(json.dumps(tree(ET.fromstring(sys.stdin.read()))))
except ET.ParseError as e: print(json.dumps(dict(name='parsererror',attrs={},text=str(e),children=[])))
`], { input: xml, encoding: 'utf8' });
    if (p.error || p.status) throw p.error || new Error(p.stderr);
    const root = new Element(JSON.parse(p.stdout));
    return { documentElement: root,
      getElementsByTagName: (name) => [...(root.nodeName === name ? [root] : []), ...root.getElementsByTagName(name)] };
  }
}
function loadReader(code) {
  const vm = require('node:vm');
  const sandbox = { DOMParser, console, location: { href: 'https://example.invalid/test/' },
    performance: require('node:perf_hooks').performance, setTimeout, clearTimeout,
    document: { getElementById() { return null; } } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code || require('./bundle')('reader'), sandbox);
  return { R: sandbox.__R, X3DSAI: sandbox.X3DSAI, sandbox };
}
module.exports = { DOMParser, loadReader };
