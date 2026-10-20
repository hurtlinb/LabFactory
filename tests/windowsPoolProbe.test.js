import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { windowsPoolProbe, powershellCommand } from '../lib/windowsPool.js';

// Run the actual generated PowerShell with filesystem operations replaced by
// in-memory fixtures. Never access the host's Cloudbase-Init installation.
test('PowerShell probe distinguishes missing, stale and fresh flags and writes the ownership marker only on success',
  { skip: process.platform !== 'win32' }, () => {
    const created = '2026-10-20T19:00:00.000Z';
    for (const [flag, expected] of [[null, 11], ['2026-10-19T19:00:00Z', 12], ['2026-10-20T19:01:00Z', 0]]) {
      const fixture = flag ? `[pscustomobject]@{LastWriteTimeUtc=[DateTime]::Parse('${flag}').ToUniversalTime()}` : '$null';
      const script = `
function Get-Item {
  param($Path, $ErrorAction)
  if ($Path -ne 'C:\\ProgramData\\cloudbase-init\\done.flag') { throw 'Unexpected flag path' }
  return ${fixture}
}
function Set-Content {
  param($LiteralPath, $Value, $Encoding)
  if ($LiteralPath -ne 'C:\\ProgramData\\cloudbase-init\\labfactory-pool-ready.flag' -or $Value -ne 'test-token') { throw 'Unexpected marker' }
  Write-Output 'MARKER_WRITTEN'
}
${windowsPoolProbe({ created_at: created, ownership_token: 'test-token' })}`;
      const [, ...args] = powershellCommand(script);
      const result = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
      assert.ifError(result.error);
      assert.equal(result.status, expected, result.stderr);
      assert.equal(result.stdout.includes('MARKER_WRITTEN'), expected === 0);
    }
  });
