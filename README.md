# qdrant-universal-injection

Middleware universal para injeção de personalidade, cache semântico e RAG via Qdrant.
Funciona com qualquer LLM — substitui o system prompt pela personalidade do FazAI.
IMPORTANT: USE LOCAL ONNX EMBEDDER NEVER USE DEPRECATED OLLAMA EMBEDDER

**Autor:** Dr. Roger Luft (Roginho)
**Licença:** CC-BY-SA-4.0
**Parte do ecossistema de projetos de [Roger Luft — github.com/RLuf](https://github.com/RLuf).**

---

## O que faz

```
Query do usuário
      │
      ▼
┌─────────────────┐     ┌──────────────┐
│  Semantic Cache  │────▶│  Cache Hit?  │──sim──▶ Resposta cached
│  (fazai_cache)   │     └──────────────┘
└─────────────────┘            │ não
                               ▼
┌──────────────────────────────────────────┐
│         FastEmbed ONNX (BGE 768d)        │
│         Embedding estático local         │
└──────────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                     ▼
   ┌─────────────┐    ┌──────────────┐     ┌──────────────┐
   │ personality  │    │   memory     │     │   kb/source  │
   │  3534 pts    │    │   14 pts     │     │   995 pts    │
   └─────────────┘    └──────────────┘     └──────────────┘
          │                    │                     │
          └────────────────────┼─────────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │   ECOA Fusion Score  │
                    │   Personality+RAG    │
                    └─────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Prompt Injetado      │
                    │ (SUBSTITUI system)   │
                    └─────────────────────┘
                               │
                               ▼
                         LLM Provider
```

### ECOA Fusion Scoring

Cada chunk retornado recebe um score composto:

```
fusedScore = vectorScore × collectionWeight × recencyBoost × resonance × legitimacy
```

| Coleção | Weight | Descrição |
|---------|--------|-----------|
| `fazai_personality` | 0.15 | Identidade e estilo de comunicação |
| `fazai_memory` | 0.20 | Contexto conversacional e sessões |
| `fazai_learning` | 0.40 | Soluções validadas e padrões de erro |
| `fazai_kb` | 0.30 | Documentação técnica e referência |
| `fazai_inference` | 0.10 | Políticas de segurança, SLAs, regras |
| `fazai_source` | — | Self-knowledge (código fonte indexado) |

---

## Pré-requisitos

- **Node.js** >= 20.0.0
- **Qdrant** >= 1.14 rodando (padrão: `127.0.0.1:6333`)
- `/etc/fazai/fazai.conf` (opcional — usa defaults se ausente)

---

## Instalação

### Rápida (com instalador)

```bash
git clone <repo> && cd qdrant-universal-injection
./install.sh
```

O instalador verifica pré-requisitos, instala dependências, cria as coleções no Qdrant e roda os testes.

### Manual

```bash
# 1. Instalar dependências
npm install

# 2. Verificar tipagem
npm run typecheck

# 3. Criar coleções no Qdrant (idempotente)
npm run init-collections

# 4. (Opcional) Migrar vetores existentes para BGE-base-en-v1.5
npm run migrate-embeddings

# 5. Compilar para produção
npm run build

# 6. Rodar testes de integração
npm test
```

---

## Modelo de embeddings

O embedder usa **BGE-base-en-v1.5** (ONNX, 768d, ~228MB), servido localmente pelo
`fastembed`. Há duas formas de obtê-lo:

**1. Automática (padrão).** Na primeira execução, o `fastembed` baixa o modelo
sozinho e o cacheia em `local_cache/` (não versionado no git). Nenhuma ação manual.

**2. Mirror privado (offline / pin de versão).** O `install.sh` baixa o modelo de
um espelho protegido por token e o extrai no layout que o `fastembed` espera. O
token faz parte da URL abaixo e é publicado **apenas neste repositório**:

```bash
# Base do mirror (token embutido no path)
MIRROR="https://about.rogerluft.com.br/repo/downloads/aeb646a7010b42f511cb"

# Opção A: tarball completo (recomendado) + verificação de integridade
mkdir -p local_cache
curl -fSL -o local_cache/model.tar.gz "$MIRROR/model-bge-base-en-v1.5.tar.gz"
curl -fsSL "$MIRROR/SHA256SUMS" | grep 'model-bge' | sed 's# raw/.*##' \
  | (cd local_cache && sha256sum -c --ignore-missing) || echo "checksum!"
tar -xzf local_cache/model.tar.gz -C local_cache && rm local_cache/model.tar.gz

# Opção B: arquivos crus individuais (ex.: model_optimized.onnx)
#   curl -fSL -o local_cache/fast-bge-base-en-v1.5/model_optimized.onnx \
#     "$MIRROR/raw/model_optimized.onnx"
```

O `install.sh` faz isso automaticamente (etapa *1b*). Para pular e deixar o
`fastembed` baixar sob demanda: `./install.sh --skip-model`. Para usar outro
espelho: `MODEL_MIRROR=... ./install.sh`.

> O mirror é `noindex`/anti-crawler e exige o token no path — não aparece em
> buscadores. O binário só é acessível por quem tem esta URL completa.

---

## Configuração

O adaptador lê configuração de três fontes (em ordem de prioridade):

1. **Overrides no código** (passados diretamente)
2. **Variáveis de ambiente**
3. **`/etc/fazai/fazai.conf`** (formato `CHAVE=valor`)

### Variáveis principais

| Variável | Default | Descrição |
|----------|---------|-----------|
| `QDRANT_URL` | `http://127.0.0.1:6333` | URL do Qdrant |
| `VECTOR_DIMENSION` | `768` | Dimensão dos vetores |
| `TIMEOUT_QDRANT` | `30000` | Timeout das operações (ms) |
| `ANTHROPIC_API_KEY` | — | API key para proxy |
| `PROXY_PORT` | `8787` | Porta do proxy HTTP |
| `PROXY_TARGET` | `http://127.0.0.1:11434` | LLM alvo |

### Exemplo `/etc/fazai/fazai.conf`

```ini
QDRANT_URL=http://127.0.0.1:6333
VECTOR_DIMENSION=768
TIMEOUT_QDRANT=30000
ANTHROPIC_API_KEY=sk-ant-...
PROXY_PORT=8787
PROXY_TARGET=http://127.0.0.1:11434
```

---

## Uso como Biblioteca

### Injeção de contexto (RAG + Personalidade)

```typescript
import { getInjector, getEmbedder, getQdrantPool } from "qdrant-universal-injection";

// Inicializar
const pool = getQdrantPool();
await pool.init();
const embedder = getEmbedder();
await embedder.init();

// Buscar contexto relevante para uma query
const injector = getInjector();
const result = await injector.query("como configurar nginx como proxy reverso", {
  personalityAlways: true,  // sempre incluir personalidade
  includeSource: true,       // incluir código fonte
  topK: 5,                   // top-K por coleção
});

console.log(`Total: ${result.totalChunks} chunks em ${result.queryTimeMs}ms`);
console.log(`Personality: ${result.personality.length}`);
console.log(`Memory: ${result.memory.length}`);
console.log(`KB: ${result.kb.length}`);
console.log(`Source: ${result.source.length}`);

// Montar o prompt injetado (SUBSTITUI o system prompt)
const prompt = injector.buildInjectedPrompt(result);
console.log(prompt);

// Ou preservar o system prompt original (fica após a personalidade)
const withOriginal = injector.buildInjectedPrompt(result, "You are a helpful assistant.");
```

### Personalidade

```typescript
import { loadPersonality, buildPersonalityPrompt } from "qdrant-universal-injection";

const personality = await loadPersonality();
console.log(`${personality.totalLoaded} traits`);
console.log(`Expertise: ${personality.expertise.join(", ")}`);
console.log(`Style: ${personality.style.join(", ")}`);

const prompt = buildPersonalityPrompt(personality);
// Retorna o prompt completo com identidade FazAI
```

### Indexação de conhecimento

```typescript
import { getIndexer } from "qdrant-universal-injection";

const indexer = getIndexer();

// Indexar texto com chunking automático (1200 chars, 200 overlap, dedup)
const result = await indexer.index(
  "Conteúdo longo sobre Docker e containers...",
  {
    collection: "fazai_kb",
    metadata: { category: "docker", source: "manual" },
  }
);
console.log(`${result.chunksCreated} chunks criados, ${result.duplicatesSkipped} duplicatas`);

// Indexar arquivo inteiro
await indexer.indexFile("/path/to/document.md", "fazai_kb", { category: "docs" });

// Guardar entrada única (sem chunking)
const id = await indexer.store(
  "nginx -t verifica a configuração antes de reload",
  "fazai_kb",
  { category: "dica", component: "nginx" }
);
```

### Cache semântico

```typescript
import { getSemanticCache } from "qdrant-universal-injection";

const cache = getSemanticCache({ threshold: 0.88, ttlMs: 3600000 });
await cache.init();

// Verificar cache
const cached = await cache.lookup("como instalar docker", "claude-opus-4", "anthropic");
if (cached) {
  console.log("Cache HIT:", cached.response);
} else {
  // Chamar LLM e guardar resposta
  const response = "sudo apt install docker.io ...";
  await cache.store("como instalar docker", response, "claude-opus-4", "anthropic");
}

// Estatísticas
const stats = await cache.getStats();
console.log(`${stats.totalEntries} entradas no cache`);
```

### Embedding direto

```typescript
import { getEmbedder } from "qdrant-universal-injection";

const embedder = getEmbedder();
await embedder.init();

// Embedding único
const vector = await embedder.embed("texto para embedar");
console.log(`Dimensão: ${vector.length}`); // 768

// Embedding em batch (mais eficiente)
const vectors = await embedder.embedBatch(["texto 1", "texto 2", "texto 3"]);
console.log(`${vectors.length} vetores`);

// Estatísticas do cache de embeddings
console.log(embedder.getCacheStats()); // { size: 3, maxSize: 10000 }
```

---

## Uso como Proxy HTTP

O proxy intercepta chamadas OpenAI-compatible, injeta contexto do Qdrant, e encaminha ao LLM alvo.

### Iniciar

```bash
# Desenvolvimento (com hot reload)
npm run dev

# Produção
npm run build && npm start
```

### Endpoints

#### `POST /v1/chat/completions` — Proxy com injeção

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-6",
    "messages": [
      {"role": "system", "content": "Instruções base"},
      {"role": "user", "content": "como configurar nginx?"}
    ]
  }'
