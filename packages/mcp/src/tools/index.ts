import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SmClient } from '../client.ts';
import { registerJobTools } from './jobs.ts';
import { registerOverviewTools } from './overview.ts';
import { registerProjectTools } from './projects.ts';
import { registerServerTools } from './servers.ts';
import { registerSyncTools } from './sync.ts';
import { registerTargetTools } from './targets.ts';

export function registerAllTools(
  server: McpServer,
  client: SmClient,
  options: { readOnly: boolean },
): void {
  registerOverviewTools(server, client);
  registerServerTools(server, client);
  registerProjectTools(server, client);
  registerTargetTools(server, client);
  registerSyncTools(server, client, !options.readOnly);
  registerJobTools(server, client, !options.readOnly);
}