#!/usr/bin/env bash
#
# install.sh — Instalador do qdrant-universal-injection
#
# Verifica pre-requisitos, instala dependencias, cria colecoes,
# migra vetores e roda testes de integracao.
#
# Uso:
#   ./install.sh              # Instalacao completa
#   ./install.sh --skip-migrate  # Pular migracao de vetores
#   ./install.sh --migrate-only  # Rodar apenas migracao
#   ./install.sh --test-only     # Rodar apenas testes
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QDRANT_URL="${QDRANT_URL:-http://127.0.0.1:6333}"
FAZAI_CONF="/etc/fazai/fazai.conf"
SKIP_MIGRATE=false
MIGRATE_ONLY=false
TEST_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --skip-migrate) SKIP_MIGRATE=true ;;
    --migrate-only) MIGRATE_ONLY=true ;;
    --test-only)    TEST_ONLY=true ;;
    --help|-h)
      echo "Uso: ./install.sh [--skip-migrate] [--migrate-only] [--test-only]"
      exit 0
      ;;
  esac
done

info()  { echo -e "${CYAN}[info]${NC}  $1"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $1"; }
fail()  { echo -e "${RED}[fail]${NC}  $1"; exit 1; }

header() {
  echo ""
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  $1${NC}"
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ── 0. Banner ──────────────────────────────────

echo ""
echo -e "${BOLD}  qdrant-universal-injection${NC}"
echo -e "  Middleware de injecao de personalidade via Qdrant"
echo -e "  FastEmbed ONNX | ECOA Scoring | Semantic Cache"
echo ""

# ── 1. Pre-requisitos ──────────────────────────

header "1. Verificando pre-requisitos"

# Node.js >= 20
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ]; then
    ok "Node.js $(node -v)"
  else
    fail "Node.js >= 20 necessario (encontrado $(node -v))"
  fi
else
  fail "Node.js nao encontrado. Instale Node.js >= 20: https://nodejs.org"
fi

# npm
if command -v npm &>/dev/null; then
  ok "npm $(npm -v)"
else
  fail "npm nao encontrado"
fi

# Qdrant
info "Verificando Qdrant em ${QDRANT_URL}..."
if curl -sf "${QDRANT_URL}/collections" >/dev/null 2>&1; then
  QDRANT_VER=$(curl -sf "${QDRANT_URL}" | grep -o '"version":"[^"]*"' | cut -d'"' -f4 2>/dev/null || echo "desconhecida")
  ok "Qdrant v${QDRANT_VER} em ${QDRANT_URL}"
else
  fail "Qdrant nao acessivel em ${QDRANT_URL}. Inicie o Qdrant e tente novamente."
fi

# fazai.conf (opcional)
if [ -f "$FAZAI_CONF" ]; then
  ok "Config: ${FAZAI_CONF}"
else
  warn "Config ${FAZAI_CONF} nao encontrado — usando defaults"
fi

if $TEST_ONLY; then
  header "Rodando testes"
  cd "$SCRIPT_DIR"
  node --import tsx/esm src/scripts/test-integration.ts
  exit $?
fi

if $MIGRATE_ONLY; then
  header "Rodando migracao"
  cd "$SCRIPT_DIR"
  node --import tsx/esm src/scripts/migrate-embeddings.ts
  exit $?
fi

# ── 2. Dependencias ────────────────────────────

header "2. Instalando dependencias"

cd "$SCRIPT_DIR"

if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
  info "node_modules existe, verificando atualizacoes..."
  npm install --no-audit --no-fund 2>&1 | tail -3
else
  info "Instalando dependencias (primeira vez)..."
  npm install --no-audit --no-fund 2>&1 | tail -5
fi

ok "Dependencias instaladas"

# ── 3. Verificacao de tipos ────────────────────

header "3. Verificando tipagem TypeScript"

if npx tsc --noEmit 2>&1; then
  ok "Zero erros de tipagem"
else
  fail "Erros de tipagem encontrados (ver acima)"
fi

# ── 4. Colecoes Qdrant ─────────────────────────

header "4. Criando colecoes no Qdrant"

info "Inicializando 7 colecoes com vetores 768d Cosine..."
node --import tsx/esm src/scripts/init-collections.ts 2>&1 | grep -E '^\[init\]' | while read -r line; do
  echo -e "  ${GREEN}${line}${NC}"
done

ok "Colecoes prontas"

# ── 5. Migracao de vetores ─────────────────────

if ! $SKIP_MIGRATE; then
  header "5. Migracao de vetores (nomic-embed-text → BGE-base-en-v1.5)"

  # Verificar se migracao eh necessaria
  PERSONALITY_COUNT=$(curl -sf "${QDRANT_URL}/collections/fazai_personality" | grep -o '"points_count":[0-9]*' | cut -d: -f2 2>/dev/null || echo "0")

  if [ "$PERSONALITY_COUNT" -gt 0 ]; then
    warn "AVISO: A migracao re-embeda todos os pontos existentes."
    warn "fazai_personality: ${PERSONALITY_COUNT} pontos"
    warn "Isso pode levar 5-30 minutos dependendo da quantidade."
    echo ""
    read -rp "  Deseja migrar agora? [S/n] " REPLY
    REPLY=${REPLY:-S}

    if [[ "$REPLY" =~ ^[Ss]$ ]]; then
      info "Iniciando migracao..."
      node --import tsx/esm src/scripts/migrate-embeddings.ts 2>&1 | grep -E '^\[migrate\]|^\s+\[' | while read -r line; do
        echo -e "  ${CYAN}${line}${NC}"
      done
      ok "Migracao concluida"
    else
      warn "Migracao pulada. Rode depois com: npm run migrate-embeddings"
    fi
  else
    info "Nenhum dado existente — migracao nao necessaria"
    ok "Colecoes vazias, prontas para indexacao"
  fi
else
  info "Migracao pulada (--skip-migrate)"
fi

# ── 6. Build ───────────────────────────────────

header "6. Compilando para producao"

npx tsc 2>&1
ok "Build completo: dist/"

# ── 7. Testes ──────────────────────────────────

header "7. Rodando testes de integracao"

if node --import tsx/esm src/scripts/test-integration.ts 2>&1; then
  ok "Todos os testes passaram"
else
  warn "Alguns testes falharam (ver saida acima)"
fi

# ── 8. Resumo ──────────────────────────────────

header "Instalacao completa!"

echo ""
echo -e "  ${BOLD}Proximos passos:${NC}"
echo ""
echo -e "  ${CYAN}Proxy HTTP:${NC}"
echo -e "    npm run dev           # Desenvolvimento (hot reload)"
echo -e "    npm start             # Producao"
echo ""
echo -e "  ${CYAN}Endpoints:${NC}"
echo -e "    POST /v1/chat/completions  — Proxy com injecao"
echo -e "    POST /api/inject           — Busca RAG manual"
echo -e "    POST /api/index            — Indexar conhecimento"
echo -e "    GET  /api/personality       — Ver personalidade"
echo -e "    GET  /health               — Health check"
echo ""
echo -e "  ${CYAN}Como biblioteca:${NC}"
echo -e "    import { getInjector } from 'qdrant-universal-injection'"
echo -e "    Ver examples/ para exemplos completos"
echo ""
