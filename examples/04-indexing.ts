/**
 * Exemplo 04 — Indexação de Conhecimento
 *
 * Demonstra como indexar textos, arquivos e entradas avulsas
 * no Qdrant com chunking automático e deduplicação.
 *
 * Rodar: npx tsx examples/04-indexing.ts
 */

import { getQdrantPool } from "../src/core/qdrant-client.js";
import { getEmbedder } from "../src/core/embedder.js";
import { getIndexer } from "../src/core/indexer.js";

async function main() {
  // Init
  const pool = getQdrantPool();
  await pool.init();
  const embedder = getEmbedder();
  await embedder.init();

  const indexer = getIndexer();

  // 1. Indexar texto longo com chunking automático
  console.log("=== 1. Indexação com chunking ===\n");

  const longText = `
    Nginx como Proxy Reverso para Node.js

    Para configurar nginx como proxy reverso para uma aplicação Node.js,
    primeiro instale o nginx: sudo apt install nginx.

    Depois crie um arquivo de configuração em /etc/nginx/sites-available/app:

    server {
        listen 80;
        server_name exemplo.com;

        location / {
            proxy_pass http://localhost:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
        }
    }

    Ative com: sudo ln -s /etc/nginx/sites-available/app /etc/nginx/sites-enabled/
    Teste: sudo nginx -t
    Reload: sudo systemctl reload nginx

    Troubleshooting:
    - 502 Bad Gateway: Node.js não está rodando na porta 3000
    - 403 Forbidden: Permissões do diretório root
    - Timeout: Aumente proxy_read_timeout e proxy_connect_timeout
  `.trim();

  const result = await indexer.index(longText, {
    collection: "fazai_kb",
    metadata: {
      category: "nginx",
      component: "proxy",
      source: "example-04",
    },
    chunkSize: 500,    // Tamanho do chunk (chars)
    chunkOverlap: 100, // Sobreposição entre chunks
    dedup: true,       // Verificar duplicatas (threshold 0.90)
  });

  console.log(`  Chunks criados: ${result.chunksCreated}`);
  console.log(`  Duplicatas puladas: ${result.duplicatesSkipped}`);
  console.log(`  Tempo: ${result.totalTimeMs}ms\n`);

  // 2. Armazenar entrada única (sem chunking)
  console.log("=== 2. Entrada avulsa ===\n");

  const id = await indexer.store(
    "Para reiniciar nginx sem downtime: sudo nginx -s reload",
    "fazai_kb",
    {
      category: "dica",
      component: "nginx",
      source: "example-04",
    }
  );
  console.log(`  Armazenado com ID: ${id}\n`);

  // 3. Deletar entradas
  console.log("=== 3. Deletar ===\n");

  await indexer.delete("fazai_kb", [id]);
  console.log(`  Deletado: ${id}\n`);

  pool.destroy();
}

main().catch(console.error);
