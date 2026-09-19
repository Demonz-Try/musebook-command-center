import type { Config } from "@netlify/functions";

/**
 * The deadline checker. It holds no logic of its own: it calls the same
 * endpoint a human could curl, so the schedule is just another client.
 */
export default async function handler() {
  // Scheduled functions run on branch deploys too, and a preview database is a
  // fork of production — so an unguarded sweep would refund a copy of every
  // live bounty on every open pull request and write receipts for it.
  const context = Netlify.env.get("CONTEXT");
  if (context && context !== "production") {
    const skipped = `deadline check skipped: context is ${context}, not production`;
    console.log(skipped);
    return new Response(skipped, { status: 200 });
  }

  const base = Netlify.env.get("URL") ?? "http://localhost:8888";
  const secret = Netlify.env.get("SCHEDULER_SECRET");

  const response = await fetch(`${base}/api/deadlines/check`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
  });

  const body = await response.text();
  if (!response.ok) {
    console.error("deadline check failed", response.status, body);
    return new Response(body, { status: response.status });
  }

  console.log("deadline check", body);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export const config: Config = {
  schedule: "@hourly",
};
