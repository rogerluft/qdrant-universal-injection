import express from "express";
import { loadConfig } from "../config.js";
import { getQdrantPool } from "../core/qdrant-client.js";
import { getEmbedder } from "../core/embedder.js";
import { getInjector } from "../core/injector.js";
import { getIndexer } from "../core/indexer.js";
import { getSemanticCache } from "../cache/semantic-cache.js";
import {
  loadPersonality,
  buildPersonalityPrompt,
} from "../middleware/personality-guard.js";

const config = loadConfig();

const app = express();
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (_req, res) => {
  const pool = getQdrantPool();
  res.json({
    status: "ok",
    qdrant: pool.getState(),
    embedder: getEmbedder().isReady,
    cache: getEmbedder().getCacheStats(),
  });
});

// POST /v1/chat/completions — OpenAI-compatible proxy with injection
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const body = req.body as {
      model?: string;
      messages?: Array<{ role: string; content: string }>;
      stream?: boolean;
      [key: string]: unknown;
    };

    const messages = body.messages ?? [];
    const model = body.model ?? "unknown";

    // Extract user's last message for context enrichment
    const lastUserMsg = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const queryText = lastUserMsg?.content ?? "";

    // Check semantic cache first
    const cache = getSemanticCache();
    await cache.init();
    const cached = await cache.lookup(queryText, model, "proxy");
    if (cached) {
      res.json({
        id: `cache-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: cached.response },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        _cache: { hit: true, hitCount: cached.hitCount },
      });
      return;
    }

    // Inject context from Qdrant collections
    const injector = getInjector();
    const injection = await injector.query(queryText, {
      personalityAlways: true,
    });

    // Build the injected system prompt (REPLACES original)
    const injectedSystemPrompt = injector.buildInjectedPrompt(injection);

    // Replace or prepend system message
    const enrichedMessages = messages.map((msg) => {
      if (msg.role === "system") {
        // Original system prompt goes AFTER personality
        return {
          role: "system",
          content: injector.buildInjectedPrompt(injection, msg.content),
        };
      }
      return msg;
    });

    // If no system message existed, add one
    const hasSystem = enrichedMessages.some((m) => m.role === "system");
    if (!hasSystem) {
      enrichedMessages.unshift({
        role: "system",
        content: injectedSystemPrompt,
      });
    }

    // Forward to target LLM
    const targetUrl = `${config.proxyTarget}/v1/chat/completions`;
    const forwardBody = {
      ...body,
      messages: enrichedMessages,
    };

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.anthropicApiKey
          ? { Authorization: `Bearer ${config.anthropicApiKey}` }
          : {}),
      },
      body: JSON.stringify(forwardBody),
      signal: AbortSignal.timeout(config.timeoutDefault),
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.status(response.status).json({
        error: { message: errorText, type: "upstream_error" },
      });
      return;
    }

    // Stream passthrough
    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let fullContent = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            res.write(chunk);

            // Try to extract content for caching
            for (const line of chunk.split("\n")) {
              if (line.startsWith("data: ") && line !== "data: [DONE]") {
                try {
                  const data = JSON.parse(line.slice(6)) as {
                    choices?: Array<{
                      delta?: { content?: string };
                    }>;
                  };
                  const delta = data.choices?.[0]?.delta?.content;
                  if (delta) fullContent += delta;
                } catch { /* ignore parse errors in stream */ }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        res.end();

        // Cache the complete response (fire-and-forget)
        if (fullContent) {
          void cache.store(queryText, fullContent, model, "proxy");
        }
      }
      return;
    }

    // Non-streaming response
    const responseBody = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      [key: string]: unknown;
    };

    // Cache the response
    const assistantContent = responseBody.choices?.[0]?.message?.content;
    if (assistantContent) {
      void cache.store(queryText, assistantContent, model, "proxy");
    }

    // Add injection metadata
    (responseBody as Record<string, unknown>)["_injection"] = {
      collections: Object.fromEntries(
        (["personality", "memory", "learning", "kb", "inference", "source"] as const).map(
          (k) => [k, injection[k].length]
        )
      ),
      totalChunks: injection.totalChunks,
      queryTimeMs: injection.queryTimeMs,
    };

    res.json(responseBody);
  } catch (error) {
    console.error("[proxy] Error:", error);
    res.status(500).json({
      error: {
        message: (error as Error).message,
        type: "internal_error",
      },
    });
  }
});

// POST /v1/messages — Anthropic Messages API proxy with injection
// Headers exatos: Authorization: Bearer, anthropic-beta, user-agent, x-app, anthropic-version
// System field: array [{type: "text", text: "..."}]
app.post("/v1/messages", async (req, res) => {
  try {
    const body = req.body as {
      model?: string;
      max_tokens?: number;
      system?: Array<{ type: string; text: string }> | string;
      messages?: Array<{ role: string; content: string }>;
      stream?: boolean;
      [key: string]: unknown;
    };

    const messages = body.messages ?? [];
    const model = body.model ?? "unknown";

    // Extract user's last message for context enrichment
    const lastUserMsg = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const queryText =
      typeof lastUserMsg?.content === "string"
        ? lastUserMsg.content
        : "";

    // Check semantic cache first
    const cache = getSemanticCache();
    await cache.init();
    const cached = await cache.lookup(queryText, model, "anthropic");
    if (cached) {
      console.log(`[proxy] /v1/messages cache HIT (${cached.hitCount}x)`);
      res.json({
        id: `cache-${Date.now()}`,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: cached.response }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
        _cache: { hit: true, hitCount: cached.hitCount },
      });
      return;
    }

    // Inject context from Qdrant collections
    const injector = getInjector();
    const injection = await injector.query(queryText, {
      personalityAlways: true,
    });

    console.log(
      `[proxy] /v1/messages inject: ${injection.totalChunks} chunks in ${injection.queryTimeMs}ms`
    );

    // Build injected system prompt
    // Extract original system text (array or string format)
    let originalSystem = "";
    if (Array.isArray(body.system)) {
      originalSystem = body.system
        .filter((s) => s.type === "text")
        .map((s) => s.text)
        .join("\n");
    } else if (typeof body.system === "string") {
      originalSystem = body.system;
    }

    const injectedPrompt = originalSystem
      ? injector.buildInjectedPrompt(injection, originalSystem)
      : injector.buildInjectedPrompt(injection);

    // Rebuild system as Anthropic array format
    const enrichedSystem: Array<{ type: string; text: string }> = [
      { type: "text", text: injectedPrompt },
    ];

    // Resolve auth: OAuth token > API key
    // OAuth usa Bearer + anthropic-beta headers (Roginho's discovery)
    const oauthToken = config.anthropicOAuthToken;
    const apiKey = config.anthropicApiKey;

    const authHeaders: Record<string, string> = oauthToken
      ? {
          Authorization: `Bearer ${oauthToken}`,
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
          "user-agent": "claude-cli/2.1.2 (external, cli)",
          "x-app": "cli",
        }
      : apiKey
        ? { "x-api-key": apiKey }
        : {};

    if (!oauthToken && !apiKey) {
      res.status(401).json({
        error: {
          type: "authentication_error",
          message:
            "No Anthropic auth configured. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.",
        },
      });
      return;
    }

    // Forward to Anthropic
    const forwardBody = {
      ...body,
      system: enrichedSystem,
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...authHeaders,
      },
      body: JSON.stringify(forwardBody),
      signal: AbortSignal.timeout(config.timeoutDefault),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[proxy] Anthropic ${response.status}: ${errorText.slice(0, 200)}`);
      res.status(response.status).send(errorText);
      return;
    }

    // Streaming — Anthropic SSE format
    if (body.stream) {
      // Pass through all headers from Anthropic
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let fullContent = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            res.write(chunk);

            // Extract text deltas for caching
            for (const line of chunk.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6)) as {
                    type?: string;
                    delta?: { type?: string; text?: string };
                  };
                  if (
                    data.type === "content_block_delta" &&
                    data.delta?.type === "text_delta" &&
                    data.delta.text
                  ) {
                    fullContent += data.delta.text;
                  }
                } catch {
                  /* ignore parse errors in stream */
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        res.end();

        // Cache the complete response (fire-and-forget)
        if (fullContent) {
          void cache.store(queryText, fullContent, model, "anthropic");
        }
      }
      return;
    }

    // Non-streaming response
    const responseBody = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      [key: string]: unknown;
    };

    // Cache the response
    const textBlock = responseBody.content?.find((c) => c.type === "text");
    if (textBlock?.text) {
      void cache.store(queryText, textBlock.text, model, "anthropic");
    }

    // Add injection metadata
    (responseBody as Record<string, unknown>)["_injection"] = {
      collections: Object.fromEntries(
        (
          ["personality", "memory", "learning", "kb", "inference", "source"] as const
        ).map((k) => [k, injection[k].length])
      ),
      totalChunks: injection.totalChunks,
      queryTimeMs: injection.queryTimeMs,
    };

    res.json(responseBody);
  } catch (error) {
    console.error("[proxy] /v1/messages error:", error);
    res.status(500).json({
      error: {
        type: "internal_error",
        message: (error as Error).message,
      },
    });
  }
});

