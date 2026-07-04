import { v4 as uuid } from "uuid";
import { getEmbedder } from "../core/embedder.js";
import { getQdrantPool } from "../core/qdrant-client.js";

const COLLECTION_NAME = "fazai_semantic_cache";
const DEFAULT_THRESHOLD = 0.95;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export interface CachedResponse {
  prompt: string;
  response: string;
  model: string;
  provider: string;
  createdAt: number;
  hitCount: number;
}

export interface SemanticCacheOptions {
  threshold?: number;
  ttlMs?: number;
  collectionName?: string;
}

export class QdrantSemanticCache {
  private collectionName: string;
  private threshold: number;
  private ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor(options?: SemanticCacheOptions) {
    this.collectionName = options?.collectionName ?? COLLECTION_NAME;
    this.threshold = options?.threshold ?? DEFAULT_THRESHOLD;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const pool = getQdrantPool();
    const embedder = getEmbedder();
    await embedder.init();

    await pool.execute(async (client) => {
      const collections = await client.getCollections();
      const exists = collections.collections.some(
        (c) => c.name === this.collectionName
      );

      if (!exists) {
        await client.createCollection(this.collectionName, {
          vectors: {
            size: embedder.getDimension(),
            distance: "Cosine",
          },
          optimizers_config: {
            default_segment_number: 2,
          },
        });

        // Payload index for filtered search by model/provider
        await client.createPayloadIndex(this.collectionName, {
          field_name: "model",
          field_schema: "keyword",
          wait: true,
        });
        await client.createPayloadIndex(this.collectionName, {
          field_name: "provider",
          field_schema: "keyword",
          wait: true,
        });
        await client.createPayloadIndex(this.collectionName, {
          field_name: "createdAt",
          field_schema: "integer",
          wait: true,
        });
      }
    });

    // Start periodic cleanup of expired entries
    this.cleanupTimer = setInterval(
      () => void this.cleanup(),
      CLEANUP_INTERVAL_MS
    );

    this.initialized = true;
  }

  async lookup(
    prompt: string,
    model: string,
    provider: string
  ): Promise<CachedResponse | null> {
    const embedder = getEmbedder();
    const pool = getQdrantPool();

    const vector = await embedder.embed(prompt);

    // Build filter dynamically — "any" skips that field
    const mustFilters: Array<{ key: string; match: { value: string } }> = [];
    if (model && model !== "any") {
      mustFilters.push({ key: "model", match: { value: model } });
    }
    if (provider && provider !== "any") {
      mustFilters.push({ key: "provider", match: { value: provider } });
    }

    const searchParams: Record<string, unknown> = {
      vector,
      limit: 1,
      score_threshold: this.threshold,
      with_payload: true,
    };
    if (mustFilters.length > 0) {
      searchParams["filter"] = { must: mustFilters };
    }

    const results = await pool.execute((client) =>
      client.search(this.collectionName, searchParams as Parameters<typeof client.search>[1])
    );

    if (results.length === 0) return null;

    const hit = results[0]!;
    const payload = hit.payload as Record<string, unknown>;

    // Check TTL
    const createdAt = payload["createdAt"] as number;
    if (Date.now() - createdAt > this.ttlMs) {
      // Expired — delete and return miss
      await pool.execute((client) =>
        client.delete(this.collectionName, {
          points: [hit.id as string],
        })
      );
      return null;
    }

    // Increment hit count (fire-and-forget)
    const hitCount = ((payload["hitCount"] as number) ?? 0) + 1;
    void pool.execute((client) =>
      client.setPayload(this.collectionName, {
        points: [hit.id as string],
        payload: { hitCount },
      })
    );

    return {
      prompt: payload["prompt"] as string,
      response: payload["response"] as string,
      model: payload["model"] as string,
      provider: payload["provider"] as string,
      createdAt,
      hitCount,
    };
  }

  async store(
    prompt: string,
    response: string,
    model: string,
    provider: string
  ): Promise<void> {
    const embedder = getEmbedder();
    const pool = getQdrantPool();

    const vector = await embedder.embed(prompt);
    const id = uuid();

    await pool.execute((client) =>
      client.upsert(this.collectionName, {
        wait: false,
        points: [
          {
            id,
            vector,
            payload: {
              prompt,
              response,
              model,
              provider,
              createdAt: Date.now(),
              hitCount: 0,
            },
          },
        ],
      })
    );
  }

  async cleanup(): Promise<number> {
    const pool = getQdrantPool();
    const cutoff = Date.now() - this.ttlMs;

    try {
      const result = await pool.execute((client) =>
        client.delete(this.collectionName, {
          filter: {
            must: [
              {
                key: "createdAt",
                range: { lt: cutoff },
              },
            ],
          },
        })
      );
      return (result as { operation_id?: number })?.operation_id ?? 0;
    } catch {
      return 0;
    }
  }

  async getStats(): Promise<{
    totalEntries: number;
    collectionInfo: Record<string, unknown>;
  }> {
    const pool = getQdrantPool();
    const info = await pool.execute((client) =>
      client.getCollection(this.collectionName)
    );
    return {
      totalEntries: info.points_count ?? 0,
      collectionInfo: info as unknown as Record<string, unknown>,
    };
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// Singleton
let _cache: QdrantSemanticCache | null = null;

export function getSemanticCache(
  options?: SemanticCacheOptions
): QdrantSemanticCache {
  if (!_cache) {
    _cache = new QdrantSemanticCache(options);
  }
  return _cache;
}
