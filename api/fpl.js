// Vercel serverless function — proxies the official FPL API.
// Why this exists: browsers can't call fantasy.premierleague.com directly
// (the API doesn't allow cross-site browser requests). Servers can.
// Your page calls /api/fpl?path=... and this function fetches the real data.

const ALLOWED = [
  /^bootstrap-static\/$/,                 // all players, teams, gameweeks, prices
  /^fixtures\/(\?event=\d+)?$/,           // fixtures, optionally for one gameweek
  /^entry\/\d+\/$/,                       // a manager's public overview
  /^entry\/\d+\/event\/\d+\/picks\/$/,    // a manager's picks for a gameweek (public after deadline)
  /^entry\/\d+\/history\/$/,              // chips used, past seasons
  /^entry\/\d+\/transfers\/$/,            // your transfer history -> exact purchase prices
  /^event\/\d+\/live\/$/,                 // live points during a gameweek
];

// How long Vercel's edge may reuse a response. Different data goes stale at
// very different rates, so one blanket 5 minutes was wrong in both directions:
// too long for live scores, far too short for a fixture list that changes
// a few times a season.
function cacheFor(path) {
  if (path.startsWith("fixtures"))    return "s-maxage=3600, stale-while-revalidate=86400";
  if (path.startsWith("bootstrap"))   return "s-maxage=300,  stale-while-revalidate=600";
  if (path.includes("/live/"))        return "s-maxage=30,   stale-while-revalidate=60";
  return "s-maxage=60, stale-while-revalidate=300";   // entry/* — your own team
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const path = (req.query.path || "").toString();

  // Only allow known FPL endpoints — never be an open proxy.
  if (!ALLOWED.some((rx) => rx.test(path))) {
    return res.status(400).json({ error: "Path not allowed", path });
  }

  // Time-box the upstream call. Without this, an unresponsive FPL API holds
  // the function open until Vercel kills it, and the browser just hangs.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  try {
    const upstream = await fetch(`https://fantasy.premierleague.com/api/${path}`, {
      signal: ctrl.signal,
      headers: {
        // FPL sometimes rejects requests with no browser-like user agent
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        Accept: "application/json",
      },
    });

    if (!upstream.ok) {
      // Never edge-cache a failure: a 30-second FPL blip would otherwise be
      // served to you as an error for the next five minutes.
      res.setHeader("Cache-Control", "no-store");
      return res
        .status(upstream.status)
        .json({ error: `FPL API returned ${upstream.status}`, path });
    }

    // FPL occasionally serves an HTML maintenance page with a 200 status.
    // Parsing that as JSON throws a confusing error, so check the type first.
    const type = upstream.headers.get("content-type") || "";
    if (!type.includes("json")) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(502).json({ error: "FPL returned a non-JSON response (usually a maintenance page)", path });
    }

    const data = await upstream.json();
    res.setHeader("Cache-Control", cacheFor(path));
    return res.status(200).json(data);
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    const aborted = err?.name === "AbortError";
    return res.status(504).json({
      error: aborted
        ? "The FPL API took too long to respond (it slows right down around deadlines)."
        : "Could not reach the FPL API (it goes down for maintenance in summer and briefly at deadlines).",
      detail: String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}
