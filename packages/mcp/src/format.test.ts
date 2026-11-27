import { describe, expect, it } from 'vitest';
import type { JobDTO, TargetDTO } from '@sm/shared';
import { SmApiError } from './client.ts';
import {
  errorResult,
  jsonResult,
  maskEnvVars,
  previewWithRedaction,
  redactText,
  redactUrl,
  sanitizeTarget,
  summarizeJob,
  targetSecrets,
} from './format.ts';

function makeTarget(overrides: Partial<TargetDTO> = {}): TargetDTO {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    serverId: '33333333-3333-4333-8333-333333333333',
    label: 'A100 实验',
    remoteCodeDir: '/home/gpu/project',
    dataDir: '/home/gpu/data',
    condaEnv: 'torch210',
    envVars: {
      HF_TOKEN: 'hf_secret_value',
      WANDB_API_KEY: 'wandb_secret_value',
      SHORT: 'abc',
    },
    preCommand: null,
    runCommand: 'python train.py',
    gpuDevices: '0,1',
    syncMode: 'git',
    syncConfig: {
      remoteUrl: 'https://oauth2:glpat-secret-token@gitlab.com/lab/repo.git?token=query-secret',
      branch: 'main',
    },
    keepSession: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobDTO> = {}): JobDTO {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    targetId: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    serverId: '33333333-3333-4333-8333-333333333333',
    title: 'AF2 训练',
    status: 'running',
    launcher: 'tmux',
    sessionName: 'sm_abc',
    sessionMode: 'new',
    windowId: null,
    windowName: null,
    remotePid: 4321,
    remotePgid: 4320,
    scriptPath: null,
    logPath: null,
    exitPath: null,
    renderedCommand: 'export HF_TOKEN=hf_secret_value; python train.py',
    scriptContent: 'export HF_TOKEN=hf_secret_value\npython train.py',
    exitCode: null,
    error: null,
    syncRunId: null,
    logBytes: 1024,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: null,
    lastSeenAt: '2026-01-01T00:00:02.000Z',
    ...overrides,
  };
}

describe('MCP 输出脱敏', () => {
  it('掩码环境变量值但保留键名', () => {
    expect(maskEnvVars({ A: 'secret', B: 'x' })).toEqual({ A: '******', B: '******' });
  });

  it('掩码 Git URL 的 userinfo 与查询参数 token', () => {
    const url = redactUrl(
      'https://oauth2:glpat-secret-token@gitlab.com/lab/repo.git?token=query-secret&branch=main',
    );
    expect(url).not.toContain('glpat-secret-token');
    expect(url).not.toContain('query-secret');
    expect(url).toContain('gitlab.com/lab/repo.git');
    expect(url).toContain('branch=main');
  });

  it('在文本中替换已知密钥值', () => {
    const text = redactText('token=hf_secret_value&key=wandb_secret_value', [
      'hf_secret_value',
      'wandb_secret_value',
    ]);
    expect(text).not.toContain('hf_secret_value');
    expect(text).not.toContain('wandb_secret_value');
    expect(text).toContain('token=******');
  });

  it('从 Target 中收集需要掩码的密钥', () => {
    const secrets = targetSecrets(makeTarget());
    expect(secrets).toContain('hf_secret_value');
    expect(secrets).toContain('wandb_secret_value');
    expect(secrets).toContain('glpat-secret-token');
    expect(secrets).toContain('query-secret');
  });

  it('sanitizeTarget 同时脱敏环境变量与 Git URL', () => {
    const sanitized = sanitizeTarget(makeTarget());
    expect(sanitized.envVars).toEqual({
      HF_TOKEN: '******',
      WANDB_API_KEY: '******',
      SHORT: '******',
    });
    expect(sanitized.envVarsMasked).toBe(true);
    const syncConfig = sanitized.syncConfig as Record<string, unknown>;
    expect(String(syncConfig.remoteUrl)).not.toContain('glpat-secret-token');
    expect(String(syncConfig.remoteUrl)).not.toContain('query-secret');
  });

  it('预览脚本不会泄露环境变量值', () => {
    const preview = previewWithRedaction(
      {
        renderedCommand: 'python train.py',
        scriptContent: 'export HF_TOKEN=hf_secret_value\npython train.py',
        warnings: [],
      },
      targetSecrets(makeTarget()),
    );
    expect(String(preview.scriptContent)).not.toContain('hf_secret_value');
  });
});

describe('MCP 结果整理', () => {
  it('任务摘要不包含脚本与渲染命令', () => {
    const summary = summarizeJob(makeJob());
    expect(summary).toMatchObject({ id: makeJob().id, status: 'running' });
    expect('scriptContent' in summary).toBe(false);
    expect('renderedCommand' in summary).toBe(false);
  });

  it('长输出会被截断并标注', () => {
    const result = jsonResult({ text: 'x'.repeat(200) }, 100);
    const block = result.content[0];
    expect(block && 'text' in block ? block.text : '').toContain('输出已截断');
  });

  it('接口错误保留错误码并给出镜像删除提示', () => {
    const result = errorResult(
      new SmApiError('镜像删除已开启，请输入目标名确认', 400, 'MIRROR_DELETE_CONFIRM_REQUIRED'),
    );
    expect(result.isError).toBe(true);
    const block = result.content[0];
    const text = block && 'text' in block ? block.text : '';
    expect(text).toContain('MIRROR_DELETE_CONFIRM_REQUIRED');
    expect(text).toContain('confirmTargetName');
  });
});