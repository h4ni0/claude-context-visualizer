import { open } from "node:fs/promises";

export type ParseHandler = (rec: any, index: number) => void;

// Stream-parse a jsonl file line-by-line without loading it all into memory.
// Tolerates malformed lines (skips them).
export async function streamJSONL(filePath: string, onRecord: ParseHandler): Promise<void> {
  const file = await open(filePath, "r");
  try {
    const stream = file.createReadStream({ encoding: "utf8" });
    let buf = "";
    let index = 0;
    for await (const chunk of stream) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          onRecord(rec, index++);
        } catch {
          // skip malformed line
          index++;
        }
      }
    }
    if (buf.trim()) {
      try {
        onRecord(JSON.parse(buf), index);
      } catch {
        // skip
      }
    }
  } finally {
    await file.close();
  }
}

// Read all records into memory. Used when we need random access.
export async function readAllJSONL(filePath: string): Promise<any[]> {
  const records: any[] = [];
  await streamJSONL(filePath, (r) => records.push(r));
  return records;
}