```

O proxy:
1. Verifica semantic cache → hit = resposta imediata
2. Embeda a última mensagem do usuário
3. Busca contexto em 5+ coleções Qdrant (paralelo)
4. Monta prompt injetado (SUBSTITUI o system message)
5. Encaminha ao LLM alvo (`PROXY_TARGET`)
6. Cacheia a resposta
7. Retorna com metadata `_injection` incluído

Suporta streaming (`"stream": true`).

#### `POST /api/inject` — Busca RAG manual

```bash
curl -X POST http://localhost:8787/api/inject \
  -H "Content-Type: application/json" \
  -d '{"query": "docker segurança", "topK": 3, "includeSource": true}'
```

#### `POST /api/index` — Indexar conhecimento (com chunking)

```bash
curl -X POST http://localhost:8787/api/index \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Texto longo sobre configuração de firewall...",
    "collection": "fazai_kb",
    "metadata": {"category": "security"}
  }'
```

#### `POST /api/store` — Guardar entrada única

```bash
curl -X POST http://localhost:8787/api/store \
  -H "Content-Type: application/json" \
  -d '{
    "text": "ufw allow 22/tcp",
    "collection": "fazai_kb",
    "payload": {"category": "firewall"}
  }'
```

#### `GET /api/personality` — Ver personalidade

```bash
curl http://localhost:8787/api/personality
```

#### `GET /api/cache/stats` — Estatísticas do cache

```bash
curl http://localhost:8787/api/cache/stats
```

#### `POST /api/cache/cleanup` — Limpar entradas expiradas

```bash
curl -X POST http://localhost:8787/api/cache/cleanup
```

#### `GET /health` — Health check

```bash
curl http://localhost:8787/health
```

---

## Scripts npm

| Script | Comando | Descrição |
|--------|---------|-----------|
| `build` | `tsc` | Compilar TypeScript |
| `typecheck` | `tsc --noEmit` | Verificar tipagem |
| `start` | `node dist/proxy/server.js` | Rodar proxy (produção) |
| `dev` | `npx tsx src/proxy/server.ts` | Rodar proxy (desenvolvimento) |
| `test` | `npx tsx src/scripts/test-integration.ts` | Testes de integração |
| `init-collections` | `npx tsx src/scripts/init-collections.ts` | Criar coleções no Qdrant |
| `migrate-embeddings` | `npx tsx src/scripts/migrate-embeddings.ts` | Migrar vetores para BGE |
| `index-source` | `npx tsx src/scripts/index-source.ts` | Indexar código fonte |

### Opções do migrate-embeddings

```bash
# Migrar tudo
npm run migrate-embeddings

