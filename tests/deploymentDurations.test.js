import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalDeploymentDurations, importHistoricalDeploymentDurations, startDeploymentDuration, finishDeploymentDuration } from '../lib/deploymentDurations.js';

const deploy = (overrides = {}) => ({
  data: { action: 'deploy', deploymentId: 'lab', runId: 'run', blueprint: { vms: [{ osType: 'ubuntu' }] } },
  processedOn: 1000, finishedOn: 61000, progress: { failedVmids: [] }, returnvalue: {}, ...overrides
});
const customize = (overrides = {}) => ({
  data: { action: 'customize', deploymentId: 'lab', runId: 'run' },
  processedOn: 62000, finishedOn: 181000, returnvalue: { status: 'ansible-done' }, ...overrides
});
const configured = () => {
  const job = deploy(); job.data.blueprint.vms[0].timezone = 'Europe/Zurich'; return job;
};

test('elapsed duration includes the interval between Terraform and customization', () => {
  const [sample] = historicalDeploymentDurations([configured()], [customize()]);
  assert.equal(sample.finishedAt - sample.startedAt, 180000);
  assert.equal(sample.runId, 'run');
});
test('deployments without customization finish at Terraform completion', () => {
  const [sample] = historicalDeploymentDurations([deploy()], []);
  assert.equal(sample.finishedAt - sample.startedAt, 60000);
});
test('missing, failed or unrelated customization is never counted as a complete deployment', () => {
  for (const jobs of [[], [customize({ returnvalue: { status: 'stale-job-skipped' } })],
    [customize({ data: { action: 'customize', deploymentId: 'other', runId: 'run' } })],
    [customize({ data: { action: 'customize', deploymentId: 'lab', runId: 'other' } })],
    [customize({ data: { action: 'customize', deploymentId: 'lab', runId: 'run', readinessFailedVmids: [101] } })]]) {
    assert.deepEqual(historicalDeploymentDurations([configured()], jobs), []);
  }
});
test('all supported customization triggers require a completed Ansible job, including non-Windows guests', () => {
  for (const config of [{ hostname: 'server' }, { domainRole: 'member' }, { installDocker: true },
    { secondDiskSizeGb: 20, secondDiskConfigure: true }, { timezone: 'UTC', osType: 'other' }]) {
    const job = deploy(); Object.assign(job.data.blueprint.vms[0], config);
    assert.deepEqual(historicalDeploymentDurations([job], []), []);
  }
});
test('partial redeployments, power actions, stale jobs and readiness failures are excluded', () => {
  for (const mutate of [job => { job.data.replaceVmids = [101]; }, job => { job.data.redeployWorkstationNumber = '01'; },
    job => { job.data.action = 'start'; }, job => { job.returnvalue.status = 'stale-job-skipped'; },
    job => { job.progress.failedVmids = [101]; }, job => { job.finishedOn = 500; }]) {
    const job = deploy(); mutate(job);
    assert.deepEqual(historicalDeploymentDurations([job], []), []);
  }
});
test('retained history is read only from completed jobs and imported with deployment identity', async () => {
  const queries = [];
  const queue = jobs => ({ getJobs: async states => { assert.deepEqual(states, ['completed']); return jobs; } });
  await importHistoricalDeploymentDurations({ query: async (...args) => queries.push(args) },
    { terraform: queue([configured()]), ansible: queue([customize()]) });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0][1], ['run', 'lab', new Date(1000), new Date(181000)]);
});
test('new measurements skip partial deployments and failed readiness completions', async () => {
  const queries = [];
  const db = { query: async (...args) => queries.push(args) };
  const partial = deploy(); partial.data.replaceVmids = [101];
  await startDeploymentDuration(db, partial);
  await finishDeploymentDuration(db, { data: { deploymentId: 'lab', runId: 'run', readinessFailedVmids: [101] } });
  assert.equal(queries.length, 0);
  await startDeploymentDuration(db, deploy(), new Date(1000));
  await finishDeploymentDuration(db, customize(), new Date(181000));
  assert.deepEqual(queries.map(([, values]) => values), [['run', 'lab', new Date(1000)], ['run', 'lab', new Date(181000)]]);
});
