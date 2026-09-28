import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const profile = process.env.YANTU_BUILD_PROFILE ?? 'local';
if (!/^[a-z0-9-]+$/i.test(profile)) throw new Error(`Invalid YANTU_BUILD_PROFILE: ${profile}`);
const buildConfig = JSON.parse(readFileSync(resolve(__dirname, 'config', 'environments', `${profile}.json`), 'utf8')) as { apiBaseUrl: string; webBaseUrl: string };

export default defineConfig({
  define: {
    __YANTU_API_BASE_URL__: JSON.stringify(buildConfig.apiBaseUrl),
    __YANTU_WEB_BASE_URL__: JSON.stringify(buildConfig.webBaseUrl),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/extension.ts'),
      formats: ['cjs'],
      fileName: () => 'extension.js',
    },
    outDir: 'dist',
    rollupOptions: {
      external: [
        'vscode',
        // Keep Node.js built-ins external (both with and without node: prefix)
        'fs', 'node:fs',
        'path', 'node:path',
        'os', 'node:os',
        'crypto', 'node:crypto',
        'stream', 'node:stream',
        'util', 'node:util',
        'events', 'node:events',
        'buffer', 'node:buffer',
        'child_process', 'node:child_process',
        'net', 'node:net',
        'http', 'node:http',
        'https', 'node:https',
        'tls', 'node:tls',
        'zlib', 'node:zlib',
        'url', 'node:url',
        'querystring', 'node:querystring',
        'dns', 'node:dns',
        'timers', 'node:timers',
        'process', 'node:process',
        'assert', 'node:assert',
      ],
      output: {
        entryFileNames: '[name].js',
      },
    },
    sourcemap: true,
    minify: false,
    target: 'node18',
    emptyOutDir: true,
  },
  resolve: {
    conditions: ['node', 'import', 'module', 'default'],
  },
});
