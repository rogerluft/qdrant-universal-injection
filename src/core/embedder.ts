import { FlagEmbedding, EmbeddingModel } from "fastembed";
import { createHash } from "node:crypto";

const EXPECTED_DIMENSION = 768;
const LRU_MAX_ENTRIES = 10_000;

interface CacheEntry {
  vector: number[];
  accessedAt: number;
}

export class StaticEmbedder {
  private model: FlagEmbedding | null = null;
  private cache = new Map<string, CacheEntry>();
  private initPromise: Promise<void> | null = null;
  private dimension: number = EXPECTED_DIMENSION;

  get isReady(): boolean {
    return this.model !== null;
  }

  async init(): Promise<void> {
    if (this.model) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.model = await FlagEmbedding.init({
        model: EmbeddingModel.BGEBaseENV15,
      });
      // Verify dimension with a test embedding
      const testVec = await this.model.queryEmbed("test");
      this.dimension = testVec.length;
      if (this.dimension !== EXPECTED_DIMENSION) {
        console.warn(
          `[embedder] Dimension mismatch: expected ${EXPECTED_DIMENSION}, got ${this.dimension}`
        );
      }
    })();

    return this.initPromise;
  }

  getDimension(): number {
    return this.dimension;
  }

  private cacheKey(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 32);
  }

  private evictLRU(): void {
    if (this.cache.size <= LRU_MAX_ENTRIES) return;
    const toEvict = this.cache.size - LRU_MAX_ENTRIES;
    const entries = [...this.cache.entries()].sort(
      (a, b) => a[1].accessedAt - b[1].accessedAt
    );
    for (let i = 0; i < toEvict; i++) {
      this.cache.delete(entries[i]![0]);
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.model) await this.init();

    const key = this.cacheKey(text);
    const cached = this.cache.get(key);
    if (cached) {
      cached.accessedAt = Date.now();
      return cached.vector;
    }

    const vector = await this.model!.queryEmbed(text);
    const arr = Array.from(vector);

    this.cache.set(key, { vector: arr, accessedAt: Date.now() });
    this.evictLRU();

    return arr;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.model) await this.init();

    const results: number[][] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const key = this.cacheKey(texts[i]!);
      const cached = this.cache.get(key);
      if (cached) {
        cached.accessedAt = Date.now();
        results[i] = cached.vector;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]!);
      }
    }

    if (uncachedTexts.length > 0) {
      const batchSize = 32;
      const embeddings = this.model!.embed(uncachedTexts, batchSize);

      let batchIdx = 0;
      for await (const batch of embeddings) {
        for (const vec of batch) {
          const arr = Array.from(vec);
          const originalIdx = uncachedIndices[batchIdx]!;
          results[originalIdx] = arr;

          const key = this.cacheKey(uncachedTexts[batchIdx]!);
          this.cache.set(key, { vector: arr, accessedAt: Date.now() });
          batchIdx++;
        }
      }
    }

    this.evictLRU();
    return results;
  }

  getCacheStats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: LRU_MAX_ENTRIES };
  }

  clearCache(): void {
    this.cache.clear();
  }
}

// Singleton
let _instance: StaticEmbedder | null = null;

export function getEmbedder(): StaticEmbedder {
  if (!_instance) {
    _instance = new StaticEmbedder();
  }
  return _instance;
}
