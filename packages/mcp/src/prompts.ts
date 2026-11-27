import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'find_idle_gpu',
    {
      title: '寻找空闲 GPU',
      description: '结合调度台数据，为当前实验挑一台空闲 GPU 机器与合适的 Target。',
      argsSchema: {
        requirement: z
          .string()
          .optional()
          .describe('可选：显存/卡数/环境等要求，例如“至少 40GB 显存”'),
      },
    },
    ({ requirement }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              '你是 GPU 调度助手。请先调用 get_overview 和 list_servers 了解全局，',
              '再调用 list_projects 与 list_targets 找出可用 Target。',
              requirement ? `需求：${requirement}。` : '',
              '判断依据包括：服务器在线状态、GPU idleCount、每卡 utilPercent 与剩余显存、Target 的远程代码目录/conda 环境/运行命令。',
              '不要猜测任何 ID。最后给出 1~3 个推荐组合（服务器 + Target），说明理由和风险；如果都忙，给出等待或换机建议。',
            ]
              .filter(Boolean)
              .join(' '),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'run_experiment',
    {
      title: '同步并运行实验',
      description: '按“预览 → dry-run → 真实同步 → 创建任务 → 读日志”的安全顺序执行。',
      argsSchema: {
        goal: z.string().optional().describe('可选：实验目标或要运行的命令描述'),
      },
    },
    ({ goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              '请按以下顺序使用 MCP 工具完成一次实验运行：',
              '1) list_projects / list_targets 找到目标 Target；',
              '2) get_target 与 preview_target 检查路径、环境、命令模板（环境变量值已脱敏，不要索取真实密钥）；',
              '3) 可选 scan_project 检查文件数与忽略规则；',
              '4) start_sync 先传 dryRun=true（默认），展示 add/update/delete 计划；',
              '5) 只有在我明确确认后才用 dryRun=false 发起真实同步；若开启镜像删除，需我提供 confirmTargetName；',
              '6) wait_sync 确认同步完成；',
              '7) start_job 创建任务（默认新建独立会话，不要使用已有窗口，除非我明确要求）；',
              '8) wait_job 后 read_job_logs 汇总运行结果与退出码。',
              goal ? `实验目标：${goal}。` : '',
              '任何破坏性操作（stop_job、cancel_sync、镜像删除）都要先说明影响再执行。',
            ]
              .filter(Boolean)
              .join(' '),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'diagnose_job',
    {
      title: '诊断任务失败',
      description: '查看任务时间线、日志和服务器状态，定位失败原因。',
      argsSchema: {
        jobId: z.string().uuid().describe('要诊断的任务 ID'),
      },
    },
    ({ jobId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `请诊断任务 ${jobId}：`,
              '先调用 get_job（includeEvents=true）查看状态、退出码、错误与时间线；',
              '再调用 read_job_logs 读取日志（必要时用 end 翻页）；',
              '然后调用 get_server 和 list_jobs 对比同 Target 的最近任务，检查 GPU/网络/环境问题。',
              '最后总结：失败发生在哪个阶段、最可能的根因、下一步验证动作。不要擅自重启任务或修改服务器配置。',
            ].join(' '),
          },
        },
      ],
    }),
  );
}