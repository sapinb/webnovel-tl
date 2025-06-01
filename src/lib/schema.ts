// src/schemas.ts
import { z } from 'zod';

// Schema for a single series configuration
export const SeriesConfigSchema = z.object({
  sourceUrl: z.string().url(),
  glossary: z.string().min(1, "Glossary cannot be empty.").optional(),
  customInstructions: z.string().min(1, "Custom instructions cannot be empty.").optional(),
  skipTranslation: z.boolean().default(false),
  translateChapterMin: z.number().optional(),
  translateChapterMax: z.number().optional(),
}).superRefine((data, ctx) => {
  if (data.translateChapterMin !== undefined && 
      data.translateChapterMax !== undefined && 
      data.translateChapterMin > data.translateChapterMax) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `translateChapterMin (${data.translateChapterMin}) cannot be greater than translateChapterMax (${data.translateChapterMax}).`,
      path: ['translateChapterMin'], // You can point to one or both fields
    });
    // Optionally, add another issue for translateChapterMax if you want to highlight both
    // ctx.addIssue({ ... path: ['translateChapterMax'] ... });
  }
});


// Schema for the entire series configurations object
// This is a record where keys are strings (identifiers) and values are SeriesConfigSchema
export const SeriesConfigurationsFileSchema = z.record(z.string(), SeriesConfigSchema);

// Export the inferred type for convenience
export type SeriesConfigurations = z.infer<typeof SeriesConfigurationsFileSchema>;
export type SingleSeriesConfig = z.infer<typeof SeriesConfigSchema>;
