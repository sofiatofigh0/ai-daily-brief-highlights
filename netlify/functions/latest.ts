import type { Handler } from "@netlify/functions";
import { supabase } from "./_supabase";

export const handler: Handler = async () => {
  const { data, error } = await supabase
    .from("episodes")
    .select("*")
    .order("published_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error.message }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
};

