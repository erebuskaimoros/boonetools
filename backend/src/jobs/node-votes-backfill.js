import { createRecordedJobRunner } from '../lib/recorded-job.js';
import { runNodeVoteBackfill } from '../shared/node-votes.js';

const LOCK_KEY = 'boonetools:node-votes-backfill';
const JOB_NAME = 'node-votes-backfill';

export const runNodeVotesBackfill = createRecordedJobRunner({
  lockKey: LOCK_KEY,
  tableName: 'node_vote_job_runs',
  jobName: JOB_NAME,
  run: runNodeVoteBackfill
});
