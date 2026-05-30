import { computeSnapshot } from "../server/snapshot.ts";

const filePath = process.argv[2];
if (!filePath) {
  console.error("usage: bun scripts/smoke.ts <jsonl path>");
  process.exit(1);
}
const snap = await computeSnapshot(filePath);
console.log("sessionId:", snap.sessionId);
console.log("model:", snap.headline.model);
console.log("realTotal:", snap.headline.realTotal);
console.log("  input:", snap.headline.inputTokens);
console.log("  cacheCreate:", snap.headline.cacheCreationTokens);
console.log("  cacheRead:", snap.headline.cacheReadTokens);
console.log("compaction:", snap.compaction);
console.log("buckets:");
let sum = 0;
for (const b of snap.buckets) {
  console.log(`  ${b.id.padEnd(14)} ${String(b.tokens).padStart(8)}  children=${b.children.length}`);
  sum += b.tokens;
  for (const c of b.children) {
    console.log(`    ${c.name.padEnd(20)} ${String(c.tokens).padStart(8)}  items=${c.items.length}`);
  }
}
console.log("sum:", sum, "diff:", snap.headline.realTotal - sum);
if (snap.warnings.length) console.log("warnings:", snap.warnings);
