import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    exclude: ['**/node_modules/**', '**/.vscode-test/**', '**/tmp/**', '**/dist/**', '**/out/**', '**/e2e/**', '**/tests/integration/**']
  }
});
