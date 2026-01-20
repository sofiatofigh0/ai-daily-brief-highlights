import type { Handler } from "@netlify/functions";
import { schedule } from "@netlify/functions";

const run: Handler = async () => {
  const base =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.DEPLOY_URL;

  if (!base) {
    console.log("CRON_SUMMARIZE missing site URL env var");
    return { statusCode: 200 };
  }

  const target = `${base}/.netlify/functions/summarize-episodes-background`;
  console.log("CRON_SUMMARIZE triggering", target);

  fetch(target).catch((e) => console.log("CRON_SUMMARIZE fetch error", e?.message || e));

  return { statusCode: 200 };
};

// Runs daily at 23:40 UTC (10 min after ingest)
export const handler = schedule("10 21 * * *", run);
