// Manifest schema for project export/import. Zod-validated; version is
// bumped whenever the project DB schema changes incompatibly.
//
// The manifest is written into every export zip. Import rejects zips whose
// manifest.schema_version exceeds CURRENT_SCHEMA_VERSION.

import { z } from "zod"

export const CURRENT_SCHEMA_VERSION = 6

export const ManifestSchema = z.object({
  hmanlab_memory_version: z.string(),
  exported_at: z.string(), // ISO 8601 timestamp
  project_name: z.string().min(1),
  schema_version: z.number().int().min(1),
  memory_count: z.number().int().min(0),
  channels: z.array(z.string()),
  embedding_model: z.string(),
  embedding_dim: z.number().int().positive(),
})

export type Manifest = z.infer<typeof ManifestSchema>

/** Default decay policy placeholder (not exported; recipient uses defaults). */
export const DEFAULT_DECAY_POLICY = {
  access_zero_decay_days: 30,
  access_zero_decay_factor: 0.7,
  cold_days: 90,
  cold_importance_threshold: 0.3,
  auto_archive_cold: false,
}
