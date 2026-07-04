#!/usr/bin/env bash
#
# Exemplo 05 — Uso do Proxy HTTP via curl
#
# Inicie o proxy primeiro:
#   npm run dev
#
# Depois rode este script:
#   ./examples/05-proxy-curl.sh
#

PROXY="http://localhost:8787"

echo "=== 1. Health Check ==="
curl -sf "${PROXY}/health" | python3 -m json.tool 2>/dev/null || echo "(proxy offline)"
echo ""

echo "=== 2. Personalidade ==="
curl -sf "${PROXY}/api/personality" | python3 -m json.tool 2>/dev/null || echo "(proxy offline)"
echo ""

echo "=== 3. Busca RAG Manual ==="
curl -sf -X POST "${PROXY}/api/inject" \
  -H "Content-Type: application/json" \
  -d '{"query": "como configurar nginx como proxy reverso", "topK": 3, "includeSource": true}' \
  | python3 -m json.tool 2>/dev/null || echo "(proxy offline)"
echo ""

echo "=== 4. Indexar Conhecimento ==="
curl -sf -X POST "${PROXY}/api/index" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Para listar containers Docker rodando: docker ps. Para listar todos: docker ps -a. Para parar: docker stop <id>.",
    "collection": "fazai_kb",
    "metadata": {"category": "docker", "source": "manual"}
  }' \
  | python3 -m json.tool 2>/dev/null || echo "(proxy offline)"
echo ""

echo "=== 5. Guardar Entrada Avulsa ==="
curl -sf -X POST "${PROXY}/api/store" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Para verificar espaco em disco: df -h",
    "collection": "fazai_kb",
    "payload": {"category": "dica-rapida"}
  }' \
  | python3 -m json.tool 2>/dev/null || echo "(proxy offline)"
echo ""

echo "=== 6. Cache Stats ==="
curl -sf "${PROXY}/api/cache/stats" | python3 -m json.tool 2>/dev/null || echo "(proxy offline)"
echo ""

echo "=== 7. Chat Completion (com injecao) ==="
echo "(Requer LLM alvo rodando em PROXY_TARGET)"
curl -sf -X POST "${PROXY}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-6",
    "messages": [
      {"role": "system", "content": "Voce eh um assistente tecnico."},
      {"role": "user", "content": "como configurar nginx?"}
    ]
  }' 2>/dev/null \
  | python3 -m json.tool 2>/dev/null || echo "(LLM alvo nao acessivel — normal se nao configurado)"
echo ""
