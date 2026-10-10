// Called only after Terraform has successfully destroyed the deployment.
export async function removeDestroyedDeployment(db, deploymentId, runId) {
  if (!deploymentId || !runId) throw new Error('Deployment and run IDs are required for cleanup');
  const result = await db.query(
    `DELETE FROM lab_deployments
     WHERE id = $1 AND last_run_id = $2
       AND status = 'destroying' AND last_action = 'destroy'
     RETURNING id`,
    [deploymentId, runId]
  );
  return result.rowCount > 0;
}
