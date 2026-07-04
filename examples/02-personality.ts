/**
 * Exemplo 02 — Personalidade do FazAI
 *
 * Carrega a personalidade do Qdrant e mostra
 * como o prompt de identidade é construído.
 *
 * Rodar: npx tsx examples/02-personality.ts
 */

import { getQdrantPool } from "../src/core/qdrant-client.js";
import { getEmbedder } from "../src/core/embedder.js";
import {
  loadPersonality,
  buildPersonalityPrompt,
  clearPersonalityCache,
} from "../src/middleware/personality-guard.js";

async function main() {
  // Init
  const pool = getQdrantPool();
  await pool.init();
  const embedder = getEmbedder();
  await embedder.init();

  // Limpar cache para forçar reload
  clearPersonalityCache();

  // Carregar personalidade
  console.log("Carregando personalidade do Qdrant...\n");
  const personality = await loadPersonality();

  console.log(`Total de traits: ${personality.totalLoaded}`);
  console.log(`Estilo: ${personality.style.join(", ")}`);
  console.log(`Expertise: ${personality.expertise.join(", ")}`);

  // Top 5 traits por peso (emotional_layer × ressonancia)
  console.log("\n=== Top 5 Traits por Peso ===\n");
  for (const trait of personality.traits.slice(0, 5)) {
    console.log(`  [${trait.weight.toFixed(2)}] ${trait.conversationName}`);
    if (trait.summary) {
      console.log(`         ${trait.summary.slice(0, 100)}...`);
    }
  }

  // Prompt gerado
  console.log("\n=== Prompt de Personalidade ===\n");
  const prompt = buildPersonalityPrompt(personality);
  console.log(prompt);

  pool.destroy();
}

main().catch(console.error);
