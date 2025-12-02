/**
 * Embedding generator for capability discovery.
 * 
 * This module provides semantic embeddings for agent capabilities.
 * In production, you should use a proper embedding model like:
 * - @xenova/transformers (MiniLM, all-MiniLM-L6-v2)
 * - OpenAI embeddings API
 * - Cohere embeddings API
 * 
 * For now, we use a deterministic hash-based approach as a fallback,
 * with optional integration with @xenova/transformers for real semantic search.
 */

import { createHash } from "crypto";

const VECTOR_SIZE = 384;

// Cache for the transformer model
let transformerPipeline: any = null;
let loadingPromise: Promise<any> | null = null;
let useRealEmbeddings = true;

/**
 * Attempt to load the transformer model for real semantic embeddings.
 * Falls back to hash-based embeddings if the model can't be loaded.
 */
async function loadTransformer(): Promise<any> {
  if (transformerPipeline) return transformerPipeline;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      // Try to dynamically import @xenova/transformers
      const { pipeline } = await import("@xenova/transformers" as any);
      
      console.log("[embeddings] Loading sentence-transformers model...");
      transformerPipeline = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
        { quantized: true }
      );
      console.log("[embeddings] Model loaded successfully!");
      return transformerPipeline;
    } catch (err) {
      console.warn(
        "[embeddings] Could not load @xenova/transformers, using hash-based fallback.",
        "Install with: npm install @xenova/transformers"
      );
      useRealEmbeddings = false;
      return null;
    }
  })();

  return loadingPromise;
}

/**
 * Generate a deterministic hash-based vector (fallback).
 * This provides consistency but NOT semantic similarity.
 */
function hashBasedEmbedding(text: string): number[] {
  const hash = createHash("sha256").update(text.toLowerCase().trim()).digest();
  const vector: number[] = new Array(VECTOR_SIZE);
  
  for (let i = 0; i < VECTOR_SIZE; i++) {
    const byte = hash[i % hash.length];
    // Map byte 0-255 to -1..1
    vector[i] = (byte / 127.5) - 1;
  }
  
  // Normalize to unit vector
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map((v) => v / (norm || 1));
}

/**
 * Generate embeddings for text using the best available method.
 * 
 * @param text - The text to embed (capability description, query, etc.)
 * @returns A normalized vector of size 384
 */
export async function embed(text: string): Promise<number[]> {
  // Preprocess text
  const cleanText = text.toLowerCase().trim();
  
  if (!cleanText) {
    return new Array(VECTOR_SIZE).fill(0);
  }

  // Try to use real embeddings
  if (useRealEmbeddings) {
    try {
      const pipe = await loadTransformer();
      if (pipe) {
        const output = await pipe(cleanText, {
          pooling: "mean",
          normalize: true,
        });
        
        // Convert to array and ensure correct size
        const embedding = Array.from(output.data as Float32Array);
        
        // Pad or truncate to VECTOR_SIZE if needed
        if (embedding.length >= VECTOR_SIZE) {
          return embedding.slice(0, VECTOR_SIZE);
        } else {
          return [...embedding, ...new Array(VECTOR_SIZE - embedding.length).fill(0)];
        }
      }
    } catch (err) {
      console.warn("[embeddings] Error generating embedding, using fallback:", err);
    }
  }

  // Fallback to hash-based
  return hashBasedEmbedding(cleanText);
}

/**
 * Check if real semantic embeddings are available.
 */
export function isSemanticSearchEnabled(): boolean {
  return useRealEmbeddings && transformerPipeline !== null;
}

/**
 * Preload the embedding model (optional, for faster first query).
 */
export async function preloadModel(): Promise<void> {
  await loadTransformer();
}
