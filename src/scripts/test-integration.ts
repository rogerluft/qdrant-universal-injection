/**
 * test-integration.ts
 *
 * End-to-end test: verifies that the complete injection pipeline works.
 * Tests: personality loading, multi-collection search, ECOA scoring,
 * semantic cache, and prompt building.
 *
 * Usage: npx tsx src/scripts/test-integration.ts
 */

import { loadConfig } from "../config.js";
import { getEmbedder } from "../core/embedder.js";
import { getQdrantPool } from "../core/qdrant-client.js";
import { getInjector } from "../core/injector.js";
import { getSemanticCache } from "../cache/semantic-cache.js";
import {
  loadPersonality,
  buildPersonalityPrompt,
  clearPersonalityCache,
} from "../middleware/personality-guard.js";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function ok(label: string, detail?: string): void {
  console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label: string, detail?: string): void {
  console.log(`  ${RED}✗${RESET} ${label}${detail ? ` — ${detail}` : ""}`);
}
function warn(label: string, detail?: string): void {
  console.log(`  ${YELLOW}⚠${RESET} ${label}${detail ? ` — ${detail}` : ""}`);
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    ok(label, detail);
    passed++;
  } else {
    fail(label, detail);
    failed++;
  }
}

async function main(): Promise<void> {
  console.log("=== Integration Test Suite ===\n");

  // 1. Config
  console.log("1. Config");
  const config = loadConfig();
  assert(!!config.qdrantUrl, "Qdrant URL loaded", config.qdrantUrl);
  assert(config.vectorDimension === 768, "Vector dimension", `${config.vectorDimension}`);

  // 2. Embedder
  console.log("\n2. Embedder");
  const embedder = getEmbedder();
  await embedder.init();
  assert(embedder.isReady, "Embedder ready");
  assert(embedder.getDimension() === 768, "Dimension", `${embedder.getDimension()}`);

  const testVec = await embedder.embed("teste de embedding");
  assert(testVec.length === 768, "Embed produces 768d vector");

  // L2 norm should be ~1 for normalized embeddings
  const norm = Math.sqrt(testVec.reduce((s, v) => s + v * v, 0));
  assert(Math.abs(norm - 1.0) < 0.01, "Vector is normalized", `L2=${norm.toFixed(4)}`);

  // Batch embedding
  const batchVecs = await embedder.embedBatch(["texto A", "texto B", "texto C"]);
  assert(batchVecs.length === 3, "Batch embed returns 3 vectors");
  assert(batchVecs.every((v) => v.length === 768), "All batch vectors are 768d");

  // Embedding cache — same text should return same vector
  const vec1 = await embedder.embed("cache test");
  const vec2 = await embedder.embed("cache test");
  const similarity = vec1.reduce((s, v, i) => s + v * vec2[i]!, 0);
  assert(Math.abs(similarity - 1.0) < 0.001, "Cache returns identical vectors", `cos=${similarity.toFixed(6)}`);

  // Different texts should produce different vectors
  const vecA = await embedder.embed("nginx proxy configuration");
  const vecB = await embedder.embed("receita de bolo de chocolate");
  const crossSim = vecA.reduce((s, v, i) => s + v * vecB[i]!, 0);
  assert(crossSim < 0.8, "Different texts have low similarity", `cos=${crossSim.toFixed(4)}`);

  // Cache stats
  const cacheStats = embedder.getCacheStats();
  assert(cacheStats.size > 0, "Embedding cache populated", `${cacheStats.size}/${cacheStats.maxSize}`);

  // 3. Qdrant Pool
  console.log("\n3. Qdrant Pool");
  const pool = getQdrantPool();
  await pool.init();
  const state = pool.getState();
  assert(state.state === "closed", "Circuit breaker closed", state.state);

  // 4. Personality Loading
  console.log("\n4. Personality Loading");
  clearPersonalityCache();
  const personality = await loadPersonality();
  assert(personality.totalLoaded > 0, "Personality loaded", `${personality.totalLoaded} traits`);
  assert(personality.style.length > 0, "Style extracted", personality.style.join(", "));
  assert(personality.expertise.length > 0, "Expertise extracted", personality.expertise.join(", "));

  const prompt = buildPersonalityPrompt(personality);
  assert(prompt.length > 100, "Personality prompt generated", `${prompt.length} chars`);
  assert(prompt.includes("FazAI"), "Prompt includes FazAI identity");
  console.log(`  ${YELLOW}Preview:${RESET} ${prompt.slice(0, 200)}...`);

  // 5. Multi-Collection Injection
  console.log("\n5. Multi-Collection Injection");
  const injector = getInjector();
  const queries = [
    "como configurar nginx como proxy reverso",
    "docker containers e segurança",
    "configuração de rede MikroTik",
  ];

  for (const query of queries) {
    const result = await injector.query(query, {
      personalityAlways: true,
      includeSource: true,
    });

    const collections = {
      personality: result.personality.length,
      memory: result.memory.length,
      learning: result.learning.length,
      kb: result.kb.length,
      inference: result.inference.length,
      source: result.source.length,
    };

    const totalChunks = result.totalChunks;
    const detail = Object.entries(collections)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");

    assert(
      totalChunks > 0,
      `Query: "${query.slice(0, 40)}"`,
      `${totalChunks} chunks (${detail}) in ${result.queryTimeMs}ms`
    );

    // Check ECOA scoring
    if (totalChunks > 0) {
      const allChunks = [
        ...result.personality,
        ...result.memory,
        ...result.learning,
        ...result.kb,
        ...result.inference,
        ...result.source,
      ];
      const topChunk = allChunks.sort((a, b) => b.fusedScore - a.fusedScore)[0]!;
      assert(
        topChunk.fusedScore > 0,
        "ECOA fused score > 0",
        `top=${topChunk.fusedScore.toFixed(4)} from ${topChunk.collection}`
      );
    }
  }

  // 6. Injected Prompt Building
  console.log("\n6. Injected Prompt");
  const injResult = await injector.query("segurança de rede", { personalityAlways: true });
  const injectedPrompt = injector.buildInjectedPrompt(injResult);
  assert(injectedPrompt.length > 50, "Injected prompt generated", `${injectedPrompt.length} chars`);

  // Prompt deve conter seções estruturadas
  if (injResult.personality.length > 0) {
    assert(
      injectedPrompt.includes("Personalidade e Identidade"),
      "Prompt has personality section"
    );
  }
  if (injResult.memory.length > 0) {
    assert(
      injectedPrompt.includes("Memórias Relevantes"),
      "Prompt has memory section"
    );
  }
  if (injResult.kb.length > 0) {
    assert(
      injectedPrompt.includes("Conhecimento Técnico"),
      "Prompt has knowledge section"
    );
  }

  const injectedWithOriginal = injector.buildInjectedPrompt(
    injResult,
    "You are a helpful assistant."
  );
  assert(
    injectedWithOriginal.includes("Instruções Adicionais"),
    "Original system prompt appended after personality"
  );
  assert(
    injectedWithOriginal.includes("You are a helpful assistant."),
    "Original system prompt content preserved"
  );

  // 7. Semantic Cache
  console.log("\n7. Semantic Cache");
  const cache = getSemanticCache();
  await cache.init();

  // Store a test entry
  const testQuery = `test-cache-${Date.now()}`;
  const testResponse = "This is a cached response for integration testing.";
  await cache.store(testQuery, testResponse, "test-model", "test-provider");
  ok("Cache store", "stored test entry");

  // Lookup — exact match
  const cached = await cache.lookup(testQuery, "test-model", "test-provider");
  assert(cached !== null, "Cache lookup hit", cached ? `hitCount=${cached.hitCount}` : "miss");
  assert(
    cached?.response === testResponse,
    "Cache content matches"
  );

  // Lookup — different model should miss (model filter)
  const cacheMiss = await cache.lookup(testQuery, "other-model", "other-provider");
  assert(cacheMiss === null, "Cache miss on different model/provider");

  // Stats
  const stats = await cache.getStats();
  assert(stats.totalEntries > 0, "Cache stats", `${stats.totalEntries} entries`);

  // 8. Indexer
  console.log("\n8. Indexer");
  const { getIndexer } = await import("../core/indexer.js");
  const indexer = getIndexer();

  // Store single entry
  const testId = await indexer.store(
    "test entry for integration testing — removable",
    "fazai_kb",
    { source: "test-integration", _test: true }
  );
  assert(typeof testId === "string" && testId.length > 0, "Indexer store returns UUID", testId);

  // Delete test entry
  await indexer.delete("fazai_kb", [testId]);
  ok("Indexer delete", `removed ${testId}`);

  // Summary
  console.log(`\n${"=".repeat(40)}`);
  console.log(
    `\n${passed > 0 ? GREEN : ""}${passed} passed${RESET}, ${failed > 0 ? RED : ""}${failed} failed${RESET}`
  );

  pool.destroy();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("[test] Fatal:", error);
  process.exit(1);
});
