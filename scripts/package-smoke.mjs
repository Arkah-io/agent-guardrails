import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'arkah-guardrails-consumer-'));
const consumer = join(temp, 'consumer');
const packed = join(temp, 'packed');
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

try {
  await mkdir(consumer);
  await mkdir(packed);
  run('pnpm', ['pack', '--pack-destination', packed], root);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'guardrails-consumer-smoke', private: true, type: 'module' }),
  );
  const peers = Object.keys(manifest.peerDependencies).map(
    (name) => `${name}@${manifest.devDependencies[name]}`,
  );
  run(
    'pnpm',
    [
      'add',
      join(packed, `${manifest.name}-${manifest.version}.tgz`),
      ...peers,
      '@types/node@22.20.5',
      '--ignore-scripts',
    ],
    consumer,
  );
  const installed = join(consumer, 'node_modules', manifest.name);
  for (const name of ['document-agent.ts', 'scripted-model.ts']) {
    const content = await readFile(join(installed, 'examples', name), 'utf8');
    await writeFile(
      join(consumer, name),
      content.replaceAll("'../src/index.js'", `'${manifest.name}'`),
    );
  }
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: false,
        outDir: 'out',
        types: ['node'],
      },
      include: ['*.ts'],
    }),
  );
  run(
    process.execPath,
    [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')],
    consumer,
  );
  const output = run(process.execPath, ['out/document-agent.js'], consumer);
  assert.match(output, /"writes": 1/);
  assert.match(output, /"moderationCalls": 1/);
  for (const name of ['README.md', 'SECURITY.md', 'LICENSE', 'docs/storage-adapters.md']) {
    assert.ok((await readFile(join(installed, name))).length > 0);
  }
  console.log(
    'Clean consumer: declarations, installed ESM API, real agent demo and exact replay passed.',
  );
  await rm(temp, { recursive: true });
} catch (error) {
  console.error(`Package smoke failed. Fixture retained at ${temp}`);
  if (error && typeof error === 'object' && 'stdout' in error) console.error(String(error.stdout));
  if (error && typeof error === 'object' && 'stderr' in error) console.error(String(error.stderr));
  throw error;
}
