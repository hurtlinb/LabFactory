import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// Entirely disposable infrastructure; never connects to the user's database or labs.
test('HTTP saves/reorders/removes blocks and validates through the real queue and worker', {
  skip: process.env.ANSIBLE_TASKS_HTTP_DOCKER_TEST !== '1', timeout: 180000
}, async t => {
  const exec = promisify(execFile);
  const docker = async (...args) => (await exec('docker', args, { maxBuffer: 1024 * 1024 })).stdout.trim();
  const prefix = `lf-tasks-test-${randomUUID().slice(0, 8)}`;
  const image = process.env.ANSIBLE_TASKS_TEST_APP_IMAGE || 'labfactory/implementation-check:local';
  const names = [];
  await docker('network', 'create', prefix);
  t.after(async () => {
    for (const name of names.reverse()) await docker('rm', '-f', '-v', name).catch(() => {});
    await docker('network', 'rm', prefix);
  });
  const launch = async (suffix, args) => {
    const name = `${prefix}-${suffix}`;
    names.push(name);
    await docker('run', '-d', '--name', name, '--network', prefix, ...args);
    return name;
  };
  const db = await launch('db', ['-e', 'POSTGRES_USER=test', '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test', 'postgres:17-alpine']);
  const redis = await launch('redis', ['redis:8-alpine']);
  for (let attempt = 0; ; attempt++) {
    try { await docker('exec', db, 'pg_isready', '-U', 'test'); break; }
    catch (error) { if (attempt > 60) throw error; await delay(500); }
  }
  const env = ['-e', `DATABASE_URL=postgresql://test:test@${db}:5432/test`, '-e', `REDIS_HOST=${redis}`, '-e', 'OIDC_ISSUER_URL='];
  const dashboard = await launch('dashboard', [...env, '-p', '127.0.0.1::3000', image, 'node', 'dashboard/server.js']);
  const binding = JSON.parse(await docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', dashboard));
  const origin = `http://127.0.0.1:${binding['3000/tcp'][0].HostPort}`;
  for (let attempt = 0; ; attempt++) {
    try { const response = await fetch(origin + '/api/templates'); if (response.ok) break; throw Error('Not ready'); }
    catch (error) {
      if (attempt > 60) throw Error(`${error.message}\n${await docker('logs', dashboard)}`);
      await delay(500);
    }
  }
  await launch('worker', [...env, '-v', '/var/run/docker.sock:/var/run/docker.sock', image, 'node', 'workers/startAnsibleWorkerService.js']);
  const request = async (url, body, method = 'POST') => {
    const response = await fetch(origin + url, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const block = { id: 'dns', name: 'DNS fault', yaml: 'tasks:\n  - ansible.windows.win_dns_record:\n      zone: alpinatech.local\n      name: files\n      type: CNAME\n      value: srv1.alpintech.local' };
  let response = await request('/api/ansible-tasks/validate', { block, variablesYaml: "share_root: 'C:\\Shares'", checkSyntax: false });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.variables.share_root, 'C:\\Shares');
  response = await request('/api/ansible-tasks/validate', { block });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.valid, true);
  response = await request('/api/ansible-tasks/validate', { block: { ...block, yaml: '- ansible.windows.nonexistent: {}' } });
  assert.equal(response.status, 422, JSON.stringify(response.body));
  response = await request('/api/ansible-tasks/validate', { block: { ...block, yaml: 'tasks: []\ntasks: []' } });
  assert.equal(response.status, 400);

  const course = await request('/api/courses', { courseNumber: 999991, description: 'Disposable test' });
  assert.equal(course.status, 201, JSON.stringify(course.body));
  const template = await request('/api/templates', { name: 'Ansible test VM', osType: 'ubuntu', proxmoxTemplateVmid: 9999 });
  assert.equal(template.status, 201, JSON.stringify(template.body));
  const payload = { name: 'Ansible tasks test', courseId: course.body.id, windowsAdminPassword: 'Test-Password-123!',
    vms: [{ templateId: template.body.id, name: 'target', config: { ansibleTasks: [block, { ...block, id: 'disabled', enabled: false }] } }] };
  // Blueprint creation requires an OIDC user email. Seed an owned blueprint in this
  // disposable database, as the existing HTTP file tests do, then test normal saves.
  const id = randomUUID();
  payload.vms[0].id = randomUUID();
  await docker('exec', db, 'psql', '-U', 'test', '-d', 'test', '-c',
    `INSERT INTO teachers(email) VALUES ('tasks@example.test');
     INSERT INTO lab_blueprints(id,name,course_id,teacher_email) VALUES ('${id}','Test','${course.body.id}','tasks@example.test');
     INSERT INTO lab_blueprint_vms(id,blueprint_id,template_id,name) VALUES ('${payload.vms[0].id}','${id}','${template.body.id}','target');`);
  response = await request(`/api/blueprints/${id}`, payload, 'PUT');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.vms[0].config.ansibleTasks, payload.vms[0].config.ansibleTasks);
  payload.vms[0].config.ansibleTasks.reverse();
  response = await request(`/api/blueprints/${id}`, payload, 'PUT');
  assert.equal(response.status, 200);
  assert.equal(response.body.vms[0].config.ansibleTasks[0].id, 'disabled');
  payload.vms[0].config.ansibleTasks = [];
  response = await request(`/api/blueprints/${id}`, payload, 'PUT');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.vms[0].config.ansibleTasks, []);
  payload.vms[0].config.ansibleTasks = [block, block];
  response = await request(`/api/blueprints/${id}`, payload, 'PUT');
  assert.equal(response.status, 400);
});
