import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const expoCli = resolve(root, 'node_modules', 'expo', 'bin', 'cli');
const playwrightCli = resolve(root, 'node_modules', '@playwright', 'test', 'cli.js');

function run(args, env) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const exportEnvironment = {
  ...process.env,
  EXPO_PUBLIC_API_URL: 'https://layout-test.invalid',
};
run([expoCli, 'export', '--platform', 'web', '--dev', '--output-dir', 'dist'], exportEnvironment);
run([playwrightCli, 'test', '--config=e2e/playwright.config.ts', ...process.argv.slice(2)], process.env);
