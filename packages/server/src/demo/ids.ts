export const DEMO_ID_PREFIX = 'd0d0d0d0-';

export function isDemoId(id: string | null | undefined): boolean {
  return Boolean(id && id.startsWith(DEMO_ID_PREFIX));
}

export const DEMO_SERVER = {
  a100: 'd0d0d0d0-0001-4d0d-8d0d-d0d0d0d00001',
  rtx4090: 'd0d0d0d0-0002-4d0d-8d0d-d0d0d0d00002',
  cloud: 'd0d0d0d0-0003-4d0d-8d0d-d0d0d0d00003',
} as const;

export const DEMO_PROJECT = {
  protein: 'd0d0d0d0-1001-4d0d-8d0d-d0d0d0d01001',
  diffusion: 'd0d0d0d0-1002-4d0d-8d0d-d0d0d0d01002',
} as const;

export const DEMO_TARGET = {
  proteinA100: 'd0d0d0d0-2001-4d0d-8d0d-d0d0d0d02001',
  proteinCloud: 'd0d0d0d0-2002-4d0d-8d0d-d0d0d0d02002',
  diffusion4090: 'd0d0d0d0-2003-4d0d-8d0d-d0d0d0d02003',
  diffusionCloud: 'd0d0d0d0-2004-4d0d-8d0d-d0d0d0d02004',
} as const;

export const DEMO_JOB = {
  proteinRunning: 'd0d0d0d0-3001-4d0d-8d0d-d0d0d0d03001',
  diffusionRunning: 'd0d0d0d0-3002-4d0d-8d0d-d0d0d0d03002',
  baselineExited: 'd0d0d0d0-3003-4d0d-8d0d-d0d0d0d03003',
  loraFailed: 'd0d0d0d0-3004-4d0d-8d0d-d0d0d0d03004',
  proteinCanceled: 'd0d0d0d0-3005-4d0d-8d0d-d0d0d0d03005',
} as const;

export const DEMO_RUN = {
  proteinA100: 'd0d0d0d0-4001-4d0d-8d0d-d0d0d0d04001',
  proteinCloud: 'd0d0d0d0-4002-4d0d-8d0d-d0d0d0d04002',
  diffusion4090: 'd0d0d0d0-4003-4d0d-8d0d-d0d0d0d04003',
  proteinDryRun: 'd0d0d0d0-4004-4d0d-8d0d-d0d0d0d04004',
} as const;

export const DEMO_RUNNING_JOB_IDS: readonly string[] = [
  DEMO_JOB.proteinRunning,
  DEMO_JOB.diffusionRunning,
];