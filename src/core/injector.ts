import { getEmbedder } from "./embedder.js";
import { getQdrantPool } from "./qdrant-client.js";

// ECOA Fusion Weights — from FAZAI_FOCO_AGENICO
const COLLECTION_WEIGHTS: Record<string, number> = {
  fazai_personality: 0.15,
  fazai_memory: 0.20,
  fazai_learning: 0.40,
  fazai_kb: 0.30,
  fazai_inference: 0.10,
};

const PERSONALITY_TOP_K = 5;
const MEMORY_TOP_K = 3;
const DEFAULT_TOP_K = 5;
const MIN_SCORE_THRESHOLD = 0.3;

export interface InjectionResult {
  personality: ScoredChunk[];
  memory: ScoredChunk[];
  learning: ScoredChunk[];
  kb: ScoredChunk[];
  inference: ScoredChunk[];
  source: ScoredChunk[];
  totalChunks: number;
  queryTimeMs: number;
}

export interface ScoredChunk {
  id: string | number;
  text: string;
  collection: string;
  vectorScore: number;
  fusedScore: number;
  recencyBoost: number;
  resonance: number;
  payload: Record<string, unknown>;
}

export interface InjectOptions {
  collections?: string[];
  personalityAlways?: boolean;
  topK?: number;
  minScore?: number;
  includeSource?: boolean;
}

function calculateRecencyBoost(payload: Record<string, unknown>): number {
  const timestamp =
    (payload["updated_at"] as string) ??
    (payload["created_at"] as string) ??
    (payload["timestamp"] as string);

  if (!timestamp) return 1.0;

  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // 0 days = 1.2, 30 days = 1.0, 150+ days = 0.5
  if (ageDays <= 0) return 1.2;
  if (ageDays <= 30) return 1.2 - (ageDays / 30) * 0.2;
  if (ageDays <= 150) return 1.0 - ((ageDays - 30) / 120) * 0.5;
  return 0.5;
}

function calculateResonance(payload: Record<string, unknown>): number {
  const intensity = (payload["emotional_layer"] as number) ?? 0.5;
  return 1.0 + intensity * 0.2;
}

function checkLegitimacy(
  payload: Record<string, unknown>,
  currentContext: string
): boolean {
  const contexts = payload["legitimate_contexts"] as string[] | undefined;
  if (!contexts) return true; // retrocompat
  return contexts.includes(currentContext) || contexts.includes("*");
}

function extractText(payload: Record<string, unknown>, collection?: string): string {
  // Each collection has a different text field layout
  switch (collection) {
    case "fazai_personality": {
      // Personality points store text in metadata.conversation_summary
      const meta = payload["metadata"] as Record<string, unknown> | undefined;
      const summary = meta?.["conversation_summary"] as string | undefined;
      const name = meta?.["conversation_name"] as string | undefined;
      return summary || name || "";
    }
    case "fazai_kb": {
      // KB stores title + summary
      const title = payload["title"] as string | undefined;
      const summary = payload["summary"] as string | undefined;
      return [title, summary].filter(Boolean).join("\n");
    }
    case "fazai_source": {
      // Source stores code content directly
      return (payload["content"] as string) ?? "";
    }
    case "fazai_memory": {
      // Memory stores content + optional summary
      return (payload["content"] as string) ?? (payload["summary"] as string) ?? "";
    }
    default: {
      // Generic fallback chain
      return (
        (payload["text"] as string) ??
        (payload["content"] as string) ??
        (payload["value"] as string) ??
        (payload["summary"] as string) ??
        ""
      );
    }
  }
}

