/**
 * migrate-embeddings.ts
 *
 * Re-embeds all existing Qdrant points from nomic-embed-text (Ollama) vectors
 * to BGE-base-en-v1.5 (FastEmbed ONNX) vectors.
 *
 * This is a one-time migration. After running, all collections use the same
 * embedding model as the adapter's StaticEmbedder.
 *
 * Usage: npx tsx src/scripts/migrate-embeddings.ts [--collection <name>] [--dry-run] [--batch-size <n>]
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { getEmbedder } from "../core/embedder.js";
import { loadConfig } from "../config.js";

const SCROLL_BATCH = 100;
const UPSERT_BATCH = 64;

// Direct client without pool — avoids circuit breaker issues during long migration
function createClient(): QdrantClient {
  const config = loadConfig();
  const url = new URL(config.qdrantUrl);
  return new QdrantClient({
    host: url.hostname,
    port: parseInt(url.port || "6333", 10),
    https: url.protocol === "https:",
    timeout: 120_000,
  });
}

// Retry wrapper for Qdrant operations (handles stale keep-alive sockets)
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const msg = (error as Error).message ?? "";
      const cause = ((error as { cause?: { code?: string } }).cause?.code) ?? "";
      const isRetryable =
        msg.includes("fetch failed") ||
        msg.includes("other side closed") ||
        cause === "UND_ERR_SOCKET" ||
        cause === "ECONNRESET";

      if (isRetryable && attempt < maxRetries) {
        console.warn(`  [retry ${attempt}/${maxRetries}] ${label}: ${msg}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw error;
    }
  }
  throw new Error("unreachable");
}

// How to extract embeddable text from each collection's payload
function extractTextForEmbedding(
  collection: string,
  payload: Record<string, unknown>
): string | null {
  switch (collection) {
    case "fazai_personality": {
      const meta = payload["metadata"] as Record<string, unknown> | undefined;
      const summary = meta?.["conversation_summary"] as string | undefined;
      const name = meta?.["conversation_name"] as string | undefined;
      // Use summary if available (it's the richest representation)
      // Otherwise fall back to conversation name
      if (summary && summary.length > 20) return summary;
      if (name) return name;
      return null;
    }
    case "fazai_memory": {
      const content = payload["content"] as string | undefined;
      const summary = payload["summary"] as string | undefined;
      return content || summary || null;
    }
    case "fazai_kb": {
      const title = payload["title"] as string | undefined;
      const summary = payload["summary"] as string | undefined;
      const parts = [title, summary].filter(Boolean);
      return parts.length > 0 ? parts.join("\n") : null;
    }
    case "fazai_source": {
      const content = payload["content"] as string | undefined;
      const path = payload["path"] as string | undefined;
      if (content) return path ? `// ${path}\n${content}` : content;
      return null;
    }
    case "fazai_learning": {
      const content = payload["content"] as string | undefined;
      const solution = payload["solution"] as string | undefined;
      return content || solution || null;
    }
    case "fazai_inference": {
      const rule = payload["rule"] as string | undefined;
      const content = payload["content"] as string | undefined;
      return rule || content || null;
    }
    default: {
      return (
        (payload["text"] as string) ??
        (payload["content"] as string) ??
        null
      );
    }
  }
}

interface MigrationStats {
  collection: string;
  totalPoints: number;
  migrated: number;
  skipped: number;
  errors: number;
  timeMs: number;
}

async function migrateCollection(
  collection: string,
  dryRun: boolean,
  batchSize: number
): Promise<MigrationStats> {
  const embedder = getEmbedder();
  const startTime = Date.now();

  const stats: MigrationStats = {
    collection,
    totalPoints: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
    timeMs: 0,
  };

  // Check collection exists and has points
  try {
    const checkClient = createClient();
    const info = await checkClient.getCollection(collection);
    stats.totalPoints = info.points_count ?? 0;
    if (stats.totalPoints === 0) {
      console.log(`  [skip] ${collection}: 0 points`);
      stats.timeMs = Date.now() - startTime;
      return stats;
    }
    console.log(`  [start] ${collection}: ${stats.totalPoints} points`);
  } catch {
    console.warn(`  [skip] ${collection}: collection not found`);
    stats.timeMs = Date.now() - startTime;
    return stats;
  }

  // Scroll through all points with retry logic
  let nextOffset: string | number | undefined = undefined;
  let page = 0;

  while (true) {
    // Fresh client for each scroll page (avoids stale keep-alive sockets)
    const scrollClient = createClient();
    let result;
    try {
      result = await withRetry(
        () =>
          scrollClient.scroll(collection, {
            limit: SCROLL_BATCH,
            with_payload: true,
            with_vector: false,
            offset: nextOffset as string | number | undefined,
          }),
        `${collection} scroll page ${page + 1}`
      );
    } catch (error) {
      console.error(`  [abort] ${collection} scroll: ${(error as Error).message}`);
      stats.errors++;
      break;
    }

    if (result.points.length === 0) break;
    page++;

    // Collect points that have extractable text
    const toEmbed: Array<{
      id: string | number;
      text: string;
      payload: Record<string, unknown>;
    }> = [];

    for (const point of result.points) {
      const payload = (point.payload ?? {}) as Record<string, unknown>;
      const text = extractTextForEmbedding(collection, payload);

      if (text && text.trim().length > 0) {
        toEmbed.push({ id: point.id, text: text.trim(), payload });
      } else {
        stats.skipped++;
      }
    }

    // Batch embed and upsert (smaller sub-batches for reliability)
    const embedBatch = Math.min(batchSize, 32);
    for (let i = 0; i < toEmbed.length; i += embedBatch) {
      const batch = toEmbed.slice(i, i + embedBatch);
      const texts = batch.map((p) => p.text);

      try {
        const vectors = await embedder.embedBatch(texts);

        if (!dryRun) {
          const points = batch.map((p, idx) => ({
            id: p.id,
            vector: vectors[idx]!,
            payload: p.payload,
          }));

          // Fresh client for each upsert (avoids stale socket after long embedding)
          await withRetry(
            () => {
              const upsertClient = createClient();
              return upsertClient.upsert(collection, { points, wait: true });
            },
            `${collection} upsert batch ${i}`
          );
        }

        stats.migrated += batch.length;
      } catch (error) {
        stats.errors += batch.length;
        console.error(
          `  [error] ${collection} batch at offset ${i}: ${(error as Error).message}`
        );
        // Small delay after error before next batch
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const progress = stats.migrated + stats.skipped + stats.errors;
    console.log(
      `  [page ${page}] ${collection}: ${progress}/${stats.totalPoints} processed (${stats.migrated} migrated, ${stats.skipped} skipped)`
    );

    nextOffset = (result.next_page_offset ?? undefined) as string | number | undefined;
    if (!nextOffset || result.points.length < SCROLL_BATCH) break;
  }

  stats.timeMs = Date.now() - startTime;
  return stats;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const batchSizeIdx = args.indexOf("--batch-size");
  const batchSize =
    batchSizeIdx >= 0 ? parseInt(args[batchSizeIdx + 1] ?? "32", 10) : UPSERT_BATCH;

  const collectionIdx = args.indexOf("--collection");
  const singleCollection =
    collectionIdx >= 0 ? args[collectionIdx + 1] : undefined;

  const COLLECTIONS = singleCollection
    ? [singleCollection]
    : [
        "fazai_personality",
        "fazai_memory",
        "fazai_learning",
        "fazai_kb",
        "fazai_inference",
        "fazai_source",
      ];

  console.log(`[migrate] Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`[migrate] Batch size: ${batchSize}`);
  console.log(`[migrate] Collections: ${COLLECTIONS.join(", ")}`);
  console.log();

  // Verify Qdrant connectivity
  const testClient = createClient();
  await testClient.getCollections();
  console.log("[migrate] Qdrant connected");

  const embedder = getEmbedder();
  console.log("[migrate] Loading FastEmbed ONNX model...");
  await embedder.init();
  console.log(`[migrate] Embedder ready (${embedder.getDimension()}d)`);
  console.log();

  const allStats: MigrationStats[] = [];

  for (const collection of COLLECTIONS) {
    try {
      const stats = await migrateCollection(collection, dryRun, batchSize);
      allStats.push(stats);
      console.log(
        `  [done] ${collection}: ${stats.migrated} migrated, ${stats.skipped} skipped, ${stats.errors} errors in ${stats.timeMs}ms`
      );
      console.log();
    } catch (error) {
      console.error(
        `  [fatal] ${collection}: ${(error as Error).message}`
      );
      allStats.push({
        collection,
        totalPoints: 0,
        migrated: 0,
        skipped: 0,
        errors: 1,
        timeMs: 0,
      });
    }
  }

  // Summary
  console.log("=== MIGRATION SUMMARY ===");
  let totalMigrated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  for (const s of allStats) {
    console.log(
      `  ${s.collection}: ${s.migrated}/${s.totalPoints} migrated, ${s.skipped} skipped, ${s.errors} errors (${s.timeMs}ms)`
    );
    totalMigrated += s.migrated;
    totalSkipped += s.skipped;
    totalErrors += s.errors;
  }
  console.log();
  console.log(
    `  TOTAL: ${totalMigrated} migrated, ${totalSkipped} skipped, ${totalErrors} errors`
  );

  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("[migrate] Fatal:", error);
  process.exit(1);
});
