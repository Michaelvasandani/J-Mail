import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The local reranker (Transformers.js + onnxruntime-node) uses native bindings; keep it out of the server bundle.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node"],
};

export default nextConfig;
