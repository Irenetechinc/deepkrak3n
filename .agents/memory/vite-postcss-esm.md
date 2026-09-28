---
name: Vite PostCSS config in ESM packages
description: The workspace treats artifact package JavaScript files as ESM.
---

Use a `.cjs` extension for a CommonJS PostCSS config in an artifact whose package.json has `"type": "module"`.

**Why:** Vite loads the copied `postcss.config.js` as ESM in these packages, so `module.exports` causes a runtime failure even though typechecking passes.

**How to apply:** Prefer `postcss.config.cjs` with `module.exports` when using Tailwind 3/PostCSS in an ESM artifact.