# three.js (vendored)

Version: **three@0.187.0** (npm registry, `npm pack three@0.187.0`), MIT License (see `LICENSE`).

Used only by the in-app 3D viewer (`app/js/ui/model-viewer.js`), loaded on demand
when a 3D result is opened. Served by the app server itself, so it works over the
tailnet, offline and inside the Android WebView. No CDN.

Files, copied unchanged from the package except the one import line noted below:

| here | package path |
| --- | --- |
| `three.module.js` | `build/three.module.js` |
| `three.core.js` | `build/three.core.js` |
| `addons/loaders/GLTFLoader.js` | `examples/jsm/loaders/GLTFLoader.js` |
| `addons/controls/OrbitControls.js` | `examples/jsm/controls/OrbitControls.js` |
| `addons/utils/BufferGeometryUtils.js` | `examples/jsm/utils/BufferGeometryUtils.js` |
| `addons/utils/SkeletonUtils.js` | `examples/jsm/utils/SkeletonUtils.js` |

Change: in the four `addons/` files the bare import `} from 'three';` was rewritten
to `} from '../../three.module.js';` so no import map is needed.

To update: `npm pack three@<version>`, copy the same files, redo the import rewrite,
and update the version above.
