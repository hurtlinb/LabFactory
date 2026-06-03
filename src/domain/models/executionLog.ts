export type ExecutionStream = 'stdout' | 'stderr' | 'system';

export interface ExecutionLog {
  id: string;
  executionId: string;
  timestamp: string;
  stream: ExecutionStream;
  message: string;
}
