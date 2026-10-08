/**
 * Standalone build for `dsh-notify`.
 *
 * The browser half has to be the loader's closure-factory artifact: the served
 * file calls `window.__ModuleLoader__.load({ id, factory })` and returns the
 * plugin namespace from inside that factory. The harness builds this shape with
 * its own `clientBundle()` preset, which is not published on its own, so the
 * banner/intro/footer are restated here. Two artifacts land in `lib/`: the ESM
 * node half the Loader imports, and `lib/client.js` served under
 * `/plugins/dsh-notify/client.js`.
 */

const ID = 'dsh-notify'

export default [
  {
    name: ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    // `lib/index.js`, matching the package `main`: the Loader imports the node
    // half by path, and a format-derived `.mjs` would leave `main` dangling.
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: false,
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    outputOptions: {
      // The module-table id must be the package name: the registry keys the
      // served row by it, and the browser resolves its own row from this stamp.
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
]
