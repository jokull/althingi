// Glue: raw speech XML -> parsed -> lemmatized -> stored. Used by the crawler and by reindex jobs.
import { createHash } from "node:crypto";
import { type Sql, saveSpeechText } from "./db.ts";
import { analyze, lemmaVersion } from "./lemma.ts";
import { decodeCapacity, parseSpeechText } from "./parse.ts";

export const sha256 = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");

/** Parse + lemmatize + store one speech text. Throws if the XML is unusable (caller marks the speech as error). */
export async function ingestSpeechXml(sql: Sql, expectedId: string, xml: string): Promise<{ paragraphs: number }> {
  const s = parseSpeechText(xml);
  // The filename stem (index id) is canonical. The timestamp inside the file can drift by seconds from it
  // (seen: rad20260610T193010 holds tími 19:30:29), so only a different DAY counts as the wrong file.
  if (s.id.slice(0, 11) !== expectedId.slice(0, 11)) {
    throw new Error(`speech id mismatch: expected ${expectedId}, file says ${s.id}`);
  }
  if (s.paragraphs.length === 0) throw new Error("speech has no paragraphs");
  await saveSpeechText(
    sql,
    {
      id: expectedId, speakerAbbr: s.speakerAbbr, office: s.office, tegr: s.tegr, tegflm: s.tegflm,
      nefnd: s.nefnd, continued: s.continued, speakerCapacity: decodeCapacity(s.tegflm),
    },
    s.paragraphs,
    { rawSha256: sha256(xml), lemmaVersion: lemmaVersion(), analyze },
  );
  return { paragraphs: s.paragraphs.length };
}
