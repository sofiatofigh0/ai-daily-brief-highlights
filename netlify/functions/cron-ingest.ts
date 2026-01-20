import type { Handler } from "@netlify/functions";
import { schedule } from "@netlify/functions";

const run: Handler = async () => {
  const base =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.DEPLOY_URL;

  if (!base) {
    console.log("CRON_INGEST missing site URL env var");
    return { statusCode: 200 };
  }

  const target = `${base}/.netlify/functions/ingest-episodes-background`;
  console.log("CRON_INGEST triggering", target);

  // Fire-and-forget. Don't await long work.
  fetch(target).catch((e) => console.log("CRON_INGEST fetch error", e?.message || e));

  return { statusCode: 200 };
};

// Runs daily at 23:30 UTC (adjust below if you want)
export const handler = schedule("0 21 * * *", run);