// POST /api/inject — manual RAG search
app.post("/api/inject", async (req, res) => {
  try {
    const { query, collections, topK, includeSource } = req.body as {
      query: string;
      collections?: string[];
      topK?: number;
      includeSource?: boolean;
    };

    if (!query) {
      res.status(400).json({ error: "query is required" });
      return;
    }

    const injector = getInjector();
    const result = await injector.query(query, {
      collections,
      topK,
      includeSource,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/index — store knowledge
app.post("/api/index", async (req, res) => {
  try {
    const { text, collection, metadata } = req.body as {
      text: string;
      collection: string;
      metadata?: Record<string, unknown>;
    };

    if (!text || !collection) {
      res.status(400).json({ error: "text and collection are required" });
      return;
    }

    const indexer = getIndexer();
    const result = await indexer.index(text, { collection, metadata });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/store — store single entry (no chunking)
app.post("/api/store", async (req, res) => {
  try {
    const { text, collection, payload } = req.body as {
      text: string;
      collection: string;
      payload?: Record<string, unknown>;
    };

    if (!text || !collection) {
      res.status(400).json({ error: "text and collection are required" });
      return;
    }

    const indexer = getIndexer();
    const id = await indexer.store(text, collection, payload);

    res.json({ id, collection });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/personality — view loaded personality
app.get("/api/personality", async (_req, res) => {
  try {
    const personality = await loadPersonality();
    res.json({
      traits: personality.traits.length,
      expertise: personality.expertise,
      style: personality.style,
      prompt: buildPersonalityPrompt(personality),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/cache/stats
app.get("/api/cache/stats", async (_req, res) => {
  try {
    const cache = getSemanticCache();
    await cache.init();
    const stats = await cache.getStats();
    const embedderStats = getEmbedder().getCacheStats();

    res.json({
      semanticCache: stats,
      embeddingCache: embedderStats,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/cache/cleanup — manual cleanup
app.post("/api/cache/cleanup", async (_req, res) => {
  try {
    const cache = getSemanticCache();
    await cache.init();
    const removed = await cache.cleanup();
    res.json({ removed });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Bootstrap and start
async function start(): Promise<void> {
  console.log("[proxy] Initializing...");

  // Init Qdrant pool
  const pool = getQdrantPool();
  await pool.init();
  console.log("[proxy] Qdrant pool ready");

  // Init embedder (downloads ONNX model on first run)
  const embedder = getEmbedder();
  console.log("[proxy] Loading FastEmbed ONNX model (BGE-base-en-v1.5)...");
  await embedder.init();
  console.log(`[proxy] Embedder ready (${embedder.getDimension()}d)`);

  // Init semantic cache
  const cache = getSemanticCache();
  await cache.init();
  console.log("[proxy] Semantic cache ready");

  // Preload personality
  try {
    const personality = await loadPersonality();
    console.log(
      `[proxy] Personality loaded: ${personality.traits.length} traits, expertise: ${personality.expertise.join(", ")}`
    );
  } catch (error) {
    console.warn(
      "[proxy] Personality not available:",
      (error as Error).message
    );
  }

  app.listen(config.proxyPort, () => {
    console.log(`[proxy] Listening on http://0.0.0.0:${config.proxyPort}`);
    console.log(`[proxy] Target LLM (OpenAI compat): ${config.proxyTarget}`);
    console.log(`[proxy] Anthropic: ${config.anthropicOAuthToken ? "OAuth Bearer" : config.anthropicApiKey ? "API Key" : "NOT CONFIGURED"}`);
    console.log(`[proxy] Qdrant: ${config.qdrantUrl}`);
    console.log(`[proxy] Endpoints: /v1/messages (Anthropic) | /v1/chat/completions (OpenAI)`);
  });
}

start().catch((error) => {
  console.error("[proxy] Fatal:", error);
  process.exit(1);
});
