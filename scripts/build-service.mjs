import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const name = process.argv[2];
if (!['api', 'ingestor', 'simulator', 'database'].includes(name))
  throw new Error('Unknown service');
await build({
  ...(name === 'database'
    ? {
        entryPoints: ['migrate', 'seed', 'status'].map((entry) =>
          resolve(root, `packages/database/src/${entry}.ts`),
        ),
        outdir: resolve(root, 'packages/database/dist'),
      }
    : {
        entryPoints: [resolve(root, `apps/${name}/src/index.ts`)],
        outfile: resolve(root, `apps/${name}/dist/index.js`),
      }),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  packages: 'external',
  plugins: [
    {
      name: 'workspace-packages',
      setup(b) {
        b.onResolve({ filter: /^@iiot\/(shared|database|adapters)$/ }, (args) => ({
          path: resolve(root, `packages/${args.path.split('/')[1]}/src/index.ts`),
        }));
      },
    },
  ],
});
console.log(`${name}: compiled to dist/index.js`);
