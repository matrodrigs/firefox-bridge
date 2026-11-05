import { createBroker } from './broker.mjs';
import { loadRuntime, PORT } from './runtime.mjs';

async function main() {
  const { token } = await loadRuntime();
  const broker = createBroker({ token, port: PORT });
  try { await broker.start(); }
  catch (error) { if (error.code === 'EADDRINUSE') return; throw error; }
  process.on('SIGINT', async () => { await broker.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await broker.close(); process.exit(0); });
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
