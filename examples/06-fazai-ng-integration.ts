/**
 * Exemplo 06 — Integração com fazai-ng
 *
 * Mostra como substituir o embedder Ollama do fazai-ng
 * pelo adaptador universal. O fluxo completo:
 *
 *   1. Receber mensagem do usuário
 *   2. Buscar contexto no Qdrant (personalidade + RAG)
 *   3. Montar prompt injetado (substitui system prompt)
 *   4. Verificar cache semântico
 *   5. Enviar ao LLM com prompt injetado
 *   6. Cachear resposta
 *
 * Rodar: npx tsx examples/06-fazai-ng-integration.ts
 */

import {
  getInjector,
  getEmbedder,
  getQdrantPool,
  getSemanticCache,
  loadPersonality,
} from "../src/index.js";

// Simula o fluxo do fazai-ng
async function handleUserMessage(userMessage: string) {
  const model = "claude-opus-4-6";
  const provider = "anthropic";

  console.log(`\n[user] ${userMessage}\n`);

  // 1. Verificar cache semântico
  const cache = getSemanticCache();
  await cache.init();

  const cached = await cache.lookup(userMessage, model, provider);
  if (cached) {
    console.log(`[cache] HIT (hitCount=${cached.hitCount})`);
    console.log(`[assistant] ${cached.response}\n`);
    return cached.response;
  }
  console.log("[cache] MISS — buscando contexto...");

  // 2. Buscar contexto em todas as coleções
  const injector = getInjector();
  const injection = await injector.query(userMessage, {
    personalityAlways: true,
    includeSource: true,
  });

  console.log(`[injector] ${injection.totalChunks} chunks em ${injection.queryTimeMs}ms`);
  console.log(`  personality: ${injection.personality.length}`);
  console.log(`  memory: ${injection.memory.length}`);
  console.log(`  kb: ${injection.kb.length}`);
  console.log(`  source: ${injection.source.length}`);

  // 3. Montar prompt injetado (SUBSTITUI o system prompt)
  const systemPrompt = injector.buildInjectedPrompt(injection);
  console.log(`[prompt] ${systemPrompt.length} chars injetados`);

  // 4. Aqui você chamaria o LLM real com o systemPrompt injetado:
  //
  //    const response = await anthropic.messages.create({
  //      model,
  //      system: systemPrompt,
  //      messages: [{ role: "user", content: userMessage }],
  //    });
  //    const assistantContent = response.content[0].text;

  // Simulação da resposta
  const assistantContent = `[Simulação] Resposta do ${model} com ${injection.totalChunks} chunks de contexto injetados.`;

  // 6. Cachear resposta
  await cache.store(userMessage, assistantContent, model, provider);
  console.log("[cache] Resposta armazenada");

  console.log(`[assistant] ${assistantContent}\n`);
  return assistantContent;
}

async function main() {
  // Inicializar
  const pool = getQdrantPool();
  await pool.init();
  const embedder = getEmbedder();
  await embedder.init();

  // Carregar personalidade (preload)
  const personality = await loadPersonality();
  console.log(`Personalidade: ${personality.totalLoaded} traits, estilo: ${personality.style.join(", ")}`);
  console.log(`Expertise: ${personality.expertise.join(", ")}`);

  // Simular 3 mensagens de usuário
  await handleUserMessage("como configurar nginx como proxy reverso");
  await handleUserMessage("qual a diferença entre docker e podman");
  await handleUserMessage("como configurar nginx como proxy reverso"); // Deve dar cache hit

  pool.destroy();
}

main().catch(console.error);
