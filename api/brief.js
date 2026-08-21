// AI weekly brief — calls the Anthropic API (Claude) with your dashboard's
// numbers and returns a short written analysis.
//
// SETUP (one-off): this function needs YOUR API key, stored as a secret:
//   1. Get a key at console.anthropic.com (Settings -> API keys)
//   2. In Vercel: your project -> Settings -> Environment Variables
//      -> add ANTHROPIC_API_KEY = your key -> redeploy
// The key lives only on the server. It is never sent to the browser —
// that's the whole point of doing this in a serverless function.

// Vercel's default function timeout is short, and a model call plus network
// can occasionally run past it. Asking for more headroom costs nothing when
// the call returns quickly, and prevents a confusing timeout when it doesn't.
export const config = { maxDuration: 30 };

const MODEL = "claude-sonnet-5";   // if this ever 404s, check docs.claude.com for the current model name

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // Frontend shows setup instructions when it sees this status.
    return res.status(501).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  // Optional but recommended: set BRIEF_PIN in Vercel and only requests
  // carrying the right PIN can spend your API credit. Without this,
  // anyone who finds your URL could press the button on your money.
  const pin = process.env.BRIEF_PIN;
  if (pin && req.headers["x-brief-pin"] !== pin) {
    return res.status(401).json({ error: "PIN required" });
  }

  // The dashboard sends a compact summary of its own calculations.
  // Cap the size so a malformed request can't send a huge payload.
  const payload = JSON.stringify(req.body || {}).slice(0, 8000);
  if (payload.length < 10) {
    return res.status(400).json({ error: "No dashboard data received" });
  }

  const prompt = `You are a sharp, no-fluff Fantasy Premier League analyst.
Below is JSON from my dashboard. Field notes:
- "total" is my model's score: attacking threat (form, xGI/90, set-piece duty)
  weighted by how often the player actually starts, plus fixture ease.
- "fpl_expected_points" is FPL's own independent forecast. Where it disagrees
  with my ranking, that disagreement is the most interesting thing in the data.
- "penalty_taker" means first-choice penalties — a real and underrated edge.
- "starts_pct" is how often he starts; low means rotation risk.
- "owned_by_pct" matters because FPL is a rank game: not owning a highly-owned
  player who hauls costs rank even though it costs no points.
- "transfer_bar" is the gain a move must clear to be worth a free transfer.
  "best_idea_below_bar" is the nearest thing that did NOT clear it.
- "gameweeks_played" is how much real football these stats rest on. Under 3,
  treat form and xGI as tiny samples and say so plainly.

Write a decision brief for this gameweek, max 200 words, plain text (no markdown,
no headers). Cover: (1) the captain call and the honest case against it, including
any disagreement with FPL's own forecast, (2) whether a transfer is genuinely worth
making or better rolled — recommending "hold" is a real answer and often the right
one, (3) any trap in the data: injury flags, blanks, rotation risk, a form figure
earned before an injury. Be opinionated but flag uncertainty. Never invent a player
or a stat that is not in the data.

DATA:
${payload}`;

  // Time-box the model call so the browser gets a clear error rather than a hang.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Surface the real reason: a bad model name, no credit and a rate limit
      // all fail differently, and guessing between them wastes your evening.
      return res.status(502).json({
        error: data?.error?.message || `Anthropic API error ${r.status}`,
      });
    }

    const brief = (data.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (!brief) {
      return res.status(502).json({ error: "The model returned an empty brief — try again." });
    }

    return res.status(200).json({ brief });
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return res.status(504).json({
      error: aborted ? "The brief took too long to generate — try again." : "Could not reach the Anthropic API",
      detail: String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}
