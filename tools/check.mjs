import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiler = process.env.COCOS_TSC || 'E:/DevTools/CocosCreator/3.8.8/resources/resources/3d/engine/node_modules/typescript/bin/tsc';
if (!existsSync(compiler)) {
  console.error('TypeScript compiler missing. Set COCOS_TSC to an installed TypeScript bin/tsc file.');
  process.exit(1);
}
const mode = process.argv[2] || 'test';
if (!['test', 'rules', 'typecheck'].includes(mode)) throw new Error('Unknown check mode');
const compile = spawnSync(process.execPath, [compiler, '-p', resolve(root, 'tsconfig.rules.json'), ...(mode === 'typecheck' ? ['--noEmit'] : [])], { cwd: root, stdio: 'inherit' });
if (compile.error || compile.status !== 0) process.exit(compile.status || 1);
if (mode !== 'typecheck') {
  const tests = readdirSync(resolve(root, 'tests')).filter(name => mode === 'rules' ? name === 'battle.test.cjs' : name.endsWith('.test.cjs')).sort().map(name => resolve(root, 'tests', name));
  if (!tests.length) throw new Error('No tests found');
  const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
  process.exit(result.status || (result.error ? 1 : 0));
}
