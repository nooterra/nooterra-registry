import { createHash } from "crypto";

const VECTOR_SIZE = 384;

// Deterministic lightweight embedder to avoid external model fetches.
export async function embed(text: string): Promise<number[]> {
  const hash = createHash("sha256").update(text).digest();
  const vector: number[] = new Array(VECTOR_SIZE);
  for (let i = 0; i < VECTOR_SIZE; i++) {
    const byte = hash[i % hash.length];
    // map byte 0-255 to -1..1
    vector[i] = (byte / 127.5) - 1;
  }
  // normalize
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map((v) => v / norm);
}
