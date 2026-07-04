// qdrant-universal-injection — Core Library Exports
// Universal middleware for Qdrant-based personality injection, semantic cache, and RAG

export { loadConfig, type FazAIConfig } from "./config.js";

// Core
export { StaticEmbedder, getEmbedder } from "./core/embedder.js";
export { QdrantPool, getQdrantPool } from "./core/qdrant-client.js";
export {
  UniversalInjector,
  getInjector,
  type InjectionResult,
  type ScoredChunk,
  type InjectOptions,
} from "./core/injector.js";
export {
  UniversalIndexer,
  getIndexer,
  type IndexOptions,
  type IndexResult,
} from "./core/indexer.js";

// Cache
export {
  QdrantSemanticCache,
  getSemanticCache,
  type CachedResponse,
  type SemanticCacheOptions,
} from "./cache/semantic-cache.js";

// Middleware
export {
  loadPersonality,
  buildPersonalityPrompt,
  clearPersonalityCache,
  type PersonalityTraits,
} from "./middleware/personality-guard.js";
