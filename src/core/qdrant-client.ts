import { QdrantClient } from "@qdrant/js-client-rest";
import { loadConfig, type FazAIConfig } from "../config.js";

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: "closed" | "open" | "half-open";
}

const FAILURE_THRESHOLD = 3;
const RESET_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SOCKET_RETRY_MAX = 2;

/**
 * Detecta se um erro é de socket stale (UND_ERR_SOCKET).
 * Node 25 + undici: Qdrant fecha keep-alive em ~5s,
 * undici tenta reusar → SocketError: other side closed.
 */
function isStaleSocketError(error: unknown): boolean {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === "UND_ERR_SOCKET") return true;
    if (error.message.includes("other side closed")) return true;
    if (error.message.includes("fetch failed")) return true;
  }
  return false;
}

export class QdrantPool {
  private client: QdrantClient;
  private breaker: CircuitBreakerState = {
    failures: 0,
    lastFailure: 0,
    state: "closed",
  };
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private config: FazAIConfig;

  constructor(config?: Partial<FazAIConfig>) {
    this.config = loadConfig(config);
    this.client = this.createClient();
  }

  private createClient(): QdrantClient {
    const url = new URL(this.config.qdrantUrl);
    return new QdrantClient({
      host: url.hostname,
      port: parseInt(url.port || "6333", 10),
      https: url.protocol === "https:",
      timeout: this.config.timeoutQdrant,
    });
  }

  /**
   * Recria o client quando socket fica stale.
   * Necessário porque undici pool interno mantém referência
   * a sockets mortos após keep-alive timeout do Qdrant (~5s).
   */
  private refreshClient(): void {
    this.client = this.createClient();
  }

  async init(): Promise<void> {
    await this.healthCheck();
    this.healthTimer = setInterval(
      () => void this.healthCheck(),
      HEALTH_CHECK_INTERVAL_MS
    );
  }

  private async healthCheck(): Promise<boolean> {
    try {
      await this.client.getCollections();
      if (this.breaker.state === "open" || this.breaker.state === "half-open") {
        this.breaker.state = "closed";
        this.breaker.failures = 0;
      }
      return true;
    } catch (error) {
      if (isStaleSocketError(error)) {
        // Socket stale no health check — recria client e tenta de novo
        this.refreshClient();
        try {
          await this.client.getCollections();
          return true;
        } catch {
          this.recordFailure();
          return false;
        }
      }
      this.recordFailure();
      return false;
    }
  }

  private recordFailure(): void {
    this.breaker.failures++;
    this.breaker.lastFailure = Date.now();
    if (this.breaker.failures >= FAILURE_THRESHOLD) {
      this.breaker.state = "open";
    }
  }

  private canExecute(): boolean {
    if (this.breaker.state === "closed") return true;
    if (this.breaker.state === "open") {
      if (Date.now() - this.breaker.lastFailure > RESET_TIMEOUT_MS) {
        this.breaker.state = "half-open";
        return true;
      }
      return false;
    }
    // half-open: allow one request
    return true;
  }

  async execute<T>(fn: (client: QdrantClient) => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      throw new Error(
        `[qdrant-pool] Circuit breaker OPEN — ${this.breaker.failures} failures, ` +
          `reset in ${Math.max(0, RESET_TIMEOUT_MS - (Date.now() - this.breaker.lastFailure))}ms`
      );
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= SOCKET_RETRY_MAX; attempt++) {
      try {
        const result = await fn(this.client);
        if (this.breaker.state === "half-open") {
          this.breaker.state = "closed";
          this.breaker.failures = 0;
        }
        return result;
      } catch (error) {
        lastError = error;

        if (isStaleSocketError(error) && attempt < SOCKET_RETRY_MAX) {
          // Socket stale: recria client e tenta de novo
          this.refreshClient();
          continue;
        }

        // Erro real (não socket stale) ou retries esgotados
        this.recordFailure();
        throw error;
      }
    }

    // Nunca chega aqui, mas TypeScript precisa
    throw lastError;
  }

  getClient(): QdrantClient {
    return this.client;
  }

  getState(): CircuitBreakerState {
    return { ...this.breaker };
  }

  destroy(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
}

// Singleton
let _pool: QdrantPool | null = null;

export function getQdrantPool(config?: Partial<FazAIConfig>): QdrantPool {
  if (!_pool) {
    _pool = new QdrantPool(config);
  }
  return _pool;
}
