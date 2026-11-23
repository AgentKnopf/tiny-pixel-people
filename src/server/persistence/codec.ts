/** Embeddings are stored as base64 little-endian Float32 to keep save files small (~4x smaller than JSON numbers). */
export function encodeEmbedding(v: readonly number[]): string {
  return Buffer.from(Float32Array.from(v).buffer).toString('base64');
}

export function decodeEmbedding(b64: string): number[] {
  // Copy into a fresh buffer: Buffer.from(base64) may come from a pool with an unaligned byteOffset.
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  if (bytes.byteLength % 4 !== 0) throw new Error('Corrupt embedding: byte length is not a multiple of 4');
  return Array.from(new Float32Array(bytes.buffer));
}
