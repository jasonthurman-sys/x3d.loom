# X3D → Babylon.js bridge assessment

Assessed repository: `hagopjay/x3d.loom`, baseline **6b3cb769a298b42e591be30f30df5547bb133eb0**. Assessment date: 8 November 2026, America/New_York. The review includes the twenty bridge batches and the latest demo/screenshot tooling through `d412d41`. All source locations below refer to that baseline unless described as changes in this patch.

## Verdict and agreed target

This is a worthwhile experimental X3D runtime with a Babylon rendering body. Its strongest assets are the renderer-independent event machinery, generated field tables, per-node fixtures, explicit historical gap notes, and runnable comparison framework. Preserve them. It is not yet a general, fidelity-assured X3D importer: recognizing a node, passing a field test, and drawing that node correctly are different achievements.

The owner's screening answers set the direction: benefit the X3D ecosystem; establish X3D → Babylon.js first; render supported content while explicitly reporting approximations and omissions. The next milestone should be a trustworthy, bounded import capability, with scene-level evidence. Expanding the headline node count should follow repairs to shared identity, geometry semantics and validation gates.

This patch repairs demonstrated runtime/tooling defects and makes known limits inspectable. It does not claim to complete the renderer, implement reverse conversion, or establish new pixel-parity/performance results.

## What the code actually contains

| Layer | Current implementation | Value and constraint |
|---|---|---|
| Field and XML reader | `demo/src/brain/reader.js`, port-specific reader extensions | Typed fields, shared DEF/USE node objects, ROUTE checking; primarily a custom XML reader |
| Runtime | Reader event queue, `bridge/src/kit.js`, `bridge/src/nodes/*.js` | Time-based behaviors and per-node registration; this is the reusable X3D core |
| Scene access | `demo/src/brain/sai.js` | Useful X_ITE-shaped subset; not the complete standardized SAI |
| Babylon body | `brain/body.js`, `brain/body-cam.js`, `bridge/src/body-br.js`, port extensions | Retained meshes/materials/cameras plus specialized shader ports; semantic gaps remain |
| Evidence | Fixtures, test specs, receipts, batch reports, tracker | Rich starting corpus; the historical pass status needs its exact test scope and rig |
| Delivery | Concatenated scripts and individual Python page builders | Works as a demo integration pattern; not yet the general TypeScript SceneLoader package proposed in `BABYLON.md` |

## Coverage: separate the denominators

Recomputed from `NODES.json`, the 100 node modules, and execution of the canonical `tools/bundle.js('reader')` registration code:

| Measure at the reviewed baseline | Count | Meaning |
|---|---:|---|
| X3D 4.0 concrete names in tracker | 260 | Census denominator; includes ProtoInstance syntax |
| Baseline reader names in aggregate tracker | 75 | Aggregate of several port extensions, not one shipped bundle |
| New bridge modules | 100 | 24 `bridged`, 76 `gap` |
| Tracker headline | 175 / 260 | 75 baseline + 100 modules; not a rendering conformance percentage |
| Other tracker states | 76 todo, 8 claimed, 1 blocked | No new status promotion in this patch |
| Actual canonical test-bundle registrations | 180 | 176 names in the 4.0 tracker plus 4 outside it |

The canonical bundle omits seven tracker-baseline names: **ElevationGrid, MetadataDouble, MetadataInteger, MetadataSet, PolylineEmitter, TextureProperties, TriangleSet**. It includes all eight names still marked claimed through the hall extension: Collision, CoordinateInterpolator, CoordinateInterpolator2D, Disk2D, Extrusion, MultiTextureCoordinate, PointProperties and Rectangle2D. Hence `175 − 7 + 8 = 176`. The four names outside the 4.0 tracker are BlendMode, DepthMode, EnvironmentLight and GaussianSplats; this grouping does not imply they all have the same standards status.

Do not silently rewrite historical receipts or promote these claims from registration alone. Audit the actual bundle used by each page. The older README statement that the page builders do not generally include the kit remains important: fixing the canonical validation bundle does not automatically add the kit or fidelity reports to every demo builder.

## Findings, in priority order

