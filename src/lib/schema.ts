// src/schemas.ts
import { z } from 'zod';

// Schema for a single series configuration
export const SeriesConfigSchema = z.object({
  sourceUrl: z.string().url(),
  glossary: z.string().min(1, "Glossary cannot be empty.").optional(),
  customInstructions: z.string().min(1, "Custom instructions cannot be empty.").optional(),
  skipTranslation: z.boolean().default(false),
  translateChapterMin: z.number().optional(),
});

// Schema for the entire series configurations object
// This is a record where keys are strings (identifiers) and values are SeriesConfigSchema
export const SeriesConfigurationsFileSchema = z.record(z.string(), SeriesConfigSchema);

// Export the inferred type for convenience
export type SeriesConfigurations = z.infer<typeof SeriesConfigurationsFileSchema>;
export type SingleSeriesConfig = z.infer<typeof SeriesConfigSchema>;
