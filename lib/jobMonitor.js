export async function waitForJobCompletion(queue, jobId) {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  while (true) {
    const job = await queue.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} disappeared from ${queue.name}`);
    }

    const state = await job.getState();
    if (state === 'completed') {
      return job.returnvalue;
    }

    if (state === 'failed') {
      const failedReason = await job.getFailedReason();
      throw new Error(`Job ${jobId} failed: ${failedReason}`);
    }

    await delay(250);
  }
}
