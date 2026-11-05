import { registerNativeHost, unregisterNativeHost } from '../src/native-registration.mjs';
import { loadRuntime, BASE_URL } from '../src/runtime.mjs';
import { VERSION, PROTOCOL_VERSION } from '../src/version.mjs';

if (process.argv.includes('--remove')) {
  await unregisterNativeHost();
  process.stdout.write('Native connection removed. You can also remove the Firefox extension and MCP client entry.\n');
} else {
  const result = await registerNativeHost();
  const { token } = await loadRuntime();
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const response = await fetch(`${BASE_URL}/health`, { headers, signal: AbortSignal.timeout(1000) });
    const status = await response.json();
    if (response.ok && status.service === 'firefox-bridge' && (status.version !== VERSION || status.protocolVersion !== PROTOCOL_VERSION)) {
      await fetch(`${BASE_URL}/shutdown`, { method: 'POST', headers, signal: AbortSignal.timeout(2000) });
      process.stdout.write('Stopped an older local bridge. The new host starts automatically.\n');
    }
  } catch {}
  process.stdout.write(`Native connection installed for this user.\n${result.manifestPath}\n\nLoad the Firefox extension and enable access. It connects automatically; no pairing key is needed. Keep this project folder in place.\n`);
}
