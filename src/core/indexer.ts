import { v4 as uuid } from "uuid";
import { createHash } from "node:crypto";
import { getEmbedder } from "./embedder.js";
import { getQdrantPool } from "./qdrant-client.js";

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;
const DEDUP_THRESHOLD = 0.90;

export interface IndexOptions {
  collection: string;
  metadata?: Record<string, unknown>;
  chunkSize?: number;
  chunkOverlap?: number;
  dedup?: boolean;
}

export interface IndexResult {
  collection: string;
  chunksCreated: number;
  duplicatesSkipped: number;
  totalTimeMs: number;
}

function chunkText(
  text: string,
  maxChars: number,
  overlap: number
): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    // Try to break at a natural boundary
    if (end < text.length) {
      const slice = text.slice(start, end);
      const lastNewline = slice.lastIndexOf("\n");
      const lastPeriod = slice.lastIndexOf(". ");
      const breakPoint = Math.max(lastNewline, lastPeriod);
      if (breakPoint > maxChars * 0.5) {
        end = start + breakPoint + 1;
      }
    }

    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
    if (start >= text.length) break;
  }

  return chunks.filter((c) => c.length > 0);
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class UniversalIndexer {
  async index(text: string, options: IndexOptions): Promise<IndexResult> {
    const startTime = Date.now();
    const embedder = getEmbedder();
    const pool = getQdrantPool();
    await embedder.init();

    const chunkSize = options.chunkSize ?? CHUNK_SIZE;
    const overlap = options.chunkOverlap ?? CHUNK_OVERLAP;
    const shouldDedup = options.dedup ?? true;

    const chunks = chunkText(text, chunkSize, overlap);
    let duplicatesSkipped = 0;

    // Batch embed all chunks
    const vectors = await embedder.embedBatch(chunks);

    const points: Array<{
      id: string;
      vector: number[];
      payload: Record<string, unknown>;
    }> = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const vector = vectors[i]!;

      // Dedup check: search for similar existing content
      if (shouldDedup) {
        try {
          const existing = await pool.execute((client) =>
            client.search(options.collection, {
              vector,
              limit: 1,
              score_threshold: DEDUP_THRESHOLD,
              with_payload: false,
            })
          );

          if (existing.length > 0) {
            duplicatesSkipped++;
            continue;
          }
        } catch {
          // Collection might not exist yet — proceed with upsert
        }
      }

      points.push({
        id: uuid(),
        vector,
        payload: {
          text: chunk,
          content_hash: contentHash(chunk),
          chunk_index: i,
          total_chunks: chunks.length,
          created_at: new Date().toISOString(),
          ...options.metadata,
        },
      });
    }

    // Batch upsert
    if (points.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        await pool.execute((client) =>
          client.upsert(options.collection, {
            wait: true,
            points: batch,
          })
        );
      }
    }

    return {
      collection: options.collection,
      chunksCreated: points.length,
      duplicatesSkipped,
      totalTimeMs: Date.now() - startTime,
    };
  }

  async indexFile(
    filePath: string,
    collection: string,
    metadata?: Record<string, unknown>
  ): Promise<IndexResult> {
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(filePath, "utf-8");
    const { basename, extname } = await import("node:path");

    return this.index(content, {
      collection,
      metadata: {
        path: filePath,
        filename: basename(filePath),
        extension: extname(filePath),
        fileHash: contentHash(content),
        ...metadata,
      },
    });
  }

  async store(
    text: string,
    collection: string,
    payload?: Record<string, unknown>
  ): Promise<string> {
    const embedder = getEmbedder();
    const pool = getQdrantPool();
    await embedder.init();

    const vector = await embedder.embed(text);
    const id = uuid();

    await pool.execute((client) =>
      client.upsert(collection, {
        wait: true,
        points: [
          {
            id,
            vector,
            payload: {
              text,
              content_hash: contentHash(text),
              created_at: new Date().toISOString(),
              ...payload,
            },
          },
        ],
      })
    );

    return id;
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    const pool = getQdrantPool();
    await pool.execute((client) =>
      client.delete(collection, { points: ids })
    );
  }
}

// Singleton
let _indexer: UniversalIndexer | null = null;

export function getIndexer(): UniversalIndexer {
  if (!_indexer) {
    _indexer = new UniversalIndexer();
  }
  return _indexer;
}