# Migrar uma coleção específica
npm run migrate-embeddings -- --collection fazai_personality

# Dry run (não escreve)
npm run migrate-embeddings -- --dry-run

# Batch size customizado
npm run migrate-embeddings -- --batch-size 16
```

---

## Coleções Qdrant

7 coleções, todas 768d Cosine, HNSW com ef_construct=200:

| Coleção | Pontos | Descrição |
|---------|--------|-----------|
| `fazai_personality` | 3534 | Traços comportamentais (diálogos) |
| `fazai_memory` | 14 | Contexto conversacional |
| `fazai_learning` | 0 | Soluções validadas |
| `fazai_kb` | 3 | Documentação e referência |
| `fazai_inference` | 0 | Regras e políticas |
| `fazai_source` | 992 | Código fonte do FazAI |
| `fazai_semantic_cache` | — | Cache de respostas |

---

## Arquitetura de Módulos

```
src/
├── config.ts                    # Leitor de /etc/fazai/fazai.conf
├── index.ts                     # Re-exports públicos
├── core/
│   ├── embedder.ts              # FastEmbed ONNX (BGE-base-en-v1.5, 768d)
│   ├── qdrant-client.ts         # Pool com CircuitBreaker
│   ├── injector.ts              # Busca multi-collection + ECOA scoring
│   └── indexer.ts               # Indexação bidirecional com chunking
├── cache/
│   └── semantic-cache.ts        # GPTCache via Qdrant
├── middleware/
│   └── personality-guard.ts     # Carregador de personalidade
├── proxy/
│   └── server.ts                # HTTP proxy OpenAI-compatible
└── scripts/
    ├── init-collections.ts      # Criação de coleções
    ├── migrate-embeddings.ts    # Migração de vetores
    └── test-integration.ts      # Suite de testes
