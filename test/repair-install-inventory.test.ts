import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

const windows = it.runIf(process.platform === 'win32');
let directory: string;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
beforeEach(async () => { directory = await makeTempDir('cos-inventory-'); });
afterEach(async () => { await removeTempDir(directory); });

async function check(options: { expected?: Record<string, string>; extra?: boolean; hidden?: boolean } = {}) {
  const folder = path.join(directory, 'extension'); await fs.mkdir(folder, { recursive: true });
  const manifest = path.join(directory, 'manifest.json');
  await fs.writeFile(manifest, JSON.stringify(options.expected ?? { 'background.js': hash('verified') }));
  const helper = path.resolve('scripts/repair-install-inventory.ps1').replaceAll("'", "''");
  const script = path.join(directory, 'check.ps1');
  await fs.writeFile(script, `param([string]$Folder,[string]$Manifest)\n$ErrorActionPreference='Stop'\n. '${helper}'\n` +
    (options.hidden ? "$item=Get-Item -LiteralPath (Join-Path $Folder '.hidden-note'); $item.Attributes=$item.Attributes -bor [IO.FileAttributes]::Hidden\n" : '') +
    `try { $wanted=Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json; $checked=Assert-CoSFileInventory $Folder $wanted ${options.extra ? '-AllowExtra' : ''}; @($checked.ExtraFiles) | ConvertTo-Json -Compress; exit 0 } catch { Write-Output $_.Exception.Message; exit 2 }\n`);
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Folder', folder, '-Manifest', manifest], {
    encoding: 'utf8', timeout: 15000, windowsHide: true
  });
}

windows('accepts only the verified package bytes in strict mode', async () => {
  await fs.mkdir(path.join(directory, 'extension')); await fs.writeFile(path.join(directory, 'extension/background.js'), 'verified');
  expect((await check()).status).toBe(0);
});
windows('reports which required file is missing rather than just a count mismatch', async () => {
  const result = await check(); expect(result.status).toBe(2); expect(result.stdout).toContain('missing: background.js');
});
windows('refuses changed executable files even when extra-file preservation is enabled', async () => {
  await fs.mkdir(path.join(directory, 'extension')); await fs.writeFile(path.join(directory, 'extension/background.js'), 'changed code');
  const result = await check({ extra: true }); expect(result.status).toBe(2); expect(result.stdout).toContain('changed: background.js');
});
windows('returns added installed files for backup without accepting them in a staged package', async () => {
  const folder = path.join(directory, 'extension'); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'background.js'), 'verified'); await fs.writeFile(path.join(folder, 'local-note.txt'), 'Keep this local note');
  const strict = await check(); expect(strict.status).toBe(2); expect(strict.stdout).toContain('additional: local-note.txt');
  const installed = await check({ extra: true }); expect(installed.status).toBe(0); expect(installed.stdout).toContain('local-note.txt');
  expect(await fs.readFile(path.join(folder, 'local-note.txt'), 'utf8')).toBe('Keep this local note');
});
windows('includes hidden files instead of silently excluding them from backup verification', async () => {
  const folder = path.join(directory, 'extension'); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'background.js'), 'verified'); await fs.writeFile(path.join(folder, '.hidden-note'), 'Keep hidden data');
  const result = await check({ extra: true, hidden: true }); expect(result.status).toBe(0); expect(result.stdout).toContain('.hidden-note');
});
windows('refuses traversal in the manifest and links in the directory', async () => {
  expect((await check({ expected: { '../outside': hash('anything') } })).status).toBe(2);
  await fs.mkdir(path.join(directory, 'outside')); await fs.symlink(path.join(directory, 'outside'), path.join(directory, 'extension/link'), 'junction');
  const result = await check({ expected: {}, extra: true }); expect(result.status).toBe(2); expect(result.stdout).toContain('link/junction refused');
});
