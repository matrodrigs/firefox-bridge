import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const PORT = Number(process.env.FIREFOX_BRIDGE_PORT ?? 39281);
if (!Number.isSafeInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('Invalid local port.');
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const dataDirectory = process.env.FIREFOX_BRIDGE_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'FirefoxBridge');

export async function loadRuntime() {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(dataDirectory, 'connection-key');
  try {
    const token = (await readFile(path, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local key file.');
    return { token, path };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('hex');
    try { await writeFile(path, token, { flag: 'wx', mode: 0o600 }); }
    catch (writeError) { if (writeError.code === 'EEXIST') return loadRuntime(); throw writeError; }
    return { token, path };
  }
}
