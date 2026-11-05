import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp-server.mjs';
import { connectBroker } from './connection.mjs';

async function main() {
  const rpc = await connectBroker();
  await createMcpServer(rpc).connect(new StdioServerTransport());
}
main().catch(error => { process.stderr.write('Firefox Bridge: ' + error.message + '\n'); process.exitCode = 1; });
