import { loadConfig } from "../config.js";
import { getQdrantPool } from "../core/qdrant-client.js";
import { getEmbedder } from "../core/embedder.js";

const COLLECTIONS = [
  {
    name: "fazai_personality",
    description: "Behavioral traits and communication style",
  },
  {
    name: "fazai_memory",
    description: "Conversational context and session history",
  },
  {
    name: "fazai_learning",
    description: "Validated solutions and error patterns",
  },
  {
    name: "fazai_kb",
    description: "Technical documentation and reference",
  },
  {
    name: "fazai_inference",
    description: "Security policies, SLAs, operational rules",
  },
  {
    name: "fazai_source",
    description: "Self-knowledge — FazAI's own codebase indexed",
  },
  {
    name: "fazai_semantic_cache",
    description: "Response caching for similar queries",
  },
];

const PAYLOAD_INDEXES: Array<{
  collection: string;
  field: string;
  schema: "keyword" | "integer" | "float" | "bool" | "text";
}> = [
  // personality
  { collection: "fazai_personality", field: "type", schema: "keyword" },
  { collection: "fazai_personality", field: "style", schema: "keyword" },
  { collection: "fazai_personality", field: "category", schema: "keyword" },

  // memory
  { collection: "fazai_memory", field: "role", schema: "keyword" },
  { collection: "fazai_memory", field: "importance", schema: "float" },
  { collection: "fazai_memory", field: "sessionId", schema: "keyword" },

  // learning
  { collection: "fazai_learning", field: "category", schema: "keyword" },
  { collection: "fazai_learning", field: "validated", schema: "bool" },

  // kb
  { collection: "fazai_kb", field: "category", schema: "keyword" },
  { collection: "fazai_kb", field: "source_url", schema: "keyword" },

  // inference
  { collection: "fazai_inference", field: "priority", schema: "integer" },
  { collection: "fazai_inference", field: "rule_name", schema: "keyword" },

  // source
  { collection: "fazai_source", field: "path", schema: "keyword" },
  { collection: "fazai_source", field: "category", schema: "keyword" },

  // semantic cache
  { collection: "fazai_semantic_cache", field: "model", schema: "keyword" },
  { collection: "fazai_semantic_cache", field: "provider", schema: "keyword" },
  { collection: "fazai_semantic_cache", field: "createdAt", schema: "integer" },
];

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[init] Qdrant: ${config.qdrantUrl}`);
  console.log(`[init] Vector dimension: ${config.vectorDimension}`);

  const pool = getQdrantPool();
  await pool.init();

  // Init embedder to verify dimension
  const embedder = getEmbedder();
  console.log("[init] Loading embedder to verify dimension...");
  await embedder.init();
  const actualDim = embedder.getDimension();
  console.log(`[init] Embedder dimension: ${actualDim}`);

  if (actualDim !== config.vectorDimension) {
    console.warn(
      `[init] WARNING: embedder dimension (${actualDim}) != config (${config.vectorDimension})`
    );
  }

  const existingCollections = await pool.execute(async (client) => {
    const result = await client.getCollections();
    return new Set(result.collections.map((c) => c.name));
  });

  for (const col of COLLECTIONS) {
    if (existingCollections.has(col.name)) {
      console.log(`[init] ${col.name} — already exists, skipping creation`);
    } else {
      console.log(`[init] ${col.name} — creating (${col.description})`);
      await pool.execute((client) =>
        client.createCollection(col.name, {
          vectors: {
            size: actualDim,
            distance: "Cosine",
            on_disk: false, // 300GB RAM — keep in memory for speed
          },
          optimizers_config: {
            default_segment_number: 2,
          },
          hnsw_config: {
            ef_construct: 200, // Higher precision with 300GB RAM
            m: 16,
            on_disk: false,
          },
        })
      );
      console.log(`[init] ${col.name} — created`);
    }

    // Get point count
    try {
      const info = await pool.execute((client) =>
        client.getCollection(col.name)
      );
      console.log(`[init] ${col.name} — ${info.points_count ?? 0} points`);
    } catch {
      // ignore
    }
  }

  // Create payload indexes
  console.log("\n[init] Creating payload indexes...");
  for (const idx of PAYLOAD_INDEXES) {
    if (!existingCollections.has(idx.collection) && !COLLECTIONS.some(c => c.name === idx.collection)) {
      continue;
    }
    try {
      await pool.execute((client) =>
        client.createPayloadIndex(idx.collection, {
          field_name: idx.field,
          field_schema: idx.schema,
          wait: true,
        })
      );
      console.log(`[init] Index: ${idx.collection}.${idx.field} (${idx.schema})`);
    } catch (error) {
      // Index may already exist
      const msg = (error as Error).message;
      if (!msg.includes("already exists")) {
        console.warn(`[init] Index ${idx.collection}.${idx.field}: ${msg}`);
      }
    }
  }

  console.log("\n[init] Done. All collections ready.");
  pool.destroy();
  process.exit(0);
}

main().catch((error) => {
  console.error("[init] Fatal:", error);
  process.exit(1);
});
