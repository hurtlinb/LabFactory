import { activeAnsibleTasks } from './ansibleTasks.js';
import { getFileUploads } from './blueprintFiles.js';

export const isFullDeployment = job => job?.data?.action === 'deploy' &&
  Boolean(job.data.deploymentId && job.data.runId) &&
  !job.data.replaceVmids?.length && !job.data.redeployWorkstationNumber;

export async function startDeploymentDuration(db, job, now = new Date()) {
  if (!isFullDeployment(job)) return;
  await db.query(`INSERT INTO blueprint_deployment_durations
    (run_id, blueprint_id, deployment_id, started_at)
    SELECT $1, blueprint_id, id, $3 FROM lab_deployments
    WHERE id = $2 AND last_run_id = $1 AND test_mode = false
    ON CONFLICT (run_id) DO NOTHING`, [job.data.runId, job.data.deploymentId, now]);
}

export async function finishDeploymentDuration(db, job, now = new Date()) {
  if (!job.data?.deploymentId || !job.data?.runId || job.data.readinessFailedVmids?.length) return;
  await db.query(`UPDATE blueprint_deployment_durations h SET finished_at = $3
    FROM lab_deployments d WHERE h.run_id = $1 AND h.deployment_id = $2
      AND h.finished_at IS NULL AND h.started_at <= $3
      AND d.id = h.deployment_id AND d.last_run_id = h.run_id AND d.status = 'deployed'`,
  [job.data.runId, job.data.deploymentId, now]);
}

// Measurements must never turn an otherwise successful deployment into a failure.
export async function safelyRecordDuration(operation, db, job) {
  try { await operation(db, job); }
  catch (error) { console.error('Unable to record deployment duration', error); }
}

const needsCustomization = job => (job.data.blueprint?.vms || []).some(vm =>
  (String(vm.timezone || '').trim() || String(vm.hostname || '').trim() || String(vm.domainRole || '').trim() ||
    getFileUploads(vm).length || activeAnsibleTasks(vm).length || vm.installDocker || (vm.secondDiskSizeGb && vm.secondDiskConfigure)));

// Inputs contain completed jobs only. Never infer success from a timestamp alone.
export function historicalDeploymentDurations(terraformJobs, ansibleJobs) {
  const customizations = new Map();
  for (const job of ansibleJobs) {
    if (job.data?.action !== 'customize' || job.returnvalue?.status !== 'ansible-done' || job.data.readinessFailedVmids?.length) continue;
    const key = `${job.data.deploymentId}:${job.data.runId}`;
    if (!customizations.has(key) || job.finishedOn > customizations.get(key).finishedOn) customizations.set(key, job);
  }
  return terraformJobs.flatMap(job => {
    if (!isFullDeployment(job) || job.returnvalue?.status === 'stale-job-skipped' ||
        job.progress?.failedVmids?.length || !job.processedOn || !job.finishedOn) return [];
    const customization = customizations.get(`${job.data.deploymentId}:${job.data.runId}`);
    if (needsCustomization(job) && !customization) return [];
    const finished = customization ? Math.max(job.finishedOn, customization.finishedOn) : job.finishedOn;
    if (!Number.isFinite(finished) || finished < job.processedOn) return [];
    return [{ runId: job.data.runId, deploymentId: job.data.deploymentId,
      startedAt: new Date(job.processedOn), finishedAt: new Date(finished) }];
  });
}

async function completedJobs(queue) {
  const result = [];
  for (let offset = 0; ; offset += 200) {
    const page = await queue.getJobs(['completed'], offset, offset + 199, true);
    result.push(...page.filter(Boolean));
    if (page.length < 200) return result;
  }
}

export async function importHistoricalDeploymentDurations(db, queues) {
  const [terraform, ansible] = await Promise.all([completedJobs(queues.terraform), completedJobs(queues.ansible)]);
  for (const sample of historicalDeploymentDurations(terraform, ansible)) {
    await db.query(`INSERT INTO blueprint_deployment_durations
      (run_id, blueprint_id, deployment_id, started_at, finished_at)
      SELECT $1, blueprint_id, id, $3, $4 FROM lab_deployments WHERE id = $2 AND test_mode = false
      ON CONFLICT (run_id) DO UPDATE SET finished_at = EXCLUDED.finished_at
      WHERE blueprint_deployment_durations.finished_at IS NULL
        AND blueprint_deployment_durations.started_at <= EXCLUDED.finished_at`,
    [sample.runId, sample.deploymentId, sample.startedAt, sample.finishedAt]);
  }
}
