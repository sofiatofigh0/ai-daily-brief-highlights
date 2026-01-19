import type { Handler } from "@netlify/functions";
import { supabase } from "./_supabase";

export const handler: Handler = async () => {
  const { data, error } = await supabase
    .from("episodes")
    .select("published_date")
    .order("published_date", { ascending: false });

  if (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error.message }),
    };
  }

  const dates = Array.from(new Set((data ?? []).map((r: any) => r.published_date)));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dates }),
  };
};
