import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

export async function createTerraformJobDirectory(source) {
  const directory = await mkdtemp(path.join(tmpdir(), 'labfactory-terraform-'));
  try {
    // Copy configuration only: never copy a previous plan, workspace selection,
    // generated secrets, provider data or local state into another job.
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.tf') || entry.name === '.terraform.lock.hcl')) {
        await copyFile(path.join(source, entry.name), path.join(directory, entry.name));
      }
    }
    return directory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
