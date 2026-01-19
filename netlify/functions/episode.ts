import type { Handler } from "@netlify/functions";
import { supabase } from "./_supabase";

export const handler: Handler = async (event) => {
  const date = event.queryStringParameters?.date;

  if (!date) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing required query param: date=YYYY-MM-DD" }),
    };
  }

  const { data, error } = await supabase
    .from("episodes")
    .select("*")
    .eq("published_date", date)
    .order("published_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error.message }),
    };
  }

  if (!data) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `No episode found for date ${date}` }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
};
