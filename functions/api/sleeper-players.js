export async function onRequestGet() {
  try {
    const upstream = await fetch("https://api.sleeper.app/v1/players/nfl", {
      headers: { "Accept": "application/json" },
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
    if (!upstream.ok) {
      return Response.json({ error: "Sleeper player directory request failed", status: upstream.status }, {
        status: upstream.status >= 500 ? 502 : upstream.status,
        headers: { "Cache-Control": "no-store" }
      });
    }
    const source = await upstream.json();
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return Response.json({ error: "Sleeper returned an invalid player directory" }, { status: 502 });
    }
    const players = {};
    for (const [id, player] of Object.entries(source)) {
      if (!player || typeof player !== "object") continue;
      const fullName = player.full_name || [player.first_name, player.last_name].filter(Boolean).join(" ");
      if (!fullName) continue;
      players[id] = {
        player_id: String(player.player_id || id),
        full_name: fullName,
        first_name: player.first_name || "",
        last_name: player.last_name || "",
        team: player.team || "",
        position: player.position || "",
        status: player.status || ""
      };
    }
    if (Object.keys(players).length < 1000) {
      return Response.json({ error: "Sleeper returned an incomplete player directory" }, { status: 502 });
    }
    return Response.json(players, {
      headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" }
    });
  } catch (error) {
    return Response.json({ error: "Unable to load Sleeper player directory", detail: String(error) }, {
      status: 502,
      headers: { "Cache-Control": "no-store" }
    });
  }
}