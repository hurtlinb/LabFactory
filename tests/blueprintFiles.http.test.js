import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';

test('HTTP upload, resave, replacement, removal and blueprint deletion', {
  skip: !process.env.BLUEPRINT_FILES_TEST_API_URL || !process.env.BLUEPRINT_FILES_TEST_STORAGE || !process.env.BLUEPRINT_FILES_TEST_DATABASE_URL
}, async () => {
  const { Pool } = await import('pg');
  const db = new Pool({ connectionString: process.env.BLUEPRINT_FILES_TEST_DATABASE_URL });
  const blueprintId = randomUUID(), courseId = randomUUID(), vmId = randomUUID(), templateId = randomUUID();
  const email = blueprintId + '@example.test';
  const directory = path.join(process.env.BLUEPRINT_FILES_TEST_STORAGE, blueprintId);
  const base = '/api/blueprints/' + blueprintId;
  const api = async (url, options = {}) => {
    const response = await fetch(process.env.BLUEPRINT_FILES_TEST_API_URL + url, options);
    return { status: response.status, body: await response.json() };
  };
  try {
    await db.query('INSERT INTO teachers(email) VALUES ($1)', [email]);
    await db.query('INSERT INTO courses(id,course_number) VALUES ($1,$2)', [courseId, Math.floor(Math.random() * 1000000000)]);
    await db.query("INSERT INTO vm_templates(id,name,proxmox_template_vmid,os_type) VALUES ($1,$2,9002,'ubuntu')", [templateId, templateId]);
    await db.query("INSERT INTO lab_blueprints(id,name,course_id,windows_admin_password,teacher_email) VALUES ($1,'Upload test',$2,'Test-Password-123!',$3)", [blueprintId, courseId, email]);
    await db.query("INSERT INTO lab_blueprint_vms(id,blueprint_id,template_id,name) VALUES ($1,$2,$3,'linux-test')", [vmId, blueprintId, templateId]);
    const url = base + '/vms/' + vmId + '/file?' + new URLSearchParams({ name: 'large-test.bin', directory: '/opt/lab/test' });
    const chunk = Buffer.alloc(1024 * 1024, 0xa5);
    async function* chunks() { for (let i = 0; i < 300; i++) yield chunk; }
    let result = await api(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(300 * 1024 * 1024) }, body: Readable.from(chunks()), duplex: 'half' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const first = result.body;
    assert.equal(first.size, 300 * 1024 * 1024);
    assert.equal((await fs.stat(path.join(directory, first.id))).size, first.size);
    const blueprint = (await api(base)).body;
    assert.equal(blueprint.vms[0].config.fileUpload.id, first.id);
    assert.equal(JSON.stringify(blueprint).includes('contentBase64'), false);
    const payload = { name: blueprint.name, courseId, windowsAdminPassword: blueprint.windowsAdminPassword,
      vms: [{ id: vmId, templateId, name: 'linux-test', config: blueprint.vms[0].config }] };
    const save = () => api(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    result = await save();
    assert.equal(result.status, 200, JSON.stringify(result.body));
    result = await api(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from([0, 255, 128, 10]) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    // Wait for request-finally cleanup by acquiring the same blueprint lock through a save.
    payload.vms[0].config.fileUpload = result.body;
    assert.equal((await save()).status, 200);
    await assert.rejects(fs.access(path.join(directory, first.id)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(path.join(directory, result.body.id)), Buffer.from([0, 255, 128, 10]));
    delete payload.vms[0].config.fileUpload;
    assert.equal((await save()).status, 200);
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
    result = await api(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'delete with blueprint' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((await api(base, { method: 'DELETE' })).status, 200);
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
  } finally {
    await api(base, { method: 'DELETE' });
    await db.query('DELETE FROM lab_blueprints WHERE id = $1', [blueprintId]);
    await db.query('DELETE FROM vm_templates WHERE id = $1', [templateId]);
    await db.query('DELETE FROM courses WHERE id = $1', [courseId]);
    await db.query('DELETE FROM teachers WHERE email = $1', [email]);
    await db.end();
  }
});
