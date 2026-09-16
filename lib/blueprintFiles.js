import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const defaultStorage = fileURLToPath(new URL('../data/blueprint-files/', import.meta.url));
export const blueprintFilesRoot = path.resolve(process.env.BLUEPRINT_FILES_DIR || defaultStorage);
export const maxBlueprintFileBytes = Number(process.env.BLUEPRINT_FILE_MAX_BYTES || 1073741824);
if (!Number.isSafeInteger(maxBlueprintFileBytes) || maxBlueprintFileBytes < 1) throw new Error('Invalid BLUEPRINT_FILE_MAX_BYTES');
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const invalid = message => Object.assign(new Error(message), { code: 'VALIDATION' });

// Read the original single-file format as well as the current list format.
export function getFileUploads(config = {}) {
  if (config.fileUploads !== undefined) {
    if (!Array.isArray(config.fileUploads)) throw invalid('fileUploads must be an array');
    return config.fileUploads;
  }
  return config.fileUpload ? [config.fileUpload] : [];
}

export function blueprintFileDirectory(blueprintId, root = blueprintFilesRoot) {
  if (!uuid.test(blueprintId)) throw invalid('Invalid blueprint ID');
  return path.join(root, blueprintId);
}

export function validateFileUpload(upload, osType, { newFile = false } = {}) {
  if (!upload || typeof upload !== 'object') throw invalid('Invalid file upload');
  const { name, directory, id } = upload;
  if (typeof name !== 'string' || !name || name.length > 255 || /[\\/<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) throw invalid('Invalid upload filename');
  if (typeof directory !== 'string' || !directory.trim() || directory !== directory.trim() || directory.length > 4096 || /[\x00-\x1f]|\{\{|\{%/.test(directory) || /\{\{|\{%/.test(name)) throw invalid('Invalid destination directory or filename');
  if (osType !== undefined) {
    const windows = ['windows11', 'windows-server'].includes(osType);
    if (windows ? !/^[a-z]:[\\/]/i.test(directory) || /[<>"|?*]/.test(directory) || directory.slice(2).includes(':') : !directory.startsWith('/')) throw invalid('Destination directory must be an absolute path for the VM operating system');
    if (directory.split(windows ? /[\\/]/ : /\//).includes('..')) throw invalid('Destination directory must not contain ..');
  }
  if (!newFile && (typeof id !== 'string' || !uuid.test(id))) throw invalid('Missing uploaded file');
  if ('contentBase64' in upload) throw invalid('Upload file contents through the file upload endpoint');
}

// All mutations and garbage collection share this transaction-scoped lock.
export async function lockBlueprintFiles(client, blueprintId) {
  blueprintFileDirectory(blueprintId);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [blueprintId]);
}

export async function receiveBlueprintFile(readable, blueprintId, { root = blueprintFilesRoot, maxBytes = maxBlueprintFileBytes } = {}) {
  const directory = blueprintFileDirectory(blueprintId, root);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const destination = path.join(directory, id);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      callback(size > maxBytes ? invalid('File exceeds configured upload limit') : null, chunk);
    }
  });
  try {
    await pipeline(readable, limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    return { id, size };
  } catch (error) {
    await fs.rm(destination, { force: true });
    throw error;
  }
}

export async function persistFileUpload(client, blueprintId, upload, osType) {
  validateFileUpload(upload, osType);
  const result = await client.query('SELECT config FROM lab_blueprint_vms WHERE blueprint_id = $1', [blueprintId]);
  const original = result.rows.flatMap(row => getFileUploads(row.config)).find(file => file.id === upload.id);
  if (!original || original.name !== upload.name) throw invalid('Uploaded file does not belong to this blueprint');
  await fs.access(path.join(blueprintFileDirectory(blueprintId), upload.id));
  return { id: original.id, name: original.name, size: original.size, directory: upload.directory };
}

export async function resolveFileUpload(db, deploymentId, upload, osType) {
  validateFileUpload(upload, osType);
  const result = await db.query(`SELECT d.blueprint_id, v.config FROM lab_deployments d
    JOIN lab_blueprint_vms v ON v.blueprint_id = d.blueprint_id
    WHERE d.id = $1`, [deploymentId]);
  const owner = result.rows.find(row => getFileUploads(row.config).some(file => file.id === upload.id && file.name === upload.name));
  if (!owner) throw new Error('Blueprint file is missing for this deployment');
  const source = path.join(blueprintFileDirectory(owner.blueprint_id), upload.id);
  await fs.access(source);
  const guestPath = ['windows11', 'windows-server'].includes(osType) ? path.win32 : path.posix;
  return { source, directory: upload.directory, destination: guestPath.join(upload.directory, upload.name) };
}

export async function cleanupBlueprintFiles(db, blueprintId, root = blueprintFilesRoot) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await lockBlueprintFiles(client, blueprintId);
    const result = await client.query('SELECT config FROM lab_blueprint_vms WHERE blueprint_id = $1', [blueprintId]);
    const retained = new Set(result.rows.flatMap(row => getFileUploads(row.config)).map(file => file.id));
    const directory = blueprintFileDirectory(blueprintId, root);
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isFile() && uuid.test(entry.name) && !retained.has(entry.name)) await fs.unlink(path.join(directory, entry.name));
    }
    if (!retained.size) await fs.rmdir(directory).catch(error => {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function cleanupOrphanedBlueprintFiles(db) {
  const entries = await fs.readdir(blueprintFilesRoot, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isDirectory() && uuid.test(entry.name)) await cleanupBlueprintFiles(db, entry.name);
  }
}

export async function getBlueprintFileStorage(db, root = blueprintFilesRoot) {
  const result = await db.query(`SELECT b.id AS blueprint_id, b.name AS blueprint_name, v.config
    FROM lab_blueprints b LEFT JOIN lab_blueprint_vms v ON v.blueprint_id = b.id`);
  const blueprints = new Map();
  const files = new Map();
  for (const row of result.rows) {
    blueprints.set(row.blueprint_id, row.blueprint_name);
    for (const file of getFileUploads(row.config || {})) {
      if (!uuid.test(file.id)) continue;
      // One stored file can be referenced by several VMs in a blueprint.
      files.set(`${row.blueprint_id}/${file.id}`, {
        id: file.id, name: file.name, blueprintId: row.blueprint_id,
        blueprintName: row.blueprint_name, size: null, status: 'missing'
      });
    }
  }
  const readDirectory = directory => fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  let totalBytes = 0;
  let storedFileCount = 0;
  for (const directory of await readDirectory(root)) {
    if (!directory.isDirectory() || !uuid.test(directory.name)) continue;
    for (const entry of await readDirectory(path.join(root, directory.name))) {
      if (!entry.isFile() || !uuid.test(entry.name)) continue;
      const stat = await fs.lstat(path.join(root, directory.name, entry.name)).catch(error => {
        if (error.code === 'ENOENT') return null; // Concurrent deletion or replacement.
        throw error;
      });
      if (!stat?.isFile()) continue;
      const key = `${directory.name}/${entry.name}`;
      const reference = files.get(key);
      files.set(key, {
        ...(reference || { id: entry.name, name: entry.name, blueprintId: directory.name,
          blueprintName: blueprints.get(directory.name) || null }),
        size: stat.size, status: reference ? 'stored' : 'unreferenced'
      });
      totalBytes += stat.size;
      storedFileCount++;
    }
  }
  // Before the first upload, the storage directory may not exist yet.
  let storagePath = path.resolve(root);
  let volume;
  while (!volume) {
    try { volume = await fs.statfs(storagePath); } catch (error) {
      const parent = path.dirname(storagePath);
      if (error.code !== 'ENOENT' || parent === storagePath) throw error;
      storagePath = parent;
    }
  }
  return {
    files: [...files.values()].sort((a, b) => (a.blueprintName || '').localeCompare(b.blueprintName || '') || a.name.localeCompare(b.name)),
    storedFileCount, totalBytes,
    availableBytes: volume.bavail * volume.bsize,
    capacityBytes: volume.blocks * volume.bsize
  };
}
