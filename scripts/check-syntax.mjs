import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let count = 0;
for (const directory of ['src', 'scripts', 'test']) {
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) process.exit(result.status ?? 1);
    count++;
  }
}
process.stdout.write(`Syntax checked: ${count} modules.\n`);
