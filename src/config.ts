import { readFileSync, existsSync } from "node:fs";

export interface FazAIConfig {
  qdrantUrl: string;
  ollamaBaseUrl: string;
  ollamaEmbedUrl: string;
  vectorDimension: number;
  vectorDistance: "cosine" | "euclid" | "dot";

  // API keys (for fallback providers)
  anthropicApiKey?: string;
  anthropicOAuthToken?: string;
  openrouterApiKey?: string;
  openaiApiKey?: string;
  googleApiKey?: string;
  perplexityApiKey?: string;

  // Timeouts
  timeoutQdrant: number;
  timeoutOllama: number;
  timeoutDefault: number;

  // Provider fallback order
  providerFallbackOrder: string[];

  // Proxy config
  proxyPort: number;
  proxyTarget: string;

  // Paths
  configPath: string;
}

function parseFazAIConf(filePath: string): Record<string, string> {
  const entries: Record<string, string> = {};
  if (!existsSync(filePath)) return entries;

  const content = readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    entries[key] = value;
  }
  return entries;
}

export function loadConfig(overrides?: Partial<FazAIConfig>): FazAIConfig {
  const configPath =
    overrides?.configPath ??
    process.env["FAZAI_CONFIG_PATH"] ??
    "/etc/fazai/fazai.conf";

  const conf = parseFazAIConf(configPath);

  const env = process.env;

  return {
    qdrantUrl:
      overrides?.qdrantUrl ??
      env["QDRANT_URL"] ??
      conf["QDRANT_URL"] ??
      "http://127.0.0.1:6333",

    ollamaBaseUrl:
      overrides?.ollamaBaseUrl ??
      env["OLLAMA_BASE_URL"] ??
      conf["OLLAMA_BASE_URL"] ??
      "http://192.168.0.101:11434",

    ollamaEmbedUrl:
      overrides?.ollamaEmbedUrl ??
      env["OLLAMA_EMBED_URL"] ??
      conf["OLLAMA_EMBED_URL"] ??
      "http://192.168.0.101:11434",

    vectorDimension:
      overrides?.vectorDimension ??
      parseInt(env["VECTOR_DIMENSION"] ?? conf["VECTOR_DIMENSION"] ?? "768", 10),

    vectorDistance:
      (overrides?.vectorDistance ??
        env["VECTOR_DISTANCE"] ??
        conf["VECTOR_DISTANCE"] ??
        "cosine") as FazAIConfig["vectorDistance"],

    anthropicApiKey:
      overrides?.anthropicApiKey ?? env["ANTHROPIC_API_KEY"] ?? conf["ANTHROPIC_API_KEY"],
    anthropicOAuthToken:
      overrides?.anthropicOAuthToken ??
      env["CLAUDE_CODE_OAUTH_TOKEN"] ??
      env["ANTHROPIC_OAUTH_TOKEN"] ??
      conf["ANTHROPIC_OAUTH_TOKEN"],
    openrouterApiKey:
      overrides?.openrouterApiKey ?? env["OPENROUTER_API_KEY"] ?? conf["OPENROUTER_API_KEY"],
    openaiApiKey:
      overrides?.openaiApiKey ?? env["OPENAI_API_KEY"] ?? conf["OPENAI_API_KEY"],
    googleApiKey:
      overrides?.googleApiKey ??
      env["GOOGLE_API_KEY"] ??
      conf["GOOGLE_API_KEY"] ??
      env["GEMINI_API_KEY"] ??
      conf["GEMINI_API_KEY"],
    perplexityApiKey:
      overrides?.perplexityApiKey ?? env["PERPLEXITY_API_KEY"] ?? conf["PERPLEXITY_API_KEY"],

    timeoutQdrant:
      overrides?.timeoutQdrant ??
      parseInt(env["TIMEOUT_QDRANT"] ?? conf["TIMEOUT_QDRANT"] ?? "30000", 10),
    timeoutOllama:
      overrides?.timeoutOllama ??
      parseInt(env["TIMEOUT_OLLAMA"] ?? conf["TIMEOUT_OLLAMA"] ?? "180000", 10),
    timeoutDefault:
      overrides?.timeoutDefault ??
      parseInt(env["TIMEOUT_DEFAULT"] ?? conf["TIMEOUT_DEFAULT"] ?? "60000", 10),

    providerFallbackOrder: (
      overrides?.providerFallbackOrder ??
      (env["PROVIDER_FALLBACK_ORDER"] ?? conf["PROVIDER_FALLBACK_ORDER"] ?? "anthropic,ollama,openrouter,perplexity")
        .split(",")
        .map((s) => s.trim())
    ),

    proxyPort:
      overrides?.proxyPort ??
      parseInt(env["PROXY_PORT"] ?? "8787", 10),

    proxyTarget:
      overrides?.proxyTarget ??
      env["PROXY_TARGET"] ??
      "http://127.0.0.1:11434",

    configPath,
  };
}
