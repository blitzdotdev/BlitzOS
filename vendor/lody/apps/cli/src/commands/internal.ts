import { Command } from 'commander';
import { runLodyMcpServer } from '@/mcp/lody-mcp-server';
import { runLodyMcpHttpHost } from '@/mcp/lody-mcp-http-host';

export const internalCommand = new Command('__internal')
  .description('(internal) Lody helper commands')
  .addCommand(
    new Command('lody-mcp-server')
      .description('(internal) stdio MCP server for Lody session tools')
      .action(async () => {
        await runLodyMcpServer();
      })
  )
  .addCommand(
    new Command('lody-mcp-http-host')
      .description('(internal) shared HTTP MCP host for Lody session tools')
      .action(async () => {
        await runLodyMcpHttpHost();
      })
  );
