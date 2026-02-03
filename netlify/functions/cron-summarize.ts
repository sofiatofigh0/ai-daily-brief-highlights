import type { Handler } from "@netlify/functions";
import { schedule } from "@netlify/functions";

const resolveBaseUrl = () =>
  process.env.URL ||
  process.env.DEPLOY_PRIME_URL ||
  process.env.DEPLOY_URL ||
  process.env.SITE_URL ||
  process.env.NETLIFY_URL;

const run: Handler = async () => {
  const base = resolveBaseUrl();

  if (!base) {
    console.log("CRON_SUMMARIZE missing site URL env var");
    return { statusCode: 200 };
  }

  const target = `${base}/.netlify/functions/summarize-episodes-background`;
  console.log("CRON_SUMMARIZE triggering", target);

  try {
    const response = await fetch(target);
    console.log("CRON_SUMMARIZE response", response.status);
  } catch (e: any) {
    console.log("CRON_SUMMARIZE fetch error", e?.message || e);
  }

  return { statusCode: 200 };
};

// Runs every 30 minutes at :15 and :45 (offset from ingest at :00 and :30)
export const handler = schedule("15,45 * * * *", run);
