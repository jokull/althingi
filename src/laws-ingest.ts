// lagasafn ingest: filled in by the laws phase.
import type { Sql } from "./db.ts";
export async function runLaws(_sql: Sql, _o: { zip?: string; log: (s: string) => void }): Promise<{ requests: number; files: number; rows: number }> {
  throw new Error("laws step not implemented yet");
}
