import nacl from "tweetnacl";
import bs58 from "bs58";

export interface ACARDCapability {
  id: string;
  description: string;
  inputSchema?: any;
  outputSchema?: any;
  embeddingDim?: number | null;
}

export interface ACARD {
  did: string;
  endpoint: string;
  publicKey: string; // base58-encoded ed25519
  version: number;
  lineage?: string | null;
  capabilities: ACARDCapability[];
  metadata?: Record<string, any> | null;
}

function canonicalize(card: ACARD): string {
  // Stable order to ensure signature validity.
  const ordered: any = {
    did: card.did,
    endpoint: card.endpoint,
    publicKey: card.publicKey,
    version: card.version,
    lineage: card.lineage ?? null,
    capabilities: card.capabilities.map((c) => ({
      id: c.id,
      description: c.description,
      inputSchema: c.inputSchema ?? null,
      outputSchema: c.outputSchema ?? null,
      embeddingDim: c.embeddingDim ?? null,
    })),
    metadata: card.metadata ?? null,
  };
  return JSON.stringify(ordered);
}

export function verifyACARD(card: ACARD, signature: string): boolean {
  try {
    const payload = new TextEncoder().encode(canonicalize(card));
    const pub = bs58.decode(card.publicKey);
    const sig = bs58.decode(signature);
    return nacl.sign.detached.verify(payload, sig, pub);
  } catch {
    return false;
  }
}

export function normalizeEndpoint(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
