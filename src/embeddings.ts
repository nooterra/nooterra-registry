import { pipeline, env } from "@xenova/transformers";

env.allowLocalModels = true;
env.backends.onnx.wasm.wasmPaths = env.backends.onnx.wasm.wasmPaths ?? {};

let embedderPromise: Promise<any> | null = null;

async function getEmbedder(model = process.env.EMBED_MODEL || "Xenova/all-MiniLM-L6-v2") {
  if (!embedderPromise) {
    embedderPromise = pipeline("feature-extraction", model);
  }
  return embedderPromise;
}

export async function embed(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const output = await embedder(text, {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data);
}
