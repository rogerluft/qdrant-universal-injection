import { getQdrantPool } from "../core/qdrant-client.js";

const PERSONALITY_COLLECTION = "fazai_personality";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SCROLL_LIMIT = 100;

// Actual payload schema from fazai_personality collection:
// type: "dialogue", source_file, source_uuid, created_at, ingestion_version,
// ingested_at, style: "claudio", emotional_layer: number, ressonancia: number,
// content_hash, metadata: { conversation_name, conversation_summary, ... }
interface PersonalityPoint {
  type: string;
  style: string;
  emotional_layer: number;
  ressonancia: number;
  created_at: string;
  ingested_at: string;
  content_hash: string;
  metadata: {
    conversation_name: string;
    conversation_summary: string;
    human_message_uuid?: string;
    assistant_message_uuid?: string;
  };
}

export interface PersonalityTraits {
  traits: Array<{
    conversationName: string;
    summary: string;
    style: string;
    emotionalLayer: number;
    ressonancia: number;
    createdAt: string;
    weight: number; // emotional_layer × ressonancia
  }>;
  expertise: string[];
  style: string[];
  totalLoaded: number;
}

let cachedPersonality: PersonalityTraits | null = null;
let cacheTimestamp = 0;

export async function loadPersonality(): Promise<PersonalityTraits> {
  if (cachedPersonality && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedPersonality;
  }

  const pool = getQdrantPool();

  // Scroll in pages to load up to 500 personality points
  const allPoints: Array<{ payload: PersonalityPoint }> = [];
  let nextOffset: string | number | undefined = undefined;

  for (let page = 0; page < 5; page++) {
    const result = await pool.execute((client) =>
      client.scroll(PERSONALITY_COLLECTION, {
        limit: SCROLL_LIMIT,
        with_payload: true,
        with_vector: false,
        offset: nextOffset,
      })
    );

    for (const point of result.points) {
      allPoints.push({ payload: point.payload as unknown as PersonalityPoint });
    }

    nextOffset = (result.next_page_offset ?? undefined) as string | number | undefined;
    if (!nextOffset || result.points.length < SCROLL_LIMIT) break;
  }

  const traits: PersonalityTraits["traits"] = [];
  const expertiseSet = new Set<string>();
  const styleSet = new Set<string>();

  for (const { payload } of allPoints) {
    const meta = payload.metadata ?? {} as PersonalityPoint["metadata"];
    const conversationName = meta.conversation_name ?? "";
    const summary = meta.conversation_summary ?? "";
    const emotionalLayer = payload.emotional_layer ?? 0.5;
    const ressonancia = payload.ressonancia ?? 1.0;
    const style = payload.style ?? "claudio";
    const weight = emotionalLayer * ressonancia;

    if (style) styleSet.add(style);

    // Extract expertise hints from conversation names/summaries
    const lowerName = conversationName.toLowerCase();
    for (const kw of ["nginx", "docker", "linux", "security", "network", "mikrotik", "qdrant", "ai", "python", "typescript", "node"]) {
      if (lowerName.includes(kw) || summary.toLowerCase().includes(kw)) {
        expertiseSet.add(kw);
      }
    }

    traits.push({
      conversationName,
      summary,
      style,
      emotionalLayer,
      ressonancia,
      createdAt: payload.created_at ?? "",
      weight,
    });
  }

  // Sort by weight (emotional_layer × ressonancia) descending
  traits.sort((a, b) => b.weight - a.weight);

  cachedPersonality = {
    traits,
    expertise: [...expertiseSet],
    style: [...styleSet],
    totalLoaded: allPoints.length,
  };
  cacheTimestamp = Date.now();

  return cachedPersonality;
}

export function buildPersonalityPrompt(personality: PersonalityTraits): string {
  // Select top-weighted conversation summaries that define personality
  const topTraits = personality.traits
    .filter((t) => t.summary.length > 50) // only meaningful summaries
    .slice(0, 10);

  const expertiseStr =
    personality.expertise.length > 0
      ? personality.expertise.join(", ")
      : "linux, networking, docker, security, AI, monitoring";

  const styleStr =
    personality.style.length > 0
      ? personality.style.join(", ")
      : "claudio";

  const traitSections = topTraits
    .map((t) => {
      // Truncate long summaries to keep prompt manageable
      const truncated =
        t.summary.length > 500 ? t.summary.slice(0, 500) + "..." : t.summary;
      return `[${t.conversationName}]\n${truncated}`;
    })
    .join("\n\n");

  return `Você é FazAI (Clau Luft), assistente de IA com personalidade derivada de ${personality.totalLoaded} interações.
Estilo: ${styleStr}
Áreas de expertise: ${expertiseStr}

Contexto de personalidade derivado das interações mais relevantes:

${traitSections}

Responda de acordo com sua personalidade, expertise e estilo de comunicação.`;
}

export function clearPersonalityCache(): void {
  cachedPersonality = null;
  cacheTimestamp = 0;
}
