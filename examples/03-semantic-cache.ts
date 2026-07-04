/**
 * Exemplo 03 — Cache Semântico
 *
 * Demonstra o GPTCache via Qdrant: armazenar respostas
 * e recuperar por similaridade semântica.
 *
 * Rodar: npx tsx examples/03-semantic-cache.ts
 */

import { getQdrantPool } from "../src/core/qdrant-client.js";
import { getEmbedder } from "../src/core/embedder.js";
import { getSemanticCache } from "../src/cache/semantic-cache.js";

async function main() {
  // Init
  const pool = getQdrantPool();
  await pool.init();
  const embedder = getEmbedder();
  await embedder.init();

  const cache = getSemanticCache({
    threshold: 0.88, // Similaridade mínima para hit
    ttlMs: 3600000,  // TTL: 1 hora
  });
  await cache.init();

  // 1. Armazenar respostas no cache
  console.log("=== Armazenando respostas ===\n");

  await cache.store(
    "como instalar docker no ubuntu",
    "sudo apt update && sudo apt install docker.io && sudo systemctl enable docker",
    "claude-opus-4",
    "anthropic"
  );
  console.log("  Stored: 'como instalar docker no ubuntu'");

  await cache.store(
    "como verificar status do nginx",
    "systemctl status nginx && nginx -t && journalctl -u nginx -n 20",
    "claude-opus-4",
    "anthropic"
  );
  console.log("  Stored: 'como verificar status do nginx'\n");

  // 2. Buscar com query similar (não idêntica)
  console.log("=== Buscando por similaridade ===\n");

  // Query similar — deve dar hit
  const hit1 = await cache.lookup(
    "instalar docker no linux ubuntu",
    "claude-opus-4",
    "anthropic"
  );
  if (hit1) {
    console.log(`  HIT: "instalar docker no linux ubuntu"`);
    console.log(`  Resposta: ${hit1.response}`);
    console.log(`  Hit count: ${hit1.hitCount}\n`);
  } else {
    console.log(`  MISS: "instalar docker no linux ubuntu"\n`);
  }

  // Query diferente — deve dar miss
  const miss1 = await cache.lookup(
    "configurar firewall com iptables",
    "claude-opus-4",
    "anthropic"
  );
  console.log(`  ${miss1 ? "HIT" : "MISS"}: "configurar firewall com iptables"\n`);

  // Query com modelo diferente — deve dar miss (filtro por modelo)
  const miss2 = await cache.lookup(
    "como instalar docker no ubuntu",
    "gpt-4o",
    "openai"
  );
  console.log(`  ${miss2 ? "HIT" : "MISS"}: mesma query mas modelo diferente (gpt-4o)\n`);

  // 3. Estatísticas
  const stats = await cache.getStats();
  console.log(`=== Estatísticas ===`);
  console.log(`  Entradas no cache: ${stats.totalEntries}\n`);

  // 4. Cleanup manual
  const removed = await cache.cleanup();
  console.log(`  Cleanup: ${removed} entradas expiradas removidas`);

  cache.destroy();
  pool.destroy();
}

main().catch(console.error);
