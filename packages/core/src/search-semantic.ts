/** Optional on-device provider. Callers must intersect hits with the structured search scope before fusion. */
export interface LocalSearchProvider {
  readonly providerId: string;
  readonly modelVersion: string;
  readonly modalities: readonly ("text" | "image")[];
  search(input: { text: string } | { imageBytes: Uint8Array }, options: {
    eligibleItemIds: readonly number[];
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly { itemId: number; score: number; evidence: "text-embedding" | "image-embedding" }[]>;
}
