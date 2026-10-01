import { Command } from "commander";
import { loadReviewed, saveReviewed, REVIEWED_FILE } from "../output/attention.js";

export const attentionReviewCommand = new Command("attention:review")
  .description(`Mark a "Data to check" item reviewed, hiding it until it changes (kept in ${REVIEWED_FILE}). Keys are in latest.json's attention list`)
  .argument("[key]", "The item's key, e.g. ocr-review:house:9116218:pages-1")
  .option("--note <text>", "Why it needs nothing more", "")
  .option("--undo", "Show the item again")
  .option("--list", "List the items marked reviewed")
  .action(async (key: string | undefined, options) => {
    const reviewed = await loadReviewed();
    if (options.list || !key) {
      const entries = Object.entries(reviewed);
      console.log(entries.length ? `${entries.length} reviewed:` : "Nothing marked reviewed.");
      for (const [k, v] of entries) console.log(`  ${k}  (${v.reviewedAt.slice(0, 10)}) ${v.note}`);
      return;
    }
    if (options.undo) {
      if (!reviewed[key]) {
        console.error(`❌ ${key} isn't marked reviewed.`);
        process.exit(1);
      }
      delete reviewed[key];
      await saveReviewed(reviewed);
      console.log(`Unmarked ${key}; it shows again from the next report.`);
      return;
    }
    reviewed[key] = { note: options.note as string, reviewedAt: new Date().toISOString() };
    await saveReviewed(reviewed);
    console.log(`Marked ${key} reviewed; it's hidden from the next report on.`);
  });
