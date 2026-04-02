/**
 * Bytez3 Nexus — Build Script
 * 
 * Uses esbuild to bundle the full codebase into a single runnable file.
 * Handles:
 * - bun:bundle → shim replacement
 * - Node.js built-in externals
 * - TSX/JSX compilation
 */
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Plugin to redirect bun:bundle imports to our shim
const bunBundlePlugin = {
  name: 'bun-bundle-shim',
  setup(build) {
    build.onResolve({ filter: /^bun:bundle$/ }, () => ({
      path: path.resolve(__dirname, 'src/shims/bun-bundle.ts'),
    }));

    // Handle bun:jsc (V8/JSC engine introspection — no-op on Node)
    build.onResolve({ filter: /^bun:jsc$/ }, () => ({
      path: 'bun-jsc-shim',
      namespace: 'bun-shims',
    }));
    build.onLoad({ filter: /.*/, namespace: 'bun-shims' }, () => ({
      contents: 'export function heapStats() { return {}; }; export default {};',
      loader: 'ts',
    }));
  },
};

// Node built-ins to externalize
const nodeBuiltins = [
  'async_hooks', 'buffer', 'child_process', 'crypto', 'dns', 'events',
  'fs', 'http', 'https', 'net', 'os', 'path', 'perf_hooks', 'process',
  'readline', 'stream', 'tls', 'tty', 'url', 'util', 'v8', 'zlib',
  'node:net', 'node:os', 'node:path', 'node:fs', 'node:child_process',
  'node:crypto', 'node:http', 'node:https', 'node:events', 'node:stream',
  'node:util', 'node:url', 'node:buffer', 'node:readline', 'node:tty',
  'node:v8', 'node:zlib', 'node:process', 'node:perf_hooks',
  'node:async_hooks', 'node:dns', 'node:tls',
];

const entryPoint = process.argv[2] || 'src/main.tsx';

console.log(`\n  ⚡ Bytez3 Nexus Build`);
console.log(`  ➜ Entry: ${entryPoint}\n`);

try {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outdir: 'dist',
    splitting: true,
    sourcemap: true,
    treeShaking: true,
    minify: false,
    keepNames: true,
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    external: [
      ...nodeBuiltins,
      'fsevents',
      'sharp',
      '@aws-sdk/*',
      'color-diff-napi',
      '@alcalzone/*',
    ],
    plugins: [bunBundlePlugin],
    logLevel: 'warning',
    metafile: true,
  });

  // Output build stats
  const meta = result.metafile;
  const outputs = Object.keys(meta.outputs);
  let totalSize = 0;
  for (const out of outputs) {
    totalSize += meta.outputs[out].bytes;
  }

  console.log(`  ✓ Build complete`);
  console.log(`  ✓ ${outputs.length} output files`);
  console.log(`  ✓ Total size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
  
  if (result.warnings.length > 0) {
    console.log(`  ⚠ ${result.warnings.length} warnings`);
  }
  if (result.errors.length > 0) {
    console.log(`  ✗ ${result.errors.length} errors`);
  }

  console.log(`\n  Run with: node dist/main.js\n`);

} catch (error) {
  console.error('Build failed:', error.message);
  if (error.errors) {
    for (const err of error.errors.slice(0, 20)) {
      console.error(`  ${err.location?.file || '?'}:${err.location?.line || '?'} — ${err.text}`);
    }
    if (error.errors.length > 20) {
      console.error(`  ... and ${error.errors.length - 20} more errors`);
    }
  }
  process.exit(1);
}
