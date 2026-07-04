/**
 * Exemplo 01 — Injeção básica de contexto
 *
 * Demonstra como buscar contexto de personalidade + RAG
 * e montar o prompt injetado que substitui o system prompt.
 *
 * Rodar: npx tsx examples/01-basic-injection.ts
 */

import { getInjector, getEmbedder, getQdrantPool } from "../src/index.js";

async function main() {
  // Inicializar componentes
  const pool = getQdrantPool();
  await pool.init();

  const embedder = getEmbedder();
  await embedder.init();
  console.log(`Embedder: ${embedder.getDimension()}d BGE-base-en-v1.5\n`);

  // Query de exemplo
  const userQuery = "como configurar nginx como proxy reverso para Node.js";
  console.log(`Query: "${userQuery}"\n`);

  // Buscar contexto relevante em todas as coleções
  const injector = getInjector();
  const result = await injector.query(userQuery, {
    personalityAlways: true, // Sempre incluir personalidade
    includeSource: true,     // Incluir código fonte indexado
    topK: 3,                 // Top-3 por coleção
    minScore: 0.3,           // Score mínimo
  });

  // Mostrar resultados por coleção
  console.log(`=== Resultados: ${result.totalChunks} chunks (${result.queryTimeMs}ms) ===\n`);

  for (const [name, chunks] of Object.entries({
    personality: result.personality,
    memory: result.memory,
    kb: result.kb,
    source: result.source,
  })) {
    if (chunks.length > 0) {
      console.log(`  ${name}: ${chunks.length} chunks`);
      for (const chunk of chunks) {
        console.log(`    score=${chunk.vectorScore.toFixed(3)} fused=${chunk.fusedScore.toFixed(4)} | ${chunk.text.slice(0, 80)}...`);
      }
      console.log();
    }
  }

  // Montar prompt injetado
  const injectedPrompt = injector.buildInjectedPrompt(result);
  console.log(`=== Prompt Injetado (${injectedPrompt.length} chars) ===\n`);
  console.log(injectedPrompt.slice(0, 500));
  if (injectedPrompt.length > 500) console.log("...\n");

  // Com system prompt original preservado
  const withOriginal = injector.buildInjectedPrompt(
    result,
    "You are a Linux sysadmin expert."
  );
  console.log(`=== Com system prompt original: ${withOriginal.length} chars ===`);

  pool.destroy();
}

main().catch(console.error);
