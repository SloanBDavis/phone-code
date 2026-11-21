import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const pkg: unknown = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'));
const version =
  typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string'
    ? pkg.version
    : '0.0.0';

/**
 * Builds the service worker from src/sw.js: injects the list of emitted files
 * (the app shell) and a build id so a new deploy replaces the old cache.
 */
function serviceWorker(): Plugin {
  let files: string[] = [];
  return {
    name: 'phone-code-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
    },
    closeBundle() {
      const src = readFileSync(resolve(import.meta.dirname, 'src/sw.js'), 'utf8');
      const shell = ['/', ...files.map((f) => `/${f}`), '/icons/icon-192.png', '/apple-touch-icon.png'];
      const id = `${version}-${Date.now().toString(36)}`;
      const out = src
        .replaceAll('SHELL_PLACEHOLDER', JSON.stringify(shell))
        .replaceAll('BUILD_PLACEHOLDER', JSON.stringify(id));
      writeFileSync(resolve(import.meta.dirname, 'dist/sw.js'), out);
    },
  };
}

export default defineConfig({
  define: { 'import.meta.env.APP_VERSION': JSON.stringify(version) },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  plugins: [serviceWorker()],
  build: {
    target: ['safari16', 'chrome111'],
    cssMinify: true,
    modulePreload: { polyfill: false },
    reportCompressedSize: true,
  },
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
