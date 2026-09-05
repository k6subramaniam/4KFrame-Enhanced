import type {
  ProcessingJob,
  ProcessingJobKind,
  ProcessingJobState,
  VideoUpscaleTarget,
} from '@4kframe/shared';

const jobs: ProcessingJob[] = [];
let sequence = 0;

function prune(): void {
  if (jobs.length <= 100) return;
  const active = jobs.filter((job) => job.state === 'queued' || job.state === 'running');
  const finished = jobs
    .filter((job) => job.state !== 'queued' && job.state !== 'running')
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))
    .slice(0, Math.max(0, 100 - active.length));
  jobs.splice(0, jobs.length, ...active, ...finished);
}

export function createProcessingJob(
  kind: ProcessingJobKind,
  mediaId: string,
  label: string,
  target?: VideoUpscaleTarget,
): ProcessingJob {
  const job: ProcessingJob = {
    id: `${Date.now().toString(36)}-${(++sequence).toString(36)}`,
    kind,
    mediaId,
    label,
    ...(target ? { target } : {}),
    state: 'queued',
    createdAt: Date.now(),
    cancellable: true,
  };
  jobs.unshift(job);
  prune();
  return job;
}

export function getProcessingJob(id: string): ProcessingJob | undefined {
  return jobs.find((job) => job.id === id);
}

export function listProcessingJobs(limit = 30): ProcessingJob[] {
  return jobs
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map((job) => ({ ...job }));
}

export function setProcessingJobState(id: string, state: ProcessingJobState, error?: string): ProcessingJob | undefined {
  const job = getProcessingJob(id);
  if (!job) return undefined;
  job.state = state;
  if (state === 'running') {
    job.startedAt = Date.now();
    job.cancellable = false;
  } else if (state !== 'queued') {
    job.finishedAt = Date.now();
    job.cancellable = false;
  }
  if (error) job.error = error;
  else if (state === 'completed') delete job.error;
  return { ...job };
}

export function cancelQueuedProcessingJob(id: string): ProcessingJob | undefined {
  const job = getProcessingJob(id);
  if (!job || job.state !== 'queued') return undefined;
  setProcessingJobState(id, 'cancelled');
  return { ...job, state: 'cancelled', cancellable: false };
}

export function clearFinishedProcessingJobs(): number {
  const before = jobs.length;
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    if (jobs[i].state !== 'queued' && jobs[i].state !== 'running') jobs.splice(i, 1);
  }
  return before - jobs.length;
}