| Priority | Evidence and failure | Patch treatment |
|---|---|---|
| P0 | `tools/run-tests.js` accepted `r.xiteOk !== false`, so an unavailable X_ITE could count as success; fatal errors exited 0. Browser errors were only listed. | Required comparisons fail when unavailable; explicit local-only scope; nonzero failures; page-error handling and tests. |
| P0 | `tools/driver.py` could close previously unreported work even when the current regression gate failed. | Gate failure and local-only runs cannot close/promote a batch. Historical tracker remains unchanged. |
| P1 | `brain/reader.js` assigned IDs from `ctx.nodes.length`; different parsed scenes reused IDs while event suppression used `id.field`. | One numeric allocator for parsed, SAI-created and hall/drift-generated nodes. Same-timestamp outputs from different scenes no longer suppress one another. |
| P1 | `kit.js` captured the lexical `parseX3D`, bypassing the hall wrapper installed on `R.parseX3D`. Disk2D/Rectangle2D/Extrusion could be recognized but miss their conversion step. | Preserve the registered parser chain; a regression verifies generated geometry and unique IDs. |
| P1 | Every parsed world joins `BR.worlds` and ticker nodes join `BR.tickers`, without a release API. | Explicit scene disposal removes runtime ownership and guards active/adopted nodes. Automatic activation semantics and complete media teardown remain future work. |
| P1 | `Body.buildGroup()` / Shape builds overwrite `this.rec` by shared logical node ID. `changed()` retrieves one record. | Report dynamic DEF/USE occurrence risk. Renderer occurrence bookkeeping remains to be repaired. |
| P1 | `Body.applyTransform()` constructs the full transform matrix, then decomposes it and explicitly drops shear. | Report rotated nonuniform-scale risk. Preserve the full matrix or introduce an equivalent transform-node chain in a later patch. |
| P1 | `Body.geometryData()` fans every IndexedFaceSet polygon and does not fully implement supplied normal indices, creaseAngle, per-face colors or default UV rules. | Report IndexedFaceSet fidelity limits. Robust triangulation and independent corner indexing remain open. |
| P1 | Reader parses Scene content while nondefault `head/unit` declarations are ignored. | Structured unit-conversion diagnostic; numeric conversion is not implemented here. |
| P2 | ColorRGBA alpha is discarded by some geometry/material paths; TextureCoordinateGenerator uses object-space approximations for camera/reflection modes. | Explicit diagnostics; targeted rendering regressions required before claiming fidelity. |
| P2 | Shader containers can parse while never becoming valid; ComposedShader rendering relies on known hand ports. | Keep tracked gaps and warn about the shader-port requirement. Do not describe arbitrary GLSL import as implemented. |

The DEF/USE issue is particularly important for X3D: the reader correctly preserves a shared node object, but the renderer needs **one logical identity → multiple rendered occurrences**. Store occurrence collections with parent/path context. A single map record cannot represent a shared Transform appearing beneath multiple parents. Test both initial placement and later ROUTE/SAI changes.

Two bounded reproductions clarify the evidence. The baseline reader/SAI assigned two imported ScalarInterpolators IDs `[0, 0]`; simultaneous outputs produced callback values `[[2.5], []]`. The patched runtime assigns `[0, 1]` and produces `[[2.5], [7.5]]`. Separately, actual Body methods exercised with minimal Babylon TransformNode stubs produced shared Transform occurrence translations `[0, 2]` after a requested translation of 2, where both should be `[2, 2]`. The latter is a renderer-bookkeeping reproduction, not a pixel/GPU test, and remains open.

The transform issue cannot be solved by discarding `scaleOrientation` or by applying a single root scale. X3D requires `T * C * R * SR * S * inverse(SR) * inverse(C)`. Nonuniform scaling and rotated axes can require shear. Angle units also affect rotations and other angle-valued fields; length-unit conversion alone is insufficient.

## What changed in this patch

1. Validation distinguishes reference comparisons, explicit local-only runs, fixture exemptions, unavailable engines and actual failures. Unknown/empty assertion specs fail; smoke requires frames and no captured errors. Smoke and fixture tests use the same canonical body bundle.
2. The reader allocates IDs across execution contexts, including generated geometry and SAI-created nodes. Drift no longer renumbers entire scenes with a fixed offset.
3. Parser wrappers are composed through the current registered parser, preserving hall conversion.
4. `scene.dispose()` / `R.bridge.disposeWorld(world)` release unused runtime contexts; optional node `dispose` hooks provide a cleanup seam. Current or adopted active roots cannot be disposed. Reuse of disposed scenes is rejected.
5. `bridge/src/fidelity.js` adds preflight diagnostics and attaches a report to imports through the canonical bundle. The bundle embeds a status/note snapshot generated directly from the tracker.
6. Dependency-free Node regressions exercise the real reader/SAI with Python ElementTree providing test-only XML DOM objects. Existing event fixture assertions are reused, including `_route-chain`. Pinned Playwright setup supports later browser comparisons.

The reader and preflight also reject inherited JavaScript object-property names as declared nodes/fields; `<constructor/>` is no longer misidentified as a registered X3D capability.

Disposal is explicit because a detached scene may later donate nodes to the current scene. Replacing a scene does not automatically destroy retained execution contexts. The current model still lacks complete active/inactive execution-context ownership; asynchronous audio/video/network work requires per-node cleanup. A disposed scene's report remains readable for diagnostics.

## Using the fidelity report

Inside a host that includes the bridge kit, fidelity module and catalog:

```js
const scene = await X3DSAI.B.createX3DFromString(xml, baseUrl);
const report = scene.getFidelityReport();
console.table(report.types);
console.table(report.diagnostics);
```