```

### Dependências

| Pacote | Versão | Função |
|--------|--------|--------|
| `fastembed` | 2.1.0 | Embedding ONNX estático (sem servidor) |
| `@qdrant/js-client-rest` | 1.16.2 | Client REST para Qdrant |
| `express` | 5.1.0 | HTTP proxy server |
| `uuid` | 11.1.0 | Geração de IDs |
| `dotenv` | 16.5.0 | Variáveis de ambiente |

---

## Integração com fazai-ng

```typescript
// No fazai-ng, substituir o embedder Ollama pelo adaptador:
import {
  getInjector,
  getEmbedder,
  getQdrantPool,
  loadPersonality,
  buildPersonalityPrompt,
} from "qdrant-universal-injection";

// O adaptador usa FastEmbed ONNX — sem dependência de Ollama para embeddings
const embedder = getEmbedder();
await embedder.init(); // Baixa modelo ONNX na primeira execução

// Substituir system prompt na chamada ao LLM:
const injector = getInjector();
const injection = await injector.query(userMessage);
const systemPrompt = injector.buildInjectedPrompt(injection);
// systemPrompt agora contém personalidade + RAG completo
```

---

## Notas Técnicas

- **RAM**: Otimizado para servidor com 300 GB RAM — vetores e HNSW em memória
- **Embedder**: ONNX Runtime local — sem dependência de Ollama ou API externa
- **Cache de embeddings**: LRU de 10.000 entradas com SHA-256
- **Circuit Breaker**: 3 falhas consecutivas = circuito aberto, reset em 30s
- **Health check**: Verificação automática a cada 5 minutos
- **Cache semântico**: Threshold 0.88, TTL 1h, cleanup automático a cada 10min
