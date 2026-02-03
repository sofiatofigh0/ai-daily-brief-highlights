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
    console.log("CRON_INGEST missing site URL env var");
    return { statusCode: 200 };
  }

  const target = `${base}/.netlify/functions/ingest-episodes-background`;
  console.log("CRON_INGEST triggering", target);

  try {
    const response = await fetch(target);
    console.log("CRON_INGEST response", response.status);
  } catch (e: any) {
    console.log("CRON_INGEST fetch error", e?.message || e);
  }

  return { statusCode: 200 };
};

// Runs every 30 minutes to catch up on missed episodes
export const handler = schedule("*/30 * * * *", run);