The runtime also exposes `R.bridge.inspect(xml)` for preflight without starting scripts, tickers, resource loads or Babylon rendering, and `R.bridge.capabilities()` for the currently registered reader names. `R` is bundle-internal unless the host exposes it; the validation bundles expose it as `window.__R` for instrumentation.

Reports include node occurrence counts, actual bundle recognition, historical tracker status, known-gap/unverified fidelity, parser warnings, and diagnostics for known semantic risks. Recognized descendants inside an unrecognized subtree are identified because the reader drops the parent subtree. No-diagnostic results still say `conformance: 'not-assessed'` and `rendering: 'not-assessed'`. Preflight is not schema validation, a complete PROTO/ROUTE analyzer, a guarantee that recognized descendants will render, or a general conformance certificate.

The default adds an extra XML pass. Hosts can opt out with `R.bridge.fidelityEnabled = false` after measuring very large scenes, and perform preflight explicitly instead. A host showing the report should retain the distinction between an omitted feature, an approximation and unverified behavior. Add a JSON export and a compact scene import summary before pursuing new supported-node claims.

## Bounded next integration path

| Order | Deliverable | Acceptance gate |
|---|---|---|
| 1 | Apply these validation/runtime repairs and run the pinned rig | Local regressions pass; required X_ITE comparison and Babylon smoke run on a permitted machine; receipt names exact source/bundle/engine versions |
| 2 | Repair rendered occurrence tracking for DEF/USE | One shared Transform under two parents changes both occurrences after ROUTE input; Shape and Switch cases also pass |
| 3 | Finish a declared mesh subset | Concave polygon triangulation, explicit independent normal/color/UV indices, crease-angle boundary and vertex alpha fixtures; geometry invariants plus rendered probes |
| 4 | Preserve transforms and units | Transformed basis points agree for rotated nonuniform scale, center, nesting and negative determinant; length/angle unit fixtures either convert or remain explicitly unsupported |
| 5 | Give every page a reproducible capability manifest | Builder lists its exact reader/body/extensions; the reported type set comes from that bundle; no cross-port aggregate claims |
| 6 | Extract a small runtime package and Babylon binding | Stable node/field/event interfaces, explicit lifecycle, asynchronous resource completion and a tested loader API; TypeScript/SceneLoader can then wrap a trustworthy subset |

For each capability, track parser acceptance, retained fields, events, geometry, rendered probes and known gaps separately. A passing field test should fill its own evidence cell; it should not fill the rendering cell. Maintain spec citations for X_ITE disagreements: X_ITE is a valuable comparison implementation, while the standard defines the required semantics.

For the X3D ecosystem this path provides a second rendering backend, a reusable scene-analysis/runtime layer, test cases that other engines can consume, and measurable portability of existing X3D assets without converting away ROUTEs or shared identity. Reverse export and synchronized dual-engine scenes should follow stable import semantics and explicit source-to-render occurrence mapping.

## Validation and limits of this assessment

The added local suite passed **31/31** checks: 8 tooling, 8 fidelity, 6 lifecycle and 9 reused event fixtures. It runs with Node and Python and does not require a GPU. The XML adapter uses ElementTree and is deliberately limited to the DOM operations needed by these tests; it does not validate browser DOM behavior or prototype XML rewriting.

Both generated JavaScript bundles and modified source files are syntax-checked; the driver is Python-compiled; whitespace and patch applicability are checked. The final delivered assessment records the exact local pass count in its companion evidence JSON.

A pinned Babylon 9.32.0 distribution, X_ITE 16.6.0 distribution and Chromium executable were obtained for a comparison attempt. The host denied Chromium's process-singleton `socket()` operation at launch. Thus **no new X_ITE comparison, Babylon/WebGPU rendering, screenshot parity or performance result is claimed**. The runner correctly returned failure for that attempt. Historical receipts retain their original rig and are not represented as fresh measurements.

## Standards and source references

- [Reviewed repository baseline](https://github.com/hagopjay/x3d.loom/tree/6b3cb769a298b42e591be30f30df5547bb133eb0/x3d.webgpu).
- [X3D 4.0 concepts](https://www.web3d.org/documents/specifications/19775-1/V4.0/Part01/concepts.html): units/coordinates, shared nodes and event cascades.
- [X3D 4.0 Transform](https://www.web3d.org/documents/specifications/19775-1/V4.0/Part01/components/grouping.html#Transform): full transform composition.
- [X3D 4.0 IndexedFaceSet](https://www.web3d.org/documents/specifications/19775-1/V4.0/Part01/components/geometry3D.html#IndexedFaceSet): independent indices, normal generation, convexity and default texture coordinates.
- [X3D 4.0 Shape component](https://www.web3d.org/documents/specifications/19775-1/V4.0/Part01/components/shape.html): material semantics.
- [Babylon Scene API](https://doc.babylonjs.com/typedoc/classes/BABYLON.Scene#userighthandedsystem): right-handed scene mode, which this body already enables.

Official specification pages were retrieved during this review. Findings about this implementation come from the checked-out source and the stated local tests, not from treating the planning documents as proof of completed functionality.
