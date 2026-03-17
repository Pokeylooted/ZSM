interface VoyageEmbeddingRecord {
    embedding: number[];
}

interface VoyageEmbeddingResponse {
    data: VoyageEmbeddingRecord[];
}

export interface VoyageConfig {
    apiKey: string;
    model: string;
}

export function getVoyageConfig(): VoyageConfig | null {
    const env = (globalThis as any).process?.env as Record<string, string | undefined> | undefined;
    const apiKey = env?.VOYAGE_API_KEY?.trim();
    if (!apiKey) {
        return null;
    }

    return {
        apiKey,
        model: env?.VOYAGE_MODEL?.trim() || "voyage-code-3",
    };
}

async function embedBatch(
    input: string[],
    config: VoyageConfig,
    inputType: "document" | "query",
): Promise<number[][]> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetch("https://api.voyageai.com/v1/embeddings", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: config.model,
                    input,
                    input_type: inputType,
                }),
                signal: AbortSignal.timeout(15_000),
            });

            if (!response.ok) {
                const body = await response.text();
                const retriable = response.status === 429 || response.status >= 500;
                if (retriable && attempt < maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
                    continue;
                }
                throw new Error(
                    `Voyage embeddings failed: ${response.status} ${response.statusText} ${body}`,
                );
            }

            const json = (await response.json()) as VoyageEmbeddingResponse;
            if (!Array.isArray(json.data) || json.data.length !== input.length) {
                throw new Error("Voyage embeddings returned an invalid response shape");
            }

            return json.data.map((item) => item.embedding);
        } catch (error) {
            if (attempt < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
                continue;
            }

            if (error instanceof Error) {
                throw error;
            }
            throw new Error(String(error));
        }
    }

    throw new Error("Voyage embeddings failed");
}

export async function embedTexts(
    texts: string[],
    config: VoyageConfig,
    inputType: "document" | "query",
): Promise<number[][]> {
    const batchSize = 64;
    const vectors: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchVectors = await embedBatch(batch, config, inputType);
        vectors.push(...batchVectors);
    }

    return vectors;
}

export function dot(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < len; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}

export function magnitude(a: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += a[i] * a[i];
    }
    return Math.sqrt(sum);
}

export function cosineSimilarity(a: number[], b: number[]): number {
    const denom = magnitude(a) * magnitude(b);
    if (denom === 0) {
        return 0;
    }
    return dot(a, b) / denom;
}
