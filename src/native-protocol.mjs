import { endianness } from 'node:os';

const littleEndian = endianness() === 'LE';

export function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 1024 * 1024) throw new Error('Native message exceeds 1 MiB.');
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export function createMessageDecoder(onMessage, limit = 8_000_000) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = littleEndian ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
      if (!length || length > limit) throw new Error('Invalid native message length.');
      if (buffer.length < length + 4) return;
      const message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
      buffer = buffer.subarray(length + 4);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Native message must be an object.');
      onMessage(message);
    }
  };
}