export class UniversalInjector {
  async query(
    queryText: string,
    options?: InjectOptions
  ): Promise<InjectionResult> {
    const startTime = Date.now();
    const embedder = getEmbedder();
    const pool = getQdrantPool();
    await embedder.init();

    const vector = await embedder.embed(queryText);
    const topK = options?.topK ?? DEFAULT_TOP_K;
    const minScore = options?.minScore ?? MIN_SCORE_THRESHOLD;
    const personalityAlways = options?.personalityAlways ?? true;

    // Determine which collections to query
    const collections = options?.collections ?? [
      "fazai_personality",
      "fazai_memory",
      "fazai_learning",
      "fazai_kb",
      "fazai_inference",
    ];

    if (options?.includeSource && !collections.includes("fazai_source")) {
      collections.push("fazai_source");
    }

    // Always include personality if personalityAlways is true
    if (personalityAlways && !collections.includes("fazai_personality")) {
      collections.unshift("fazai_personality");
    }

    // Parallel search across all collections
    const searchPromises = collections.map(async (collectionName) => {
      const limit =
        collectionName === "fazai_personality"
          ? PERSONALITY_TOP_K
          : collectionName === "fazai_memory"
            ? MEMORY_TOP_K
            : topK;

      try {
        const results = await pool.execute((client) =>
          client.search(collectionName, {
            vector,
            limit,
            with_payload: true,
            score_threshold: minScore,
          })
        );

        return results.map((point): ScoredChunk => {
          const payload = (point.payload ?? {}) as Record<string, unknown>;
          const vectorScore = point.score;
          const weight = COLLECTION_WEIGHTS[collectionName] ?? 0.15;
          const recencyBoost = calculateRecencyBoost(payload);
          const resonance = calculateResonance(payload);
          const isLegitimate = checkLegitimacy(payload, "general");

          const fusedScore =
            vectorScore * weight * recencyBoost * resonance * (isLegitimate ? 1.0 : 0.2);

          return {
            id: point.id,
            text: extractText(payload, collectionName),
            collection: collectionName,
            vectorScore,
            fusedScore,
            recencyBoost,
            resonance,
            payload,
          };
        });
      } catch (error) {
        console.warn(
          `[injector] Failed to query ${collectionName}:`,
          (error as Error).message
        );
        return [];
      }
    });

    const allResults = await Promise.all(searchPromises);

    // Categorize results
    const result: InjectionResult = {
      personality: [],
      memory: [],
      learning: [],
      kb: [],
      inference: [],
      source: [],
      totalChunks: 0,
      queryTimeMs: 0,
    };

    for (const chunks of allResults) {
      for (const chunk of chunks) {
        const key = chunk.collection.replace("fazai_", "") as keyof Omit<
          InjectionResult,
          "totalChunks" | "queryTimeMs"
        >;
        if (key in result && Array.isArray(result[key])) {
          (result[key] as ScoredChunk[]).push(chunk);
        }
      }
    }

    // Sort each category by fused score
    for (const key of ["personality", "memory", "learning", "kb", "inference", "source"] as const) {
      result[key].sort((a, b) => b.fusedScore - a.fusedScore);
    }

    result.totalChunks =
      result.personality.length +
      result.memory.length +
      result.learning.length +
      result.kb.length +
      result.inference.length +
      result.source.length;

    result.queryTimeMs = Date.now() - startTime;

    return result;
  }

  buildInjectedPrompt(
    injection: InjectionResult,
    originalSystemPrompt?: string
  ): string {
    const sections: string[] = [];

    // Personality ALWAYS first — this IS the system prompt
    if (injection.personality.length > 0) {
      const traits = injection.personality.map((c) => c.text).join("\n");
      sections.push(
        `## Personalidade e Identidade\n${traits}`
      );
    }

    // Memory context
    if (injection.memory.length > 0) {
      const memories = injection.memory.map((c) => c.text).join("\n\n");
      sections.push(`## Memórias Relevantes\n${memories}`);
    }

    // Learning — validated solutions
    if (injection.learning.length > 0) {
      const learnings = injection.learning.map((c) => c.text).join("\n\n");
      sections.push(`## Soluções Validadas\n${learnings}`);
    }

    // Knowledge base
    if (injection.kb.length > 0) {
      const knowledge = injection.kb.map((c) => c.text).join("\n\n");
      sections.push(`## Conhecimento Técnico\n${knowledge}`);
    }

    // Inference — policies/rules
    if (injection.inference.length > 0) {
      const rules = injection.inference.map((c) => c.text).join("\n\n");
      sections.push(`## Regras e Políticas\n${rules}`);
    }

    // Source code context
    if (injection.source.length > 0) {
      const source = injection.source.map((c) => c.text).join("\n\n");
      sections.push(`## Contexto de Código\n${source}`);
    }

    // The injected prompt REPLACES the original system prompt
    // If there's original content, it goes AFTER the personality
    const injectedContent = sections.join("\n\n---\n\n");

    if (originalSystemPrompt) {
      return `${injectedContent}\n\n---\n\n## Instruções Adicionais\n${originalSystemPrompt}`;
    }

    return injectedContent;
  }
}

// Singleton
let _injector: UniversalInjector | null = null;

export function getInjector(): UniversalInjector {
  if (!_injector) {
    _injector = new UniversalInjector();
  }
  return _injector;
}
