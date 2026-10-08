# Vendored three.js (built, don't hand-edit)

Source: github.com/mrdoob/three.js tag `r185` (commit 2431a09f46f34c560bc8e44b33be0e567723d5b9), MIT.
Files: build/three.module.min.js, build/three.core.min.js, examples/jsm/loaders/GLTFLoader.js,
examples/jsm/utils/{BufferGeometryUtils,SkeletonUtils}.js, examples/jsm/environments/RoomEnvironment.js.

Only modification: the bare specifier `from 'three'` in the addons is rewritten to
`from '../../three.module.min.js'`, because the CSP (`script-src 'self'`) blocks the inline
import map that bare specifiers would need. Re-apply that rewrite when upgrading.
