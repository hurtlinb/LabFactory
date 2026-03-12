export type ExecutionType = 'terraform_plan' | 'terraform_apply' | 'ansible_run';

export type ExecutionStatus =
  | 'queued'
  | 'scheduled'
  | 'preparing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface Execution {
  id: string;
  type: ExecutionType;
  status: ExecutionStatus;
  requestedBy: string;
  project: string;
  environment: string;
  target: string;
  lockKey: string;
  repository: string;
  gitRef: string;
  payload: Record<string, unknown>;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorSummary: string | null;
  createdAt: string;
  updatedAt: string;
}
