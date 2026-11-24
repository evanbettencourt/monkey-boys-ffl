const LEAGUE_ID = "1313563024161787904";
const API = "/api/sleeper";
const $ = (id) => document.getElementById(id);
const setTextIfPresent = (id, value) => { const element = $(id); if (element) element.textContent = value; };
const state = { league: null, users: [], rosters: [], weeks: {}, selectedWeek: 1, selectedRankingWeek: null, weekManuallySelected: false, rankingsByWeek: {}, failedWeeks: [], recoveredWeeks: [], usingCachedCore: false, draftOrder: null, draftSeason: null, nflState: null, currentWeek: 1, matchupWeek: 1, players: null, playersPromise: null, matchupDataByWeek: {}, parlayDataByWeek: {}, hallHistory: null, hallHistoryPromise: null, hallHistoryError: null };
let resolveSleeperCoreReady;
const sleeperCoreReady = new Promise(resolve=>{resolveSleeperCoreReady=resolve;});

const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const fmt = (v) => num(v).toFixed(2);
const MANAGERS = { khogan99:"Kevin", marcd9:"Marc", cjmyers210:"Colby", tajbhall:"Ben", itsdonk:"Brandon", turtmonk:"Evan", pgdoyle5:"Pat", joeysolomon:"Joey", abutta31:"Butta", lee2222:"Lee", dersnation:"Ders", tanzi14:"Tanz" };
const initials = (name) => (name || "?").trim().split(/\s+/).slice(0,2).map(x => x[0]).join("").toUpperCase();
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function teamFor(rosterId) { return state.teams.get(Number(rosterId)); }
function avatarMarkup(team, sizeClass = "") {
  if (team?.avatar) return `<img class="avatar ${sizeClass}" src="https://sleepercdn.com/avatars/thumbs/${encodeURIComponent(team.avatar)}" alt="" onerror="this.style.display='none'">`;
  return `<span class="avatar-fallback ${sizeClass}">${escapeHtml(initials(team?.name))}</span>`;
}
function teamName(team) { return escapeHtml(team?.name || "Unknown team"); }
function getWeeksToLoad() {
  const playoffStart = num(state.league?.settings?.playoff_week_start) || 15;
  return Math.max(1, Math.min(18, playoffStart + 2));
}
async function fetchJson(path, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 3);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 12000);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestUrl = path.startsWith("/api/") ? path : API + path;
      const response = await fetch(requestUrl, { signal: controller.signal, headers: { "Accept": "application/json" } });
      if (!response.ok) { const error = new Error("Sleeper API returned " + response.status + " for " + path); error.status = response.status; throw error; }
      return await response.json();
    } catch (error) {
      lastError = error;
      const retryable = error.name === "AbortError" || error instanceof TypeError || !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === attempts) break;
      await new Promise(resolve => setTimeout(resolve, 700 * (2 ** (attempt - 1))));
    } finally { clearTimeout(timeout); }
  }
  throw lastError || new Error("Sleeper request failed for " + path);
}
const STARTUP_CACHE_KEY = "monkey-boys-sleeper-cache-" + LEAGUE_ID;
const RANKINGS_EDITION_KEY = "monkey-boys-rankings-edition-" + LEAGUE_ID;
function readSavedRankingEdition() { try { const raw = localStorage.getItem(RANKINGS_EDITION_KEY); if (raw === null) return null; const value = Number(raw); return Number.isInteger(value) && value >= 0 && value <= 18 ? value : null; } catch { return null; } }
function saveRankingEdition(week) { try { localStorage.setItem(RANKINGS_EDITION_KEY, String(week)); } catch (error) { console.warn("Unable to save selected Power Rankings edition", error); } }
function getDefaultRankingEdition() { const published = Object.keys(EDITORIAL_EDITIONS).map(Number).filter(week => Number.isInteger(week) && week > 0); return published.length ? Math.max(...published) : 1; }
function readStartupCache() { try { const value = JSON.parse(localStorage.getItem(STARTUP_CACHE_KEY) || "null"); return value && typeof value === "object" ? value : {}; } catch { return {}; } }
function writeStartupCache(patch) { try { const current = readStartupCache(); localStorage.setItem(STARTUP_CACHE_KEY, JSON.stringify({ ...current, ...patch, savedAt: Date.now() })); } catch (error) { console.warn("Unable to save local Sleeper fallback cache", error); } }
function hasCachedCore(cache, key) { return key === "league" ? !!(cache.league && cache.league.league_id) : Array.isArray(cache[key]) && cache[key].length > 0; }
function buildTeams() {
  const userById = new Map(state.users.map(u => [String(u.user_id ?? "").trim(), u]));
  state.teams = new Map();
  for (const roster of state.rosters) {
    const owner = userById.get(String(roster.owner_id ?? "").trim());
    const metadata = owner?.metadata || {};
    const username = String(owner?.username || "").trim().replace(/^@/, "").toLowerCase();
    const displayName = String(owner?.display_name || "").trim().replace(/^@/, "").toLowerCase();
    const name = MANAGERS[username] || MANAGERS[displayName] || `Manager ${roster.roster_id}`;
    state.teams.set(Number(roster.roster_id), {
      id: Number(roster.roster_id), name, owner: "", username,
      avatar: metadata.avatar || owner?.avatar || null, wins: 0, losses: 0, ties: 0,
      pf: 0, pa: 0, allPlayWins: 0, allPlayGames: 0, scores: []
    });
  }
}
function calculateWeek(week) {
  const matchups = state.weeks[week] || [];
  const scores = matchups.map(m => ({ id: Number(m.roster_id), score: num(m.points), matchupId: m.matchup_id }));
  const played = scores.filter(x => x.matchupId != null && x.score > 0);
  const leagueAvg = played.length ? played.reduce((a,b) => a + b.score, 0) / played.length : 0;
  const scoreByRoster = new Map(scores.map(x => [x.id, x.score]));
  const matchupGroups = new Map();
  for (const m of matchups) {
    if (!matchupGroups.has(m.matchup_id)) matchupGroups.set(m.matchup_id, []);
    matchupGroups.get(m.matchup_id).push(m);
  }
  const results = [];
  for (const group of matchupGroups.values()) {
    if (group.length !== 2 || group.some(m => num(m.points) === 0)) continue;
    const [a,b] = group;
    const ta = teamFor(a.roster_id), tb = teamFor(b.roster_id);
    if (!ta || !tb) continue;
    results.push({ a: ta, b: tb, scoreA: num(a.points), scoreB: num(b.points), winner: num(a.points) === num(b.points) ? 0 : num(a.points) > num(b.points) ? 1 : 2 });
  }
  return { results, leagueAvg, scoreByRoster, played: played.length > 0 };
}
function computeRankings(week) {
  const teams = [...state.teams.values()].map(t => ({...t, wins:0,losses:0,ties:0,pf:0,pa:0,allPlayWins:0,allPlayLosses:0,allPlayTies:0,allPlayGames:0,scores:[]}));
  const byId = new Map(teams.map(t => [t.id,t]));
  let completedWeeks = 0;
  for (let w = 1; w <= week; w++) {
    const matchups = state.weeks[w] || [];
    const valid = matchups.filter(m => num(m.points) > 0);
    const weeklyScores = valid.map(m => num(m.points));
    const groups = new Map();
    for (const m of matchups) {
      const t = byId.get(Number(m.roster_id));
      if (!t) continue;
      const score = num(m.points);
      if (score > 0) { t.pf += score; t.scores.push({week:w,score}); }
      if (m.matchup_id == null || score <= 0) continue;
      if (!groups.has(m.matchup_id)) groups.set(m.matchup_id,[]);
      groups.get(m.matchup_id).push(m);
    }
    for (const group of groups.values()) {
      if (group.length !== 2 || group.some(m => num(m.points) <= 0)) continue;
      const [a,b] = group, ta = byId.get(Number(a.roster_id)), tb = byId.get(Number(b.roster_id));
      if (!ta || !tb) continue;
      ta.pa += num(b.points); tb.pa += num(a.points);
      if (num(a.points) > num(b.points)) { ta.wins++; tb.losses++; }
      else if (num(a.points) < num(b.points)) { tb.wins++; ta.losses++; }
      else { ta.ties++; tb.ties++; }
    }
    if (weeklyScores.length) {
      const sorted = [...weeklyScores].sort((a,b)=>a-b);
      if (w <= getWeeksToLoad() && valid.length === teams.length) {
        completedWeeks++;
        const median = (sorted[sorted.length/2-1] + sorted[sorted.length/2]) / 2;
        for (const m of valid) {
        const t = byId.get(Number(m.roster_id));
        if (!t) continue;
        if (num(m.points) > median) t.wins++;
        else if (num(m.points) < median) t.losses++;
        else t.ties++;
        }
      }
      for (const t of teams) {
        const score = matchups.find(m => Number(m.roster_id) === t.id);
        if (!score || num(score.points) <= 0) continue;
        for (const opponent of valid) {
          if (Number(opponent.roster_id) === t.id) continue;
          const opponentScore = num(opponent.points);
          t.allPlayGames++;
          if (num(score.points) > opponentScore) t.allPlayWins++;
          else if (num(score.points) < opponentScore) t.allPlayLosses++;
          else t.allPlayTies++;
        }
      }
    }
  }
  const maxPf = Math.max(1,...teams.map(t=>t.pf));
  const games = Math.max(1,completedWeeks * 2);
  const recentWeeks = [Math.max(1,week-2),Math.max(1,week-1),week];
  const recentAverages = recentWeeks.map(w => {
    const all = (state.weeks[w] || []).filter(m=>num(m.points)>0).map(m=>num(m.points));
    return all.length ? all.reduce((a,b)=>a+b,0)/all.length : 0;
  });
  for (const t of teams) {
    const winRate = (t.wins + .5*t.ties) / games;
    const allPlayRate = t.allPlayGames ? t.allPlayWins/t.allPlayGames : 0;
    const recent = t.scores.filter(s=>recentWeeks.includes(s.week));
    const recentForm = recent.length && recentAverages.some(x=>x>0) ? recent.reduce((sum,s)=>sum + (s.score / (recentAverages[recentWeeks.indexOf(s.week)] || s.score)),0)/recent.length : .5;
    t.power = 100 * (.35*winRate + .25*allPlayRate + .25*(t.pf/maxPf) + .15*Math.min(1.25,recentForm)/1.25);
    t.record = `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`;
    t.allPlayRate = allPlayRate;
    t.allPlayRecord = `${t.allPlayWins}-${t.allPlayLosses}${t.allPlayTies ? `-${t.allPlayTies}` : ""}`;
  }
  return teams.sort((a,b)=>b.power-a.power || b.pf-a.pf);
}
function calculateMovement(week, rankings) {
  if (week <= 1) return rankings.map((t,i)=>({...t,move:null}));
  const previous = state.rankingsByWeek[week-1] || computeRankings(week-1);
  const previousRanks = new Map(previous.map((t,i)=>[t.id,i+1]));
  return rankings.map((t,i)=>({...t,move:(previousRanks.get(t.id) || i+1)-(i+1)}));
}

const EDITORIAL_EDITIONS = {
  10: {
    date: "NOVEMBER 17, 2026",
    rankings: [
      { manager: "Ben", note: "Twelve straight wins. Ben has turned this into a hostile takeover, and adding Jaxon Smith-Njigba only makes the league's deepest team tougher to catch. This isn't a fluky streak — the weekly production has been relentless. At this point, the question is who can finally slow him down." },
      { manager: "Marc", note: "Marc is quietly having the kind of season that gets overshadowed by a twelve-game winning streak. At 15-5 with one of the league's best all-play records, he's been a steady contender all year. Jonathan Taylor gives him a weekly hammer, and the rest of the roster keeps the floor high. Annoyingly competent." },
      { manager: "Kevin", note: "Kevin still leads the league in points, but losing Puka Nacua is a major blow at the worst possible time. His 15-5 record gives him some breathing room, yet the next few weeks will show whether that scoring firepower can hold up without one of its biggest engines." },
      { manager: "Colby", note: "Colby has the talent to make a playoff run, but the weekly floor has been tough to trust. The skill-position group can carry a matchup; the unsettled quarterback spot keeps getting in the way. If that position stabilizes, this roster can be a real problem." },
      { manager: "Brandon", note: "Brandon is second in points and tied for the league's best all-play record, yet Week 10 still brought a loss to Pat's 140.08. That's the schedule-luck tax. Ja'Marr Chase gives him a massive weekly ceiling, and the underlying numbers still say contender — even if the standings haven't cooperated." },
      { manager: "Evan", note: "Evan's middle-of-the-pack record hides a higher ceiling. Jahmyr Gibbs and Derrick Henry are a formidable duo, and Malik Nabers can swing a week. The issue is getting the full lineup to show up together. A healthy Mike Evans would help, but this team needs a more consistent stretch." },
      { manager: "Joey", note: "Joey's trade for Tee Higgins and George Pickens gives him a much more dangerous set of weekly options. The ceiling is higher immediately, but now the rest of the lineup has to keep pace. Joey made his bet; we'll see whether it turns into wins or just a very impressive group chat screenshot." },
      { manager: "Pat", note: "Pat dropped 140.08 to beat Brandon and take the week's top score — a Sunday that makes the rest of the league check the app twice. Christian McCaffrey gives him real upside, but consistency around that star power remains the question, especially with Lamar Jackson's recovery uncertain." },
      { manager: "Butta", note: "Drake Maye's serious ankle injury is the biggest hit to Butta's outlook, with a possible fracture and extended absence threatening a major hole at quarterback. A.J. Brown's situation adds to the concern. Butta still has talent, but losing Maye changes the equation." },
      { manager: "Lee", note: "Lee needs the roster to start winning actual matchups. Bijan Robinson and Justin Jefferson are excellent building blocks, but a 7-13 record leaves little room for another 'next week will be different.' The schedule hasn't always been kind, but the playoff math is getting less friendly by the week." },
      
      { manager: "Ders", note: "Ders is running out of runway. At 3-17, he needs wins now, not just the occasional big week from Josh Allen. Injuries haven't helped, but the lineup needs more complete performances to turn its potential into results. The standings are starting to look like a countdown clock." },
      { manager: "Tanz", note: "Tanz is officially out of playoff contention, so the mission is now avoiding the last-place punishment — and escaping parlay duty. The three-team deal that sent George Pickens away cost him two wins this week, a brutal start for the roster shake-up. Another finish at the bottom means another week organizing the league's $5 parlay, so there's still plenty on the line." }
    ],
    headline: "Twelve straight for Ben, and the rest of the league is running out of answers",
    feature: "Week 10 had a little bit of everything: Ben kept the winning streak rolling, Pat posted the league\u2019s top score at 140.08, and Brandon took another frustrating hit despite having one of the league\u2019s strongest scoring profiles. The three-team trade also changed the outlook for Joey, Ben, and Tanz. The biggest takeaway? The top of the rankings is being driven by sustained production, while the teams chasing them need to turn good rosters and near-misses into actual wins.",
    notes: [
      "Top score: Pat — 140.08 points",
      "Schedule gut-punch: Brandon owns one of the league\u2019s best all-play records but still lost to Pat\u2019s 140.08-point week",
      "Closest median result: Tanz finished 1.21 points below the median",
      "Trade impact: Joey added Tee Higgins and George Pickens; Ben added Jaxon Smith-Njigba; Tanz added Tony Pollard",
      "Injury watch: Kevin\u2019s loss of Puka Nacua is a major test for the league\u2019s highest-scoring team"
    ]
  },
  11: {
    date: "NOVEMBER 24, 2026",
    rankings: [
      { manager: "Ben", note: "Ben stays at No. 1 after another 2-0 week, beating Pat head-to-head and clearing the league median to keep his winning streak alive. He is now 15-7 and continues to look like the team everyone else is chasing. The steady run of strong performances makes a pretty convincing case that this is the team everyone else needs to catch." },
      { manager: "Kevin", note: "Kevin climbs to No. 2 with the league's best record at 17-5 and the highest point total at 1,287.66. He handled Tanz 125.38-93.42 and continues to pile up points without Puka Nacua. The combination of a league-best record and scoring pace makes him a very real threat to take over the top spot." },
      { manager: "Colby", note: "Colby moves into the top three at 16-6 after another comfortable win, and the numbers back it up: second in points and tied for the league's best all-play record. The running back and wide receiver groups are very strong, but the quarterback room remains the obvious concern heading into the playoff push. If that spot holds up, Colby will be a tough out." },
      { manager: "Marc", note: "Marc remains in the top four at 15-7, but an 85-point week against Joey was a missed opportunity to keep pace with the leaders. He doesn't need a full roster overhaul — he needs Kenneth Walker back soon to give the lineup a boost and help get things moving in the right direction. Kevin and Colby have earned the spots ahead of him for now." },
      { manager: "Evan", note: "Evan jumps Brandon after dropping the week's top score at 134.76 in a nearly 49-point win over Butta. Mike Evans returned and immediately dominated, giving Evan another big-time option as the team makes its push up the standings. At 13-9 and third in points, this is starting to look like a team nobody will want to run into." },
      { manager: "Brandon", note: "Brandon survived a tight one against Lee, 84.24-77.12, but finished below the league median and slips one spot after Evan's huge week. He's still firmly in the playoff picture with a strong overall profile, though Bhayshul Tuten's injury is one to watch as the stretch run gets underway. A little less drama on Sundays would be appreciated." },
      { manager: "Joey", note: "Joey holds at No. 7 after knocking off Marc with 115.46 points, moving to 11-11 and right back into the playoff conversation. Jonah Coleman is beginning to look like an emerging star, and if he can keep that momentum going, he could be the piece that helps propel Joey into the postseason. The margin for error is still thin, but the timing is getting interesting." },
      { manager: "Pat", note: "Pat falls to 11-11 after an 86.34-point effort in a loss to Ben. Chase Brown came crashing back down after a strong Week 10 that offered some hope for the rest of the season, and Pat couldn't find enough elsewhere to keep pace. He's still within striking distance, but the next few weeks are becoming increasingly important." },
      { manager: "Butta", note: "Butta drops to 9-13 after drawing the week's highest score from Evan. The path back is getting narrower, and it will be tough to make a real run without Drake Maye and A.J. Brown available. There's still time to make noise, but this roster needs some good fortune — and quickly." },
      { manager: "Lee", note: "Lee went 0-2 in Week 11 after deciding to hold Bijan Robinson through his bye and Davante Adams on injured reserve. That patience has left him in an almost impossible spot: he must go 6-0 over the final three weeks just to catch the 5th- and 6th-place teams, and he also needs either Evan or Brandon to go 0-6 plus additional help elsewhere. At 7-15, the margin for error is officially gone." },
      { manager: "Ders", note: "Ders took another tough hit, falling 126.26-57.90 to Colby for the lowest score of the week. At 3-19, the playoff race is over, and the focus shifts to finishing the season with some dignity and avoiding the bottom spot. The good news? There's still a little breathing room in the last-place race — for now." },
      { manager: "Tanz", note: "Tanz is officially eliminated from the playoff race at 2-20, but he finally got a win on the board by finishing above the league median in Week 11. It's a small step, but it brings him a little closer to Ders in the race to avoid last place. The standings are still ugly, but at least there's finally a pulse." }
    ],
    headline: "Ben keeps rolling as Kevin and Colby close in",
    feature: "Ben remains No. 1 after extending his winning streak with a 2-0 week: he beat Pat head-to-head and finished above the league median. Kevin owns the league\u2019s best record and point total, while Colby continues to keep pace; both move ahead of Marc in the rankings. Evan jumps Brandon after leading all scorers at 134.76. At the other end, the playoff race is over for Ders and Tanz, but the last-place battle is still very much alive. Ders finished last at 57.90.",
    notes: [
      "Top score: Evan — 134.76 points",
      "Lowest score: Ders — 57.90 points",
      "League median: 89.88; Tanz was the only losing head-to-head team to finish above it",
      "Biggest blowout: Colby beat Ders 126.26–57.90, a 68.36-point margin",
      "Standings watch: Kevin leads at 17-5, with Colby one game back at 16-6",
      "Playoff picture: Ders and Tanz are mathematically eliminated; the top six remain Kevin, Colby, Ben, Marc, Evan and Brandon"
    ]
  }
};
function renderPowerRankings(week) {
  state.selectedRankingWeek=week;
  // Navigation runs before init() finishes loading Sleeper's league core.
  // Keep direct links to this tab from aborting startup on a cold refresh.
  if (!state.teams?.size) {
    const board=$("pr-board");
    if (board) board.innerHTML='<div class="pr-empty">Loading league data from Sleeper…</div>';
    return;
  }
  const completedWeeks=Object.keys(state.weeks).map(Number).filter(w=>(state.weeks[w]||[]).filter(match=>num(match.points)>0).length>=state.teams.size);
  const publishedWeeks=Object.keys(EDITORIAL_EDITIONS).map(Number);
  const maxWeek=Math.min(getWeeksToLoad(),Math.max(1,...completedWeeks,...publishedWeeks)),archive=$("pr-archive"),select=$("week-select"),edition=EDITORIAL_EDITIONS[week];
  if(select)select.value=String(week);
  if(archive){
    archive.innerHTML=Array.from({length:maxWeek},(_,i)=>maxWeek-i).map(w=>'<button type="button" class="pr-archive-item '+(w===week?'active':'')+'" data-week="'+w+'"><span>Week '+String(w).padStart(2,"0")+'</span><small>'+(EDITORIAL_EDITIONS[w]?.date||'Edition pending')+'</small></button>').join("")+'<button type="button" class="pr-archive-item" data-week="0"><span>Post-Draft</span><small>September 2026</small></button>';
    archive.querySelectorAll("button").forEach(btn=>btn.addEventListener("click",()=>{const w=Number(btn.dataset.week);if(w===0){$("pr-week-title").textContent="Post-Draft";$("pr-edition-label").textContent="SEPTEMBER 2026";$("pr-board").innerHTML='<div class="pr-empty"><strong>POST-DRAFT RANKINGS</strong><p>The post-draft editorial edition has not been added yet.</p></div>';$("pr-rank-count").textContent="POST-DRAFT";archive.querySelectorAll("button").forEach(x=>x.classList.toggle("active",x===btn));const b=$("pr-reveal");if(b)b.hidden=true;}else {saveRankingEdition(w);renderPowerRankings(w);}}));
  }
  $("pr-week-title").textContent="Week "+week;
  $("pr-edition-label").textContent=edition?.date||"EDITION PENDING";
  const stats=computeRankings(week),byName=new Map(stats.map(t=>[t.name,t])),previous=EDITORIAL_EDITIONS[week-1]?.rankings||[],priorRanks=new Map(previous.map((r,i)=>[r.manager,i+1])),hasEdition=Boolean(edition?.rankings?.length);
  const palette=["#67D9F2","#FF8A7A","#C3A0FF","#F4D06F","#7FE0B5","#FF9BCB","#83B5FF","#FFB36B","#C2DF72","#D4B4F0","#63D6C8","#F28FA3"];
  const teamOrder=[...state.teams.keys()];
  const colorFor=t=>palette[Math.max(0,teamOrder.indexOf(t?.id))%palette.length];
  const ordinal=n=>n%100>=11&&n%100<=13?n+"th":n%10===1?n+"st":n%10===2?n+"nd":n%10===3?n+"rd":n+"th";
  const pfRanks=new Map([...stats].sort((a,b)=>b.pf-a.pf).map((t,i)=>[t.name,i+1]));
  const paRanks=new Map([...stats].sort((a,b)=>b.pa-a.pa).map((t,i)=>[t.name,i+1]));
  if(!hasEdition)$("pr-board").innerHTML='<div class="pr-empty"><strong>THIS EDITION HAS NOT BEEN PUBLISHED.</strong><p>Power Rankings are editorial, not an automated sort of the standings. The live scoring picture and standings are shown below; this edition’s ranked order and written analysis have not been entered yet.</p></div>';
  else $("pr-board").innerHTML=edition.rankings.map((entry,i)=>{
    const t=byName.get(entry.manager);if(!t)return "";
    const rank=i+1,prior=priorRanks.get(entry.manager),move=prior==null?0:prior-rank;
    const txt=prior==null?"—":move>0?"▲"+move:move<0?"▼"+Math.abs(move):"—";
    const cls=move>0?"up":move<0?"dn":"ev",dir=move>0?"up":move<0?"dn":"ev",color=colorFor(t);
    return '<article class="pr-card" style="--tc:'+color+';--sp:'+color+'" data-prev="'+(prior||rank)+'" data-final="'+rank+'" data-move="'+move+'" data-dir="'+dir+'">'+
      '<div class="pr-rank"><div class="pr-num"><span class="v prev">'+(prior||rank)+'</span><span class="v final">'+rank+'</span></div><span class="pr-mv '+cls+'">'+txt+'</span></div>'+
      '<div class="pr-mid"><div class="pr-nmrow"><span class="nm">'+escapeHtml(entry.manager)+'</span><span class="pr-meta"><span class="rec"><span class="w">'+t.wins+'</span><span class="dash">-</span><span class="l">'+t.losses+'</span></span><span class="dot">·</span><span class="pf">PF '+fmt(t.pf)+' ('+ordinal(pfRanks.get(t.name))+')</span><span class="dot">·</span><span class="pa">PA '+fmt(t.pa)+' ('+ordinal(paRanks.get(t.name))+')</span></span></div>'+
      '<div class="bl-wrap"><div class="bl">'+(entry.note?escapeHtml(entry.note):'<span class="pr-note-pending">Commentary pending.</span>')+'</div></div></div></article>';
  }).join("");
  setTextIfPresent("pr-rank-count",hasEdition?edition.rankings.length+" / 12 RANKED":"12 MANAGERS");
  const reveal=$("pr-reveal");if(reveal){reveal.hidden=!hasEdition;reveal.textContent="REVEAL RANKINGS";window.initPowerRankingsReveal?.();}
  const scores=(state.weeks[week]||[]).filter(m=>num(m.points)>0).sort((a,b)=>num(b.points)-num(a.points));
  const matchupResults=calculateWeek(week).results,outcomeByRoster=new Map();
  for(const matchup of matchupResults){
    if(matchup.winner===1){outcomeByRoster.set(matchup.a.id,"win");outcomeByRoster.set(matchup.b.id,"loss");}
    else if(matchup.winner===2){outcomeByRoster.set(matchup.a.id,"loss");outcomeByRoster.set(matchup.b.id,"win");}
    else {outcomeByRoster.set(matchup.a.id,"even");outcomeByRoster.set(matchup.b.id,"even");}
  }
  $("weekly-chart-bars").innerHTML=scores.length?scores.map((m,index)=>{
    const t=teamFor(m.roster_id),score=num(m.points),height=Math.max(10,Math.round(score/(num(scores[0]?.points)||1)*118)),result=outcomeByRoster.get(Number(m.roster_id))||"even";
    return '<div class="pr-chart-bar-item" title="'+escapeHtml(t?.name||"Manager")+': '+fmt(score)+' · '+(result==="win"?"WIN":result==="loss"?"LOSS":"TIE")+'"><span>'+fmt(score)+'</span><i class="'+result+'" style="height:'+height+'px"></i><b>'+escapeHtml(t?.name||"—")+'</b></div>'+(index===5?'<div class="pr-chart-median-divider" aria-label="Median cutoff"></div>':"");
  }).join(""):'<div class="pr-empty">No completed scoring data for this week.</div>';
  const standings=[...stats].sort((a,b)=>b.wins-a.wins||b.pf-a.pf),editorialRanks=new Map((edition?.rankings||[]).map((r,i)=>[r.manager,i+1]));
  const playoffStart=num(state.league?.settings?.playoff_week_start)||15;
  const remainingWeeks=Math.max(0,playoffStart-week-1);
  const cutoffWins=standings[5]?.wins??Infinity;
  const standingRows=standings.map((t,i)=>{
    const color=colorFor(t),rank=editorialRanks.get(t.name),record=t.record.split("-");
    const eliminated=i>=6&&t.wins+(2*remainingWeeks)<cutoffWins;
    return '<tr><th scope="row" class="c-team"><span class="sd">'+(i+1)+'</span><span class="nm" style="color:'+color+'">'+escapeHtml(t.name)+(eliminated?'<span class="pr-eliminated">ELIMINATED</span>':'')+'</span></th>'+
      '<td class="c-rec"><span class="w">'+(record[0]||0)+'</span><span class="dash">-</span><span class="l">'+(record[1]||0)+'</span>'+(record[2]?'<span class="dash">-</span><span>'+record[2]+'</span>':'')+'</td>'+
      '<td class="num">'+fmt(t.pf)+'</td><td class="num">'+fmt(t.pa)+'</td><td class="num">'+escapeHtml(t.allPlayRecord)+'</td>'+
      '<td><span class="pr-pr">'+(rank||"—")+'</span></td></tr>';
  });
  const playoffLine='<tr class="pr-cut" aria-label="Playoff cutoff"><td colspan="6"></td></tr>';
  $("pr-standings-body").innerHTML=standingRows.slice(0,6).join("")+playoffLine+standingRows.slice(6).join("");
}

function renderScoreboard(week) {
  const {results} = calculateWeek(week);
  const el = $("scoreboard");
  // The current League page does not include a weekly scoreboard element.
  // Keep this renderer optional so a missing section cannot abort dashboard startup.
  if (!el) return;
  if (!results.length) { el.innerHTML = '<div class="empty-note">No completed matchups found for this week yet.</div>'; return; }
  el.innerHTML = results.sort((a,b)=>Math.max(b.scoreA,b.scoreB)-Math.max(a.scoreA,a.scoreB)).map(m=>`
    <div class="matchup">
      <div class="match-team"><span class="match-team-name">${teamName(m.a)} <small>${escapeHtml(m.a.owner)}</small></span></div>
      <div class="match-score ${m.winner===1?'winner':''}">${fmt(m.scoreA)} <span class="versus">—</span> <span class="${m.winner===2?'winner':''}">${fmt(m.scoreB)}</span></div>
      <div class="match-team"><span class="match-team-name">${teamName(m.b)} <small>${escapeHtml(m.b.owner)}</small></span></div>
    </div>`).join("");
}
function renderStandings(week) {
 const teams=[...state.teams.values()].map(t=>({...t,wins:0,losses:0,ties:0,pf:0,pa:0}));
 const map=new Map(teams.map(t=>[t.id,t]));
 for(let w=1;w<=week;w++){
  const groups=new Map();
  for(const m of state.weeks[w]||[]){if(!groups.has(m.matchup_id))groups.set(m.matchup_id,[]);groups.get(m.matchup_id).push(m);}
  for(const g of groups.values()){if(g.length!==2||g.some(m=>num(m.points)<=0))continue;const [a,b]=g,ta=map.get(Number(a.roster_id)),tb=map.get(Number(b.roster_id));if(!ta||!tb)continue;ta.pf+=num(a.points);tb.pf+=num(b.points);ta.pa+=num(b.points);tb.pa+=num(a.points);if(num(a.points)>num(b.points)){ta.wins++;tb.losses++;}else if(num(a.points)<num(b.points)){tb.wins++;ta.losses++;}else{ta.ties++;tb.ties++;}}
  const scores=(state.weeks[w]||[]).filter(m=>num(m.points)>0).map(m=>num(m.points)).sort((x,y)=>x-y);
  if(scores.length===teams.length){const med=(scores[5]+scores[6])/2;for(const m of state.weeks[w]){const t=map.get(Number(m.roster_id));if(!t||num(m.points)<=0)continue;if(num(m.points)>med)t.wins++;else if(num(m.points)<med)t.losses++;else t.ties++;}}
 }
 teams.sort((x,y)=>y.wins-x.wins||y.pf-x.pf);
 const colors=["#ff4d91","#26b9d5","#9a68ff","#e8b83d","#50c99a","#f0784f","#b5a0ff","#5dc4ee","#e47eb4","#a7d86c","#f1a34c","#8d9cf5"];
 const playoffStart=num(state.league?.settings?.playoff_week_start)||15;
 const remainingWeeks=Math.max(0,playoffStart-week-1);
 const cutoffWins=teams[5]?.wins ?? Infinity;
 const row=(t,i)=>{const eliminated=i>=6 && t.wins+(2*remainingWeeks)<cutoffWins;return `<div class="league-team-row ${i===6?"playoff-divider":""}"><span class="team-rank">${String(i+1).padStart(2,"0")}</span><div class="league-team-identity"><strong>${teamName(t)}${eliminated?` <span class="eliminated-label">ELIMINATED</span>`:""}</strong></div><span class="league-team-record">${t.wins}-${t.losses}${t.ties?"-"+t.ties:""}</span></div>`;};
 $("standings-list").innerHTML=teams.map(row).join("");
}
function renderLeagueStatus(week){
 const max=getWeeksToLoad(),label=$("current-week-label"),phase=$("league-phase"),buttons=$("league-week-buttons");
 if(label)label.textContent="WEEK "+week;
 const leagueStatus=state.league?.status;
 const playoffStart=num(state.league?.settings?.playoff_week_start)||15;
 const phaseIndex=leagueStatus==="pre_draft"?0:leagueStatus==="drafting"?1:(week>=playoffStart||leagueStatus==="complete")?3:2;
 const phaseNames=["PRE-DRAFT","DRAFT","REGULAR SEASON","PLAYOFFS"];
 if(phase)phase.textContent=phaseNames[phaseIndex];
 document.querySelectorAll(".phase-track span").forEach((bar,i)=>bar.classList.toggle("phase-done",i<=phaseIndex));
 if(buttons){buttons.innerHTML=Array.from({length:max},(_,i)=>i+1).map(w=>'<button type="button" class="week-chip '+(w===week?'active':'')+'" data-week="'+w+'">'+w+'</button>').join("");buttons.querySelectorAll("button").forEach(btn=>btn.addEventListener("click",()=>{state.weekManuallySelected=true;renderWeek(Number(btn.dataset.week));}));}
}
function renderStats(week, rankings) {
  // Legacy dashboard statistic cards are not part of the current page layout.
  // Update them only when the corresponding optional element exists.
  const weekData = calculateWeek(week);
  const scores = (state.weeks[week] || []).filter(m => num(m.points) > 0);
  const high = scores.sort((a,b) => num(b.points) - num(a.points))[0];
  const average = scores.length ? scores.reduce((sum,m) => sum + num(m.points), 0) / scores.length : 0;
  setTextIfPresent("top-team", rankings[0]?.name || "—");
  setTextIfPresent("top-team-foot", rankings[0] ? `RANKED #1 · ${Math.round(rankings[0].power)} POWER` : "POWER INDEX LEADER");
  setTextIfPresent("weekly-high", high ? fmt(high.points) : "—");
  setTextIfPresent("weekly-high-foot", high ? teamFor(high.roster_id)?.name || "WEEKLY HIGH" : "NO SCORES YET");
  const riser = rankings.filter(t => t.move > 0).sort((a,b) => b.move - a.move)[0];
  setTextIfPresent("biggest-riser", riser ? riser.name : "—");
  setTextIfPresent("biggest-riser-foot", riser ? `UP ${riser.move} ${riser.move === 1 ? "SPOT" : "SPOTS"}` : "NO MOVEMENT DATA");
  setTextIfPresent("league-average", average ? fmt(average) : "—");
  if (weekData.played && rankings.length) {
    const best = rankings[0], worst = rankings[rankings.length - 1];
    const topScore = high ? fmt(high.points) : "";
    const rankMove = riser ? `${riser.name} made the biggest move, climbing ${riser.move} place${riser.move === 1 ? "" : "s"}.` : "The power rankings held relatively steady this week.";
    setTextIfPresent("takeaway", `${best.name} sits atop the Power Index, while ${worst.name} has work to do from the bottom. ${rankMove} The week's high score was ${topScore} by ${teamFor(high.roster_id)?.name || "a league team"}.`);
  } else {
    setTextIfPresent("takeaway", "The league story will take shape once this week's matchups are complete. Check back after the scores are in.");
  }
}
function renderWeek(week) {
  state.selectedWeek=week;
  renderScoreboard(week);
  renderStandings(week);
  renderLeagueStatus(week);
  const statusParts = ["CONNECTED · " + state.teams.size + " TEAMS", "DATA THROUGH WEEK " + week];
  if (state.usingCachedCore) statusParts.push("SAVED LEAGUE DETAILS IN USE");
  if (state.recoveredWeeks.length) statusParts.push("SAVED WEEK DATA: " + state.recoveredWeeks.join(", "));
  if (state.failedWeeks.length) statusParts.push("WEEKS UNAVAILABLE: " + state.failedWeeks.join(", "));
  $("status").textContent = statusParts.join(" · ");
  $("status").classList.toggle("error", state.failedWeeks.length > 0);
}
async function init() {
  const cache = readStartupCache();
  const requests = [["league", "/league/" + LEAGUE_ID], ["users", "/league/" + LEAGUE_ID + "/users"], ["rosters", "/league/" + LEAGUE_ID + "/rosters"]];
  const hasFullCachedCore = requests.every(([key]) => hasCachedCore(cache, key));
  const coreRefreshPromise = Promise.all(requests.map(async ([key, path]) => {
    try {
      const value = await fetchJson(path);
      const valid = key === "league" ? value && value.league_id : Array.isArray(value) && value.length > 0;
      if (!valid) throw new Error("Sleeper returned invalid " + key + " data.");
      writeStartupCache({ [key]: value });
      return { key, value, cached: false };
    } catch (error) {
      console.warn("Sleeper " + key + " request failed after retries", error);
      return hasCachedCore(cache, key) ? { key, value: cache[key], cached: true } : { key, value: null, error };
    }
  }));
  // NFL state is independent of the league data, so request it in parallel and
  // never make a cached first paint wait for this endpoint.
  const nflStatePromise = fetchJson("/state/nfl", { attempts: 1, timeoutMs: 6000 })
    .then(value => {
      state.nflState = value;
      state.currentWeek = Math.max(1, Math.min(14, num(value?.week) || state.currentWeek || 1));
      state.matchupWeek = state.currentWeek;
      return value;
    })
    .catch(() => { state.nflState = null; return null; });

  try {
    let coreResults;
    if (hasFullCachedCore) {
      // Hydrate synchronously from local storage, then let live requests refresh
      // the data in the background without blocking the initial render.
      coreResults = requests.map(([key]) => ({ key, value: cache[key], cached: true }));
    } else {
      // First visit (or incomplete local cache): live core data is required.
      coreResults = await coreRefreshPromise;
      const missing = coreResults.filter(item => !item.value);
      if (missing.length) throw new Error("Required data unavailable (" + missing.map(item => item.key + ": " + (item.error?.message || "no saved copy")).join("; ") + ").");
    }
    const applyCore = (results, refresh = false) => {
      const missing = results.filter(item => !item.value);
      if (missing.length) return;
      const core = Object.fromEntries(results.map(item => [item.key, item.value]));
      state.league = core.league; state.users = core.users; state.rosters = core.rosters;
      state.usingCachedCore = results.some(item => item.cached);
      buildTeams();
      if (!refresh) {
        renderLotteryHistory();
        loadActualDraftOrder();
      }
      const season = core.league.season || String(new Date().getFullYear());
      $("season-label").textContent = season + " SLEEPER LEAGUE · EST. 2017";
      $("season-tag").textContent = season + " SEASON · EST. 2017";
      const rankingsSeasonTag = $("season-tag-rankings");
      if (rankingsSeasonTag) rankingsSeasonTag.textContent = season + " SEASON · EST. 2017";
      if (refresh) {
        renderWeek(state.selectedWeek || 1);
        renderPowerRankings(state.selectedRankingWeek ?? getDefaultRankingEdition());
        renderSchedule();
        updateStartupStatus();
        $("updated-at").textContent = state.usingCachedCore ? "SLEEPER API · SAVED LEAGUE DETAILS IN USE" : "SLEEPER API · LIVE LEAGUE DETAILS";
      }
    };
    applyCore(coreResults);
    resolveSleeperCoreReady(true);
    if (hasFullCachedCore) {
      coreRefreshPromise.then(results => {
        if (results.every(item => item.value)) applyCore(results, true);
        else console.warn("Background Sleeper refresh incomplete; continuing with saved league details.");
      });
    }

    const maxWeek = getWeeksToLoad();
    const savedWeeks = cache.weeks && typeof cache.weeks === "object" ? cache.weeks : {};
    for (let week = 1; week <= maxWeek; week++) {
      if (Array.isArray(savedWeeks[String(week)])) state.weeks[week] = savedWeeks[String(week)];
    }

    const cachedCompleted = Array.from({ length: maxWeek }, (_, index) => index + 1)
      .filter(week => (state.weeks[week] || []).filter(match => num(match.points) > 0).length >= state.teams.size);
    const cachedLatest = cachedCompleted.length ? Math.max(...cachedCompleted) : 1;
    state.currentWeek = Math.max(1, Math.min(14, num(state.nflState?.week) || cachedLatest));
    state.matchupWeek = state.currentWeek;
    // Allow the independent NFL-state request to update currentWeek when it arrives.
    void nflStatePromise;
    const initialWeek = cachedLatest;
    const savedRankingWeek = readSavedRankingEdition();
    const rankingWeek = savedRankingWeek === 0 || (savedRankingWeek && EDITORIAL_EDITIONS[savedRankingWeek]) ? savedRankingWeek : getDefaultRankingEdition();
    const select = $("week-select");
    select.innerHTML = Array.from({ length: maxWeek }, (_, index) => `<option value="${index + 1}">WEEK ${index + 1}</option>`).join("");
    if (!select.dataset.listenerAttached) {
      select.addEventListener("change", () => { const week=Number(select.value); saveRankingEdition(week); renderPowerRankings(week); });
      select.dataset.listenerAttached = "yes";
    }

    // Render immediately from the last saved data. On a first visit, render the shell
    // with placeholders and fill it in as small batches arrive.
    renderWeek(initialWeek);
    renderPowerRankings(rankingWeek);
    renderSchedule();
    renderScheduleComparison();
    $("updated-at").textContent = state.usingCachedCore ? "SLEEPER API · SAVED LEAGUE DETAILS IN USE" : "SLEEPER API · REFRESHING WEEKLY DATA";
    updateStartupStatus();

    // Reuse saved historical matchups instead of requesting every week on
    // every page load. Refresh the latest completed week and the active week;
    // fetch any weeks that are missing from the local cache (first visit/recovery).
    const weeksToRefresh = Array.from({ length: maxWeek }, (_, index) => index + 1)
      .filter(week => !Array.isArray(savedWeeks[String(week)]) ||
        week === cachedLatest ||
        week === Math.min(maxWeek, Math.max(cachedLatest + 1, state.currentWeek)));
    // Keep requests in small batches so a refresh remains gentle on Sleeper.
    for (let start = 0; start < weeksToRefresh.length; start += 4) {
      const batch = weeksToRefresh.slice(start, start + 4);
      const results = await Promise.all(batch.map(async week => {
        try {
          const data = await fetchJson("/league/" + LEAGUE_ID + "/matchups/" + week, { attempts: 2, timeoutMs: 9000 });
          if (!Array.isArray(data)) throw new Error("Invalid matchup data for week " + week);
          return { week, data, source: "live" };
        } catch (error) {
          console.warn("Week " + week + " failed after retries", error);
          const saved = readStartupCache().weeks || savedWeeks;
          return Array.isArray(saved[String(week)]) ? { week, data: saved[String(week)], source: "cache" } : { week, data: [], source: "missing" };
        }
      }));
      results.forEach(item => { state.weeks[item.week] = item.data; });
      const mergedWeeks = { ...(readStartupCache().weeks || {}) };
      results.forEach(item => { if (item.source === "live") mergedWeeks[String(item.week)] = item.data; });
      writeStartupCache({ weeks: mergedWeeks });
      state.failedWeeks = [...new Set([...state.failedWeeks.filter(week => !batch.includes(week)), ...results.filter(item => item.source === "missing").map(item => item.week)])].sort((a,b)=>a-b);
      state.recoveredWeeks = [...new Set([...state.recoveredWeeks.filter(week => !batch.includes(week)), ...results.filter(item => item.source === "cache").map(item => item.week)])].sort((a,b)=>a-b);

      const completed = Array.from({ length: maxWeek }, (_, index) => index + 1)
        .filter(week => (state.weeks[week] || []).filter(match => num(match.points) > 0).length >= state.teams.size);
      const latestCompletedWeek = completed.length ? Math.max(...completed) : 1;
      if (!state.weekManuallySelected && state.selectedWeek !== latestCompletedWeek) {
        const nextSelect = $("week-select");
        nextSelect.innerHTML = Array.from({ length: maxWeek }, (_, index) => `<option value="${index + 1}">WEEK ${index + 1}</option>`).join("");
        renderWeek(latestCompletedWeek);
        renderPowerRankings(state.selectedRankingWeek ?? rankingWeek);
      } else {
        renderWeek(state.selectedWeek || initialWeek);
        renderPowerRankings(state.selectedRankingWeek ?? rankingWeek);
      }
      renderSchedule();
      // Keep Schedule Comparison in sync as each batch of weekly matchup data arrives.
      renderScheduleComparison();
      $("updated-at").textContent = state.usingCachedCore || state.recoveredWeeks.length ? "SLEEPER API · SAVED DATA USED WHERE NEEDED" : "SLEEPER API · PUBLIC LEAGUE DATA";
      updateStartupStatus();
    }
  } catch (error) {
    resolveSleeperCoreReady(false);
    console.error("League startup failed", error);
    $("status").textContent = "LEAGUE DATA ERROR · " + (error?.message || "Unknown startup error");
    $("status").classList.add("error");
    $("pr-board").innerHTML = '<div class="pr-empty">League data could not be refreshed. No saved fallback was available; please try again shortly.</div>';
    const standings = $("standings-list");
    if (standings) standings.innerHTML = '<div class="empty-note">Standings unavailable. Please try again shortly.</div>';
  }
}
function updateStartupStatus() {
  const week = state.selectedWeek || 1;
  const statusParts = ["CONNECTED · " + state.teams.size + " TEAMS", "DATA THROUGH WEEK " + week];
  if (state.usingCachedCore) statusParts.push("SAVED LEAGUE DETAILS IN USE");
  if (state.recoveredWeeks.length) statusParts.push("SAVED WEEK DATA: " + state.recoveredWeeks.join(", "));
  if (state.failedWeeks.length) statusParts.push("WEEKS UNAVAILABLE: " + state.failedWeeks.join(", "));
  $("status").textContent = statusParts.join(" · ");
  $("status").classList.toggle("error", state.failedWeeks.length > 0);
}
function matchupNormalCdf(z) {
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-x*x);
  return 0.5 * (1 + (z < 0 ? -erf : erf));
}
function normalizeSleeperRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.entries(value).map(([id,row]) => ({ player_id: String(row?.player_id ?? id), ...row }));
  return [];
}
async function loadSleeperPlayers() {
  if (state.players && typeof state.players === "object" && !Array.isArray(state.players) && Object.keys(state.players).length >= 1000) {
    return state.players;
  }
  if (!state.playersPromise) {
    state.playersPromise = fetchJson("/api/sleeper-players", { attempts: 2, timeoutMs: 60000 })
      .then(value => {
        const directory = value?.players || value?.data || value;
        if (!directory || typeof directory !== "object" || Array.isArray(directory) || Object.keys(directory).length < 1000) {
          throw new Error("Sleeper returned an incomplete player directory");
        }
        state.players = directory;
        return directory;
      })
      .catch(error => {
        state.playersPromise = null;
        state.players = null;
        throw error;
      });
  }
  return state.playersPromise;
}
async function loadMatchupWeekData(week) {
  if (state.matchupDataByWeek[week]?.loaded || state.matchupDataByWeek[week]?.loading) return;
  state.matchupDataByWeek[week] = { loading: true };
  const season = state.league?.season || String(new Date().getFullYear());
  const playersTask = loadSleeperPlayers().catch(error => {
    console.warn("Sleeper player directory unavailable for Matchups", error);
    return {};
  });
  const projectionsPath = "/api/sleeper-projections/" + season + "/" + week +
    "?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=pts_half_ppr";
  const statsPath = "/api/sleeper-stats/regular/" + season + "/" + week;
  const schedulePath = "/api/nfl-schedule?seasontype=2&week=" + week + "&year=" + encodeURIComponent(season);
  const [players, projectionsResult, statsResult, scheduleResult] = await Promise.all([
    playersTask,
    fetchJson(projectionsPath, { attempts: 1, timeoutMs: 18000 }).catch(error => { console.warn("Sleeper projections unavailable for week " + week, error); return null; }),
    fetchJson(statsPath, { attempts: 1, timeoutMs: 18000 }).catch(error => { console.warn("Sleeper live stats unavailable for week " + week, error); return null; }),
    fetchJson(schedulePath, { attempts: 1, timeoutMs: 18000 }).catch(error => { console.warn("NFL schedule unavailable for week " + week, error); return null; })
  ]);
  state.matchupDataByWeek[week] = {
    loaded: true,
    players: players || {},
    projections: normalizeSleeperRows(projectionsResult),
    stats: statsResult && typeof statsResult === "object" ? statsResult : {},
    schedule: scheduleResult && typeof scheduleResult === "object" ? scheduleResult : null
  };
  if (state.matchupWeek === week) renderMatchups(week, true);
}
function renderMatchups(week = state.matchupWeek, dataReady = false) {
  const target = $("matchups-content");
  const picker = $("matchups-week-select");
  if (!target || !state.teams?.size) return;
  const regularWeeks = Math.max(1, (num(state.league?.settings?.playoff_week_start) || 15) - 1);
  week = Math.max(1, Math.min(regularWeeks, Number(week) || 1));
  state.matchupWeek = week;
  const season = state.league?.season || new Date().getFullYear();
  setTextIfPresent("matchups-season", season);
  if (picker) {
    if (!picker.options.length) {
      picker.innerHTML = Array.from({ length: regularWeeks }, (_, i) => '<option value="' + (i+1) + '">WEEK ' + String(i+1).padStart(2,"0") + '</option>').join("");
      picker.addEventListener("change", () => renderMatchups(Number(picker.value)));
    }
    picker.value = String(week);
  }
  const source = state.weeks[week] || [];
  const groups = new Map();
  source.forEach(match => {
    if (match.matchup_id == null) return;
    const key = String(match.matchup_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
  });
  const games = [...groups.values()].filter(group => group.length === 2).map(group => {
    const a = group[0], b = group[1], teamA = teamFor(a.roster_id), teamB = teamFor(b.roster_id);
    return teamA && teamB ? { a, b, teamA, teamB } : null;
  }).filter(Boolean);
  if (!games.length) {
    const message = state.failedWeeks.includes(week) ? "Sleeper matchup data is unavailable for this week." : "Sleeper has not posted matchups for this week yet.";
    target.innerHTML = '<div class="mu-empty">' + escapeHtml(message) + '</div>';
    if (!dataReady) loadMatchupWeekData(week);
    return;
  }

  const data = state.matchupDataByWeek[week] || {};
  const players = data.players || state.players || {};
  const projectionRows = data.projections || [];
  const projections = new Map(projectionRows.map(row => [String(row.player_id ?? row.player?.player_id ?? ""), row]).filter(([id]) => id));
  const rawStats = data.stats || {};
  const statsByPlayerId = new Map(
    (Array.isArray(rawStats) ? rawStats : Object.entries(rawStats).map(([id, row]) => ({
      player_id: row?.player_id ?? id,
      ...(row && typeof row === "object" ? row : {})
    }))).map(row => {
      const id = String(row?.player_id ?? row?.id ?? "");
      const nested = row?.stats && typeof row.stats === "object" ? row.stats : {};
      return [id, { ...row, ...nested }];
    }).filter(([id]) => id)
  );
  const scheduleGames = (data.schedule?.events || []).flatMap(event => {
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors || [];
    if (competitors.length !== 2 || !event.date) return [];
    return [{ date: event.date, competitors, completed: Boolean(competition.status?.type?.completed ?? event.status?.type?.completed ?? competition.status?.type?.state === "post") }];
  });
  const teamCode = code => ({ JAC:"JAX", WAS:"WSH", LA:"LAR" }[String(code || "").toUpperCase()] || String(code || "").toUpperCase());
  const teamSchedules = new Map();
  scheduleGames.forEach(game => {
    const home = game.competitors.find(item => item.homeAway === "home") || game.competitors[0];
    const away = game.competitors.find(item => item.homeAway === "away") || game.competitors[1];
    if (!home?.team?.abbreviation || !away?.team?.abbreviation) return;
    const kickoff = new Date(game.date);
    const kickoffLabel = new Intl.DateTimeFormat(undefined, { weekday:"short", hour:"numeric", minute:"2-digit" }).format(kickoff);
    const addTeam = (team, opponent) => teamSchedules.set(teamCode(team.team.abbreviation), {
      teamLogo: team.team.logo || "",
      opponent: opponent.team,
      kickoffLabel,
      logo: opponent.team.logo || "",
      opponentName: opponent.team.displayName || opponent.team.name || opponent.team.abbreviation,
      completed: game.completed,
      finalScore: game.completed ? String(team.score ?? "—") : "",
      opponentFinalScore: game.completed ? String(opponent.score ?? "—") : ""
    });
    addTeam(home, away);
    addTeam(away, home);
  });
  const teamLogo = code => {
    const normalized = teamCode(code);
    return "https://a.espncdn.com/i/teamlogos/nfl/500/" + normalized.toLowerCase() + ".png";
  };
  const currentWeek = Math.max(1, Math.min(regularWeeks, num(state.currentWeek) || state.matchupWeek));
  const isPast = week < currentWeek;
  const recordRows = week > 1 ? computeRankings(week - 1) : computeRankings(0);
  const recordById = new Map(recordRows.map(team => [team.id, team]));
  const seedRows = [...recordRows].sort((a,b) => b.wins-a.wins || b.pf-a.pf);
  const seeds = new Map(seedRows.map((team,index) => [team.id,index+1]));
  const publishedWeek = Object.keys(EDITORIAL_EDITIONS).map(Number).filter(w => w < week && EDITORIAL_EDITIONS[w]?.rankings?.length).sort((a,b) => b-a)[0];
  const powerRanks = new Map((publishedWeek ? EDITORIAL_EDITIONS[publishedWeek].rankings : []).map((entry,index) => [entry.manager, index+1]));
  games.sort((left,right) => {
    const leftRanks = [powerRanks.get(left.teamA.name) || Infinity, powerRanks.get(left.teamB.name) || Infinity].sort((a,b)=>a-b);
    const rightRanks = [powerRanks.get(right.teamA.name) || Infinity, powerRanks.get(right.teamB.name) || Infinity].sort((a,b)=>a-b);
    return leftRanks[0]-rightRanks[0] || leftRanks[1]-rightRanks[1];
  });
  const hasProjectionData = projections.size > 0;

  const positionClass = position => ({
    QB:"qb", RB:"rb", WR:"wr", TE:"te", FLEX:"flex", WRRB_FLEX:"flex", REC_FLEX:"flex",
    SUPER_FLEX:"sflx", SFLX:"sflx"
  }[String(position || "").toUpperCase()] || "other");
  const positionLabel = position => {
    const key = String(position || "").toUpperCase();
    if (["WRRB_FLEX","REC_FLEX"].includes(key)) return "FLEX";
    if (["SUPER_FLEX","SFLX"].includes(key)) return "SFLX";
    return key || "—";
  };
  const playerRow = (playerId, matchup, isStarter, slotPosition = null) => {
    const id = String(playerId);
    const player = players[id] || {};
    const name = player.full_name || [player.first_name, player.last_name].filter(Boolean).join(" ") || (id ? "Player " + id : "Empty slot");
    const position = slotPosition || player.position || player.fantasy_positions?.[0] || "—";
    const label = positionLabel(position);
    const playerTeam = teamCode(player.team);
    const game = teamSchedules.get(playerTeam);
    const gameCompleted = Boolean(game?.completed);
    const playerLogo = player.team ? (game?.teamLogo || teamLogo(player.team)) : "";
    const opponentLogo = game?.logo || (game?.opponent?.abbreviation ? teamLogo(game.opponent.abbreviation) : "");
    const actualStat = statsByPlayerId.get(id);
    const gameMeta = game
      ? gameCompleted
        ? '<span class="mu-player-game"><img src="' + escapeHtml(opponentLogo) + '" alt="' + escapeHtml(game.opponentName) + '" title="' + escapeHtml(game.opponentName) + '" loading="lazy" onerror="this.style.display=\'none\'"> <span>' + escapeHtml(game.finalScore) + '–' + escapeHtml(game.opponentFinalScore) + '</span><b class="mu-final-label">FINAL</b></span>'
        : '<span class="mu-player-game">vs. <img src="' + escapeHtml(opponentLogo) + '" alt="' + escapeHtml(game.opponentName) + '" title="' + escapeHtml(game.opponentName) + '" loading="lazy" onerror="this.style.display=\'none\'"> <span>' + escapeHtml(game.kickoffLabel) + '</span></span>'
      : '<span class="mu-player-game">' + (player.team ? "BYE WEEK" : "GAME INFO UNAVAILABLE") + '</span>';
    const matchupPoints = matchup.players_points && matchup.players_points[id];
    const actual = actualStat?.pts_half_ppr != null ? num(actualStat.pts_half_ppr) : num(matchupPoints);
    const projection = num(projections.get(id)?.stats?.pts_half_ppr);
    const hasProjection = projections.get(id)?.stats?.pts_half_ppr != null;
    const pointsClass = gameCompleted && hasProjection
      ? actual > projection + 0.005 ? "up" : actual < projection - 0.005 ? "down" : "even"
      : "";
    const statGroups = {
      QB: [["pass_cmp","CMP"],["pass_att","PASS ATT"],["pass_yd","PASS YDS"],["pass_td","PASS TD"],["pass_int","INT"],["rush_att","RUSH ATT"],["rush_yd","RUSH YDS"],["rush_td","RUSH TD"],["fum_lost","FUM"]],
      RB: [["rush_att","RUSH ATT"],["rush_yd","RUSH YDS"],["rush_td","RUSH TD"],["rec_tgt","TGT"],["rec","REC"],["rec_yd","REC YDS"],["rec_td","REC TD"],["fum_lost","FUM"]],
      WR: [["rec_tgt","TGT"],["rec","REC"],["rec_yd","REC YDS"],["rec_td","REC TD"],["rush_att","RUSH ATT"],["rush_yd","RUSH YDS"],["rush_td","RUSH TD"],["fum_lost","FUM"]],
      TE: [["rec_tgt","TGT"],["rec","REC"],["rec_yd","REC YDS"],["rec_td","REC TD"],["rush_att","RUSH ATT"],["rush_yd","RUSH YDS"],["rush_td","RUSH TD"],["fum_lost","FUM"]],
      K: [["fgm","FGM"],["fga","FGA"],["fgm_0_19","0-19 FG"],["fgm_20_29","20-29 FG"],["fgm_30_39","30-39 FG"],["fgm_40_49","40-49 FG"],["fgm_50_plus","50+ FG"],["xpm","XP"],["xpa","XP ATT"]],
      DEF: [["sack","SACK"],["int","INT"],["fum_rec","FR"],["def_td","TD"],["safety","SAFETY"],["pts_allow","PA"]]
    };
    const statPosition = String(player.position || player.fantasy_positions?.[0] || position || "").toUpperCase();
    const statLine = actualStat
      ? (statGroups[statPosition] || []).filter(([key]) => actualStat[key] != null && Number(actualStat[key]) !== 0)
          .map(([key,label]) => '<span>' + label + ' <b>' + escapeHtml(String(actualStat[key])) + '</b></span>').join("")
      : "";
    return '<div class="mu-player-row ' + (isStarter ? "starter" : "bench") + '">' +
      '<span class="mu-player-pos ' + positionClass(position) + '">' + escapeHtml(label) + '</span>' +
      '<span class="mu-player-name"><span class="mu-player-primary"><span>' + escapeHtml(name) + '</span>' + (playerLogo ? '<img src="' + escapeHtml(playerLogo) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '') + '</span>' + gameMeta + (statLine ? '<span class="mu-player-stats">' + statLine + '</span>' : '') + '</span>' +
      '<span class="mu-player-points ' + pointsClass + '">' + (actualStat || num(matchupPoints) > 0 || gameCompleted ? fmt(actual) : "—") + '</span>' +
      '<span class="mu-player-proj">' + (hasProjection ? fmt(projection) : "—") + '</span>' +
    '</div>';
  };
  const rosterMarkup = (team, matchup, showBench = false) => {
    const allPlayers = Array.isArray(matchup.players) ? matchup.players.map(String) : [];
    const starters = Array.isArray(matchup.starters) ? matchup.starters.map(String).filter(id => id && id !== "0") : [];
    const starterSet = new Set(starters);
    const rosterRecord = state.rosters.find(roster => Number(roster.roster_id) === Number(team.id));
    const irPlayers = Array.isArray(rosterRecord?.reserve) ? rosterRecord.reserve.map(String) : [];
    const irSet = new Set(irPlayers);
    const fullRoster = [...new Set([...allPlayers, ...irPlayers])];
    const bench = fullRoster.filter(id => !starterSet.has(id));
    const regularBench = bench.filter(id => !irSet.has(id));
    const irBench = bench.filter(id => irSet.has(id));
    const slots = Array.isArray(state.league?.roster_positions) ? state.league.roster_positions : [];
    const renderPlayerRows = ids => ids.map(id => {
      const slotPosition = showBench ? null : slots[starters.indexOf(id)];
      return playerRow(id, matchup, !showBench, slotPosition);
    }).join("");
    const rows = showBench
      ? renderPlayerRows(regularBench) +
        (irBench.length ? '<div class="mu-ir-divider"><span>INJURED RESERVE</span></div>' + renderPlayerRows(irBench) : "")
      : renderPlayerRows(starters);
    return '<section class="mu-roster-team"><h4 style="color:' + lotteryColor(team.name) + '">' + escapeHtml(team.name) + '</h4>' +
      '<div class="mu-player-head"><span>POS</span><span>PLAYER</span><span>PTS</span><span>PROJ</span></div>' +
      (rows || '<p class="mu-empty">' + (showBench ? "No bench players listed." : "Starter data unavailable.") + '</p>') +
    '</section>';
  };
  const projectionFor = (team, matchup) => {
    const starters = Array.isArray(matchup.starters) ? matchup.starters.map(String).filter(id => id && id !== "0") : [];
    let originalTotal = 0, liveTotal = 0, found = false;
    for (const id of starters) {
      const stat = stats[id];
      const matchupPoints = matchup.players_points && matchup.players_points[id];
      const actual = stat?.pts_half_ppr != null ? num(stat.pts_half_ppr) : num(matchupPoints);
      const projection = projections.get(id)?.stats?.pts_half_ppr;
      if (projection != null && Number.isFinite(Number(projection))) {
        const original = Number(projection);
        originalTotal += original;
        liveTotal += stat || num(matchupPoints) > 0 ? actual : original;
        found = true;
      } else if (stat || matchupPoints != null) {
        liveTotal += actual;
      }
    }
    const actualTeamScore = num(matchup.points);
    if (isPast) return { value: actualTeamScore, original: null, available: true };
    return {
      value: Math.max(actualTeamScore, liveTotal),
      original: originalTotal,
      available: hasProjectionData && found
    };
  };
  const teamSummary = (team, matchup) => {
    const record = recordById.get(team.id);
    const powerRank = powerRanks.get(team.name);
    const projected = projectionFor(team, matchup);
    const starters = Array.isArray(matchup.starters) ? matchup.starters.map(String).filter(id => id && id !== "0") : [];
    let teamFinished = scheduleGames.length > 0 && starters.length > 0;
    for (const id of starters) {
      const player = players[id] || {};
      const playerTeam = teamCode(player.team);
      const game = teamSchedules.get(playerTeam);
      const hasBye = Boolean(playerTeam) && !game && scheduleGames.length > 0;
      if (!playerTeam || (!hasBye && !game?.completed)) teamFinished = false;
    }
    const score = num(matchup.points);
    return { record: record?.record || "0-0", seed: seeds.get(team.id), powerRank, projected, score, finished: teamFinished, color: lotteryColor(team.name) };
  };
  const probability = (a, b) => {
    if (isPast) {
      if (a.score === b.score) return 50;
      return a.score > b.score ? 100 : 0;
    }
    if (!a.projected.available || !b.projected.available) return null;
    return Math.max(1, Math.min(99, Math.round(matchupNormalCdf((a.projected.value - b.projected.value) / 22) * 100)));
  };
  const cards = games.map((game,index) => {
    const a = teamSummary(game.teamA, game.a), b = teamSummary(game.teamB, game.b);
    const probA = probability(a,b), probB = probA == null ? null : 100 - probA;
    const matchupComplete = a.finished && b.finished;
    const winnerA = matchupComplete && a.score > b.score;
    const winnerB = matchupComplete && b.score > a.score;
    const status = matchupComplete ? "FINAL" : (a.score > 0 || b.score > 0 ? "LIVE" : "UPCOMING");
    const side = (team, summary, winChance, isWinner) => {
      const projectionClass = isWinner ? "winner" : "";
      const probabilityClass = winChance == null ? "" : winChance > 50 ? "favored" : winChance < 50 ? "underdog" : "even";
      return '<div class="mu-side ' + (team === game.teamA ? 'side-a' : 'side-b') + '">' +
        '<div class="mu-score-stack"><div class="mu-score-line"><strong class="' + (isWinner ? "winner" : "") + '">' + fmt(summary.score) + '</strong></div>' +
          '<div class="mu-projection-line ' + projectionClass + '">' + (summary.projected.available ? '<b>' + fmt(summary.projected.value) + '</b>' : '<b>—</b>') + '<span>LIVE PROJ.</span></div></div>' +
        '<div class="mu-manager-copy"><strong style="color:' + summary.color + '">' + escapeHtml(team.name) + '</strong>' +
          '<small>' + escapeHtml(summary.record) + '</small></div>' +
        '<div class="mu-manager-meta"><span>SEED <b>#' + (summary.seed || "—") + '</b></span><span>POWER RANK <b>#' + (summary.powerRank || "—") + '</b></span></div>' +
      '</div>';
    };
    const bar = probA == null ? '<div class="mu-prob-track unavailable"></div>' :
      '<div class="mu-prob-track" style="background:linear-gradient(90deg,' +
        (probA >= 50 ? '#35C878 0%,#35C878 ' + probA + '%,#FF4F91 ' + probA + '%,#FF4F91 100%' :
          '#FF4F91 0%,#FF4F91 ' + probA + '%,#35C878 ' + probA + '%,#35C878 100%') + ')"></div>';
    return '<article class="mu-card">' +
      '<div class="mu-card-head"><span>MATCHUP ' + String(index+1).padStart(2,"0") + '</span><span class="mu-live-tag ' + status.toLowerCase() + '">' + status + '</span></div>' +
      '<div class="mu-faceoff">' + side(game.teamA,a,probA,winnerA) + '<div class="mu-versus">VS</div>' + side(game.teamB,b,probB,winnerB) + '</div>' +
      '<div class="mu-prob-wrap">' +
        '<div class="mu-prob-row"><span class="mu-prob-value ' + (probA == null ? '' : probA >= 50 ? 'favored' : 'underdog') + '">' + (probA == null ? '—' : probA + '%') + '</span>' +
        bar +
        '<span class="mu-prob-value ' + (probB == null ? '' : probB >= 50 ? 'favored' : 'underdog') + '">' + (probB == null ? '—' : probB + '%') + '</span></div>' +
        '<div class="mu-prob-label">WIN PROBABILITY</div></div>' +
      '<details class="mu-rosters"><summary><span>SHOW LINEUPS</span><span class="mu-expand-mark">+</span></summary>' +
        '<div class="mu-roster-grid">' + rosterMarkup(game.teamA,game.a,false) + rosterMarkup(game.teamB,game.b,false) + '</div>' +
        '<details class="mu-bench-details"><summary><span>SHOW BENCH</span><span class="mu-expand-mark">+</span></summary>' +
          '<div class="mu-roster-grid">' + rosterMarkup(game.teamA,game.a,true) + rosterMarkup(game.teamB,game.b,true) + '</div>' +
        '</details>' +
      '</details>' +
    '</article>';
  });
  target.innerHTML = cards.join("");
  if (!data.loaded && !data.loading) loadMatchupWeekData(week);
}


function renderScheduleComparison(){
 const target=$("pp-schedule-comparison");if(!target)return;
 if(!state.teams?.size){
  target.innerHTML='<div class="pp-loading">Loading league matchup data…</div>';
  if(target.dataset.waitingForCore!=="yes"){
   target.dataset.waitingForCore="yes";
   sleeperCoreReady.then(ready=>{
    delete target.dataset.waitingForCore;
    if(ready)renderScheduleComparison();
    else target.innerHTML='<div class="pp-error">League data could not be loaded, so Schedule Comparison is unavailable. Please refresh and try again.</div>';
   });
  }
  return;
 }
 const includeMedian=$("pp-include-median")?.checked!==false;
 const baseTeams=[...state.teams.values()];
 let standingsWeeks=0;
 const regularWeeks=Math.max(1,(num(state.league?.settings?.playoff_week_start)||15)-1);
 for(let w=1;w<=regularWeeks;w++){const rows=state.weeks[w]||[];if(rows.length>=baseTeams.length&&rows.filter(m=>num(m.points)>0).length===baseTeams.length)standingsWeeks=w;}
 const standings=playoffActual(baseTeams,standingsWeeks);
 const standingsById=new Map(standings.map(t=>[t.id,t]));
 const teams=baseTeams.sort((a,b)=>{const x=standingsById.get(a.id)||{},y=standingsById.get(b.id)||{};return (y.w-x.w)||(y.pf-x.pf)||a.name.localeCompare(b.name);});
 const records=new Map(teams.map(t=>[t.id,new Map(teams.map(s=>[s.id,{w:0,l:0,t:0}]))]));
 const regular=Math.max(1,(num(state.league?.settings?.playoff_week_start)||15)-1),completedWeeks=[];
 for(let week=1;week<=regular;week++){
  // Reuse the exact matchup pairing and winner logic used by the Power Rankings bars.
  const matchupResults=calculateWeek(week).results;
  if(matchupResults.length!==teams.length/2)continue;
  const scoreById=new Map(),opponentById=new Map();
  for(const matchup of matchupResults){
   const aId=Number(matchup.a.id),bId=Number(matchup.b.id);
   if(scoreById.has(aId)||scoreById.has(bId)||opponentById.has(aId)||opponentById.has(bId))continue;
   scoreById.set(aId,matchup.scoreA);scoreById.set(bId,matchup.scoreB);
   opponentById.set(aId,bId);opponentById.set(bId,aId);
  }
  if(scoreById.size!==teams.length||opponentById.size!==teams.length||teams.some(t=>!scoreById.has(t.id)||!opponentById.has(t.id)))continue;
  const rankedScores=[...scoreById.entries()].sort((a,b)=>b[1]-a[1]||a[0]-b[0]);
  const medianWinners=new Set(rankedScores.slice(0,Math.floor(teams.length/2)).map(([id])=>id));
  completedWeeks.push({scoreById,opponentById,medianWinners});
 }
 for(const week of completedWeeks)for(const rowTeam of teams){
  const score=week.scoreById.get(rowTeam.id),medianResult=week.medianWinners.has(rowTeam.id)?1:-1;
  for(const scheduleTeam of teams){
   // If the row manager and schedule owner actually played each other,
   // preserve that real matchup instead of assigning the row manager as their own opponent.
   const scheduleOpponentId=week.opponentById.get(scheduleTeam.id);
   const opponentId=scheduleOpponentId===rowTeam.id?scheduleTeam.id:scheduleOpponentId;
   const opponentScore=week.scoreById.get(opponentId),r=records.get(rowTeam.id).get(scheduleTeam.id);
   if(!Number.isFinite(score)||!Number.isFinite(opponentScore))continue;
   if(score>opponentScore)r.w++;else if(score<opponentScore)r.l++;else if(score===opponentScore)r.t++;
   if(includeMedian){if(medianResult>0)r.w++;else r.l++;}
  }
 }
 const fmtRecord=r=>r.w+"–"+r.l+(r.t?"–"+r.t:""),totalGames=completedWeeks.length*(includeMedian?2:1);
 const table='<div class="pp-table-wrap pp-schedule-matrix-wrap"><table class="pp-table pp-schedule-matrix"><thead><tr><th class="pp-matrix-corner">TEAM<br>↓ / SCHEDULE →</th>'+teams.map(t=>'<th title="'+escapeHtml(t.name)+'">'+escapeHtml(t.name)+'</th>').join("")+'</tr></thead><tbody>'+
 teams.map(row=>{const actual=records.get(row.id).get(row.id),actualPoints=actual.w+.5*actual.t;return '<tr><th scope="row">'+escapeHtml(row.name)+'</th>'+teams.map(col=>{const r=records.get(row.id).get(col.id),points=r.w+.5*r.t,cls=row.id===col.id?"pp-matrix-diagonal":points>actualPoints?"pp-matrix-better":points<actualPoints?"pp-matrix-worse":"";return '<td class="'+cls+'" title="'+escapeHtml(row.name)+' with '+escapeHtml(col.name)+' schedule: '+fmtRecord(r)+'; actual: '+fmtRecord(actual)+'">'+fmtRecord(r)+'</td>';}).join("")+'</tr>';}).join("")+
 '</tbody></table></div>';
 target.innerHTML='<div class="pp-meta"><span>'+completedWeeks.length+' COMPLETED WEEKS</span><span>'+(includeMedian?'HEAD-TO-HEAD + MEDIAN':'HEAD-TO-HEAD ONLY')+'</span><span>'+totalGames+' RESULTS PER CELL</span></div>'+
 (completedWeeks.length?table:'<div class="pp-loading">No completed regular-season weeks are available yet.</div>')+
 '<p class="pp-explainer">Rows keep that manager’s actual weekly scores; columns apply that manager’s actual head-to-head opponents. Each cell shows the row manager’s recalculated record against the column manager’s schedule. The diagonal is each manager’s actual record. League-median results are based on the row manager’s own weekly scores and do not change with the head-to-head schedule.</p>';
}
async function loadPlayoffEditions(){
 const target=$("playoff-predictor-content"),select=$("playoff-edition-select");
 if(!target||target.dataset.loading==="yes")return;
 target.dataset.loading="yes";target.innerHTML='<div class="pp-loading">LOADING PUBLISHED PLAYOFF EDITIONS…</div>';
 try{
  const response=await fetch("data/playoff-editions/index.json",{cache:"no-store"});
  if(!response.ok)throw new Error("Published edition index is not available yet.");
  const index=await response.json(),editions=(index.editions||[]).slice().sort((a,b)=>Number(b.week)-Number(a.week));
  if(!editions.length){target.innerHTML='<div class="pp-loading">THE FIRST SHARED EDITION WILL APPEAR AFTER A FULL FANTASY WEEK IS COMPLETE.</div>';target.dataset.ready="no";return;}
  if(select){select.innerHTML=editions.map(e=>'<option value="'+Number(e.week)+'">Week '+String(e.week).padStart(2,"0")+'</option>').join("");select.value=String(editions[0].week);if(!select.dataset.bound){select.addEventListener("change",()=>showPlayoffEdition(Number(select.value),editions));select.dataset.bound="yes";}}
  await showPlayoffEdition(Number(editions[0].week),editions);
  sleeperCoreReady.then(()=>renderScheduleComparison());
 }catch(error){target.innerHTML='<div class="pp-error">Shared playoff predictions are not available yet: '+escapeHtml(error?.message||"Unknown error")+'</div>';target.dataset.ready="no";}
 finally{target.dataset.loading="no";}
}
async function showPlayoffEdition(week,editions){
 const target=$("playoff-predictor-content");if(!target)return;
 try{
  const editionInfo=editions.find(e=>Number(e.week)===week);if(!editionInfo)throw new Error("That edition could not be found.");
  target.innerHTML='<div class="pp-loading">LOADING WEEK '+week+' EDITION…</div>';
  const response=await fetch("data/playoff-editions/"+encodeURIComponent(editionInfo.file),{cache:"no-store"});if(!response.ok)throw new Error("The saved Week "+week+" edition could not be loaded.");
  const edition=await response.json(),results=edition.results||[];if(results.length!==12)throw new Error("The saved edition is incomplete.");
  const published=new Date(edition.publishedAt),dateLabel=Number.isNaN(published.getTime())?"":published.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});
  target.innerHTML='<div class="pp-meta"><span>'+Number(edition.simulations).toLocaleString()+' SIMULATIONS</span><span>DATA THROUGH WEEK '+edition.week+'</span><span>'+dateLabel.toUpperCase()+'</span></div>'+
   '<div class="pp-table-wrap"><table class="pp-table"><thead><tr><th>MANAGER</th><th>PLAYOFF ODDS</th><th>BYE WEEK ODDS</th><th>LAST PLACE ODDS</th><th>PROJECTED RECORD</th><th>PROJECTED PF</th><th>MOST LIKELY SEED</th></tr></thead><tbody>'+
   results.map((r,i)=>'<tr class="'+(i===5?"pp-cutoff":"")+'"><td><span class="pp-manager-rank">'+String(i+1).padStart(2,"0")+'</span><strong>'+escapeHtml(r.manager)+'</strong>'+((r.firstPlaceClinched)?'<span class="pp-status-tag first">1ST PLACE CLINCHED</span>':(r.byeClinched)?'<span class="pp-status-tag bye">BYE CLINCHED</span>':(r.playoffsClinched)?'<span class="pp-status-tag clinched">PLAYOFFS CLINCHED</span>':(r.mathematicallyEliminated||r.eliminated)?'<span class="pp-status-tag eliminated">ELIMINATED</span>':'')+'</td><td><div class="pp-odds-cell"><strong>'+(r.eliminated?"0.0%":r.odds<0.1?"<0.1%":r.odds>=99.95&&!r.playoffsClinched?"99.9%":r.odds.toFixed(1)+"%")+'</strong><span class="pp-odds-track"><i style="width:'+Math.max(0,Math.min(100,r.odds))+'%"></i></span></div></td><td><div class="pp-odds-cell"><strong>'+(r.byeOdds>0&&r.byeOdds<0.1?"<0.1%":r.byeOdds>=99.95&&!r.byeClinched?"99.9%":r.byeOdds.toFixed(1)+"%")+'</strong><span class="pp-odds-track"><i style="width:'+Math.max(0,Math.min(100,r.byeOdds))+'%"></i></span></div></td><td><div class="pp-odds-cell"><strong>'+(r.lastPlaceOdds==null?"—":r.lastPlaceOdds>0&&r.lastPlaceOdds<0.1?"<0.1%":r.lastPlaceOdds.toFixed(1)+"%")+'</strong>'+(r.lastPlaceOdds==null?'':'<span class="pp-odds-track pp-last-place"><i style="width:'+Math.max(0,Math.min(100,r.lastPlaceOdds))+'%"></i></span>')+'</div></td><td class="pp-number">'+escapeHtml(r.record)+'</td><td class="pp-number">'+Number(r.pf).toFixed(1)+'</td><td><strong>#'+r.seed+'</strong><small class="pp-seed-note">'+Number(r.seedPct).toFixed(1)+'% of sims</small></td></tr>').join("")+
   '</tbody></table></div><p class="pp-explainer">Each saved edition runs 100,000 simulations of every remaining regular-season week, including a head-to-head result and a league-median result. Final standings are ordered by wins, then Points For. The top six qualify; the top two seeds receive a first-round bye. Future scoring is based on Sleeper projections with a 20-point standard deviation. Everyone sees the same published results until the next complete fantasy week is published.</p><p class="pp-footnote">This is an archived snapshot. It does not recalculate when you visit the page or when rosters and projections change. Earlier editions remain available in the edition selector.</p>';
 target.dataset.ready="yes";
 }catch(error){target.innerHTML='<div class="pp-error">The saved prediction edition could not be displayed: '+escapeHtml(error?.message||"Unknown error")+'</div>';target.dataset.ready="no";}
}
let selectedScheduleTeam = null;
function renderSchedule() {
  const pickTarget = $("schedule-team-picks");
  const contentTarget = $("schedule-content");
  if (!pickTarget || !contentTarget || !state.teams?.size) return;

  const teams = [...state.teams.values()].sort((a,b)=>a.name.localeCompare(b.name));
  const season = state.league?.season || new Date().getFullYear();
  const seasonLabel = $("schedule-season");
  if (seasonLabel) seasonLabel.textContent = season;

  const teamColor = team => lotteryColor(team.name);
  pickTarget.innerHTML = teams.map(team => {
    const color = teamColor(team);
    const active = selectedScheduleTeam === team.name;
    return '<button type="button" class="sch-pick '+(active?'active':'')+'" data-schedule-team="'+escapeHtml(team.name)+'" aria-pressed="'+(active?'true':'false')+'" style="color:'+color+'">'+escapeHtml(team.name)+'</button>';
  }).join("");

  const cards = [];
  for (let week=1; week<=14; week++) {
    const source = state.weeks[week] || [];
    const groups = new Map();
    source.forEach(match => {
      if (match.matchup_id == null) return;
      const id = String(match.matchup_id);
      if (!groups.has(id)) groups.set(id,[]);
      groups.get(id).push(match);
    });
    const games = [...groups.values()].filter(group=>group.length===2).map(group=>{
      const a=teamFor(group[0].roster_id), b=teamFor(group[1].roster_id);
      return a&&b?{a,b}:null;
    }).filter(Boolean);
    const rematch = week>=12;
    const rows = games.map(game=>{
      const aSelected = game.a.name===selectedScheduleTeam;
      const bSelected = game.b.name===selectedScheduleTeam;
      return '<div class="sch-game '+(selectedScheduleTeam?(aSelected||bSelected?'on':'off'):'')+'" data-a="'+escapeHtml(game.a.name)+'" data-b="'+escapeHtml(game.b.name)+'">'+
        '<span class="sch-nm '+(aSelected?'selected':'')+'" data-name="'+escapeHtml(game.a.name)+'">'+escapeHtml(game.a.name)+'</span>'+
        '<span class="vs">vs</span>'+
        '<span class="sch-nm '+(bSelected?'selected':'')+'" data-name="'+escapeHtml(game.b.name)+'">'+escapeHtml(game.b.name)+'</span>'+
      '</div>';
    }).join("");
    const empty = state.failedWeeks.includes(week) ? "Sleeper schedule data is unavailable for this week." : "Matchups have not been posted by Sleeper yet.";
    const tag = rematch ? "Regular Season Rematch" : "Regular Season";
    cards.push('<article class="sch-wk'+(rematch?' rematchwk':'')+'">'+
      '<div class="sch-wk-hd"><span class="sch-wk-n">Week '+week+'</span><span class="sch-wk-tag '+(rematch?'rematch':'regular')+'">'+tag+'</span></div>'+
      '<div class="sch-games">'+(rows||'<p class="sch-empty">'+empty+'</p>')+'</div>'+
    '</article>');
  }
  contentTarget.classList.toggle("has-selection",!!selectedScheduleTeam);
  contentTarget.innerHTML = cards.join("");
  const playoffBracketTarget=$("schedule-playoff-bracket");
  if(playoffBracketTarget)playoffBracketTarget.innerHTML=hallPlayoffTemplateMarkup();
  pickTarget.querySelectorAll("[data-schedule-team]").forEach(button=>button.addEventListener("click",()=>{
    selectedScheduleTeam=selectedScheduleTeam===button.dataset.scheduleTeam?null:button.dataset.scheduleTeam;
    renderSchedule();
  }));
}
function renderEditorial(week, rankings) {
  const scores=(state.weeks[week]||[]).filter(m=>num(m.points)>0).sort((a,b)=>num(b.points)-num(a.points));
  const chart=$("weekly-chart-bars");
  if(chart) chart.innerHTML=scores.map(m=>{
    const t=teamFor(m.roster_id), pct=Math.max(5,Math.round(num(m.points)/(num(scores[0]&&scores[0].points)||1)*100));
    return '<div class="chart-bar-item" title="'+teamName(t)+': '+fmt(m.points)+'"><span class="chart-bar-value">'+fmt(m.points)+'</span><div class="chart-bar" style="height:'+pct+'px"></div><span class="chart-bar-label">'+escapeHtml(t&&t.owner||"")+'</span></div>';
  }).join("");
  const notes=$("team-notes");
  if(notes) notes.innerHTML=rankings.map((t,i)=>{
    const movement=t.move>0?"up "+t.move+" place"+(t.move===1?"":"s"):t.move<0?"down "+Math.abs(t.move)+" place"+(t.move===-1?"":"s"):"holding position";
    const score=t.scores&&t.scores.length?t.scores[t.scores.length-1].score:0;
    const sentence=score?"Scored "+fmt(score)+" this week and is "+movement+" in the Power Index. The season profile currently shows "+t.record+" with "+fmt(t.pf)+" points for.":"No completed scoring data is available yet. The team is currently "+movement+" in the Power Index.";
    return '<article class="team-note"><div class="team-note-head"><strong>'+String(i+1).padStart(2,"0")+' — '+teamName(t)+'</strong><span>'+Math.round(t.power)+' POWER</span></div><p>'+sentence+'</p></article>';
  }).join("");
}
function renderRules() {
  const target=$("rules-content");
  if(!target||target.dataset.ready==="yes") return;
  const sections=[
    {id:"rules-league",title:"League policies",body:'<div class="rules-vote-visual"><div class="rules-vote-card"><span>STANDARD RULE CHANGES</span><strong>7 / 12</strong><b>VOTES REQUIRED</b><small>More than 50% in favor</small><div class="rules-vote-dots"><i class="yes"></i><i class="yes"></i><i class="yes"></i><i class="yes"></i><i class="yes"></i><i class="yes"></i><i class="yes"></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></div></div><div class="rules-vote-card special"><span>BUY-IN &amp; PAYOUT CHANGES</span><strong>9 / 12</strong><b>VOTES REQUIRED</b><small>More than two-thirds in favor</small><div class="rules-vote-dots"><i class="yes"></i><i class="yes"></i><i class="yes"></i><i class="yes"></i><i class="yes"></i><i class="yes"></i><i class="yes"></i><i class="yes"></i><i class="yes"></i><i class=""></i><i class=""></i><i class=""></i></div></div></div><h3>Rule changes</h3><ul><li>All league rules are open to be changed from the end of the fantasy football season until draft night of the following fantasy football season.</li><li>If a league member proposes a new rule, a Sleeper poll will be created to cast votes for the proposal. A simple majority (&gt;50%) of league members must vote in favor of a proposed change for it to occur.</li><li>Exception for rules related to buy in or payout, where a supermajority (&gt;2/3) of league members must vote in favor of a proposed change for it to occur.</li></ul><h3>Buy in</h3><ul><li>$50 per person</li><li>Must be paid to league commissioner by draft day</li></ul><h3>Last place punishment</h3><ul><li>Last place punishment for the season will be agreed upon by all league mates prior to the draft</li><li>The team that finishes last place in the regular season is considered last place</li><li>Punishment must be completed prior to the next season’s draft lottery date. If it is not, that league mate will automatically be assigned last position in the draft lottery AND forfeit their first round draft pick</li></ul>'},
    {id:"rules-draft",title:"Draft",body:'<div class="rules-draft-visual"><div class="rules-visual-title">SNAKE DRAFT <span>12 TEAMS · 1.5 MIN / PICK</span></div><div class="rules-draft-round"><b>ROUND 1 →</b><div class="rules-draft-picks"><i>1</i><i>2</i><i>3</i><i>4</i><i>5</i><i>6</i><i>7</i><i>8</i><i>9</i><i>10</i><i>11</i><i>12</i></div></div><div class="rules-draft-round reverse"><b>← ROUND 2</b><div class="rules-draft-picks"><i>12</i><i>11</i><i>10</i><i>9</i><i>8</i><i>7</i><i>6</i><i>5</i><i>4</i><i>3</i><i>2</i><i>1</i></div></div><div class="rules-draft-round"><b>ROUND 3 →</b><div class="rules-draft-picks"><i>1</i><i>2</i><i>3</i><i>4</i><i>5</i><i>6</i><i>7</i><i>8</i><i>9</i><i>10</i><i>11</i><i>12</i></div></div></div><ul><li>Draft start time: TBD by league determination</li><li>Autostart draft: Enabled</li><li>Available players to draft: All players</li><li>CPU Autopick: Enabled</li></ul><h3>Draft order determination</h3><p>A computer-generated duck race determines the order in which league members select their draft position. Starting approximately two weeks before draft day, managers select their draft spot in that order, with each league member receiving approximately one day to make their decision.</p>'},
    {id:"rules-lineup",title:"Lineup",body:'<div class="rules-visual rules-roster-visual"><div class="rules-visual-title">STARTING LINEUP <span>8 SLOTS</span></div><div class="rules-slot-grid"><span>QB <b>1</b></span><span>RB <b>2</b></span><span>WR <b>2</b></span><span>TE <b>1</b></span><span>FLEX <b>1</b></span><span>SUPERFLEX <b>1</b></span></div><div class="rules-depth"><span>BENCH <b>6</b></span><span>INJURED RESERVE <b>2</b></span></div></div><h3>Lineup lock</h3><p>Players lock individually when their game kicks off. A player whose game has started cannot be moved into or out of your lineup; players whose games have not yet started remain free to swap.</p><h3>You set your own lineup</h3><p>Each manager is solely responsible for setting a valid, active lineup every week. The Commissioner does not set, fix, adjust, or retroactively change any manager’s lineup — not for a forgotten start, a player left in on a bye, an injury, or a late inactive. Empty or invalid starting slots score zero, and there are no makeups. Aside from the lock rule above, managers are free to set their lineups however they wish.</p><h3>Player AutoSubs</h3><p>Each team may designate one AutoSub per week. If a starter is ruled inactive before kickoff, the designated substitute automatically moves into the lineup. If the starter is active and plays, the substitute does not replace them. The substitute must be eligible for the starter’s lineup position and must have a game scheduled to start at the same time as or after the starter’s game. Both players must be unstarted when the pairing is set, and the pairing locks as soon as either player’s game kicks off. AutoSubs are configured in the Sleeper mobile app.</p><p class="rules-source-note">See <a href="https://support.sleeper.com/en/articles/9731991-how-does-player-autosubs-work" target="_blank" rel="noopener">Sleeper’s AutoSubs guide</a> for the feature details.</p><h3>Injured reserve eligibility</h3><p>Players eligible for injured reserve include IR, PUP, and OUT. The following statuses are ineligible: Suspended, NA, DNR/Holdout, and Doubtful.</p>'},
    {id:"rules-scoring",title:"Scoring",body:'<div class="rules-scoring-board"><div class="rules-scoring-card"><header><b>PASSING</b></header><div><strong>.04</strong><small>per passing yard</small></div><div><strong>4</strong><small>passing TD</small></div><div><strong>2</strong><small>2-pt conversion</small></div><div class="negative"><strong>−2</strong><small>interception</small></div></div><div class="rules-scoring-card"><header><b>RUSHING</b></header><div><strong>.1</strong><small>per rushing yard</small></div><div><strong>6</strong><small>rushing TD</small></div><div><strong>2</strong><small>2-pt conversion</small></div></div><div class="rules-scoring-card"><header><b>RECEIVING</b></header><div><strong>.5</strong><small>per reception</small></div><div><strong>.1</strong><small>per receiving yard</small></div><div><strong>6</strong><small>receiving TD</small></div><div><strong>2</strong><small>2-pt conversion</small></div></div><div class="rules-scoring-card"><header><b>KICKING</b></header><div><strong>3</strong><small>field goal made</small></div><div><strong>1</strong><small>PAT made</small></div></div><div class="rules-scoring-card"><header><b>MISCELLANEOUS</b></header><div class="negative"><strong>−2</strong><small>fumble lost</small></div><div><strong>6</strong><small>fumble recovery TD</small></div></div></div>'},
    {id:"rules-matchup-format",title:"Weekly Matchup Format",body:'<div class="rules-median-visual"><div><span>HEAD-TO-HEAD</span><strong>1</strong><small>possible win</small></div><b>+</b><div><span>LEAGUE MEDIAN</span><strong>1</strong><small>possible win</small></div><b>=</b><div><span>WEEKLY RECORD</span><strong>2–0</strong><small>or 1–1 / 0–2</small></div></div><p>Every team plays its scheduled head-to-head opponent and an extra game against the league median each week. A team can earn two wins, two losses, or split the week with one win and one loss. Head-to-head matchups can also end in a tie; league-median matchups cannot.</p>'},
    {id:"rules-waivers",title:"Waivers & Free Agency",body:'<div class="rules-faab-visual"><div class="rules-faab-bank"><span>STARTING FAAB</span><strong>$100</strong><small>Per team · per season</small></div><div class="rules-faab-flow"><div><b>01</b><strong>SUBMIT BID</strong><small>Blind bidding</small></div><i>→</i><div><b>02</b><strong>3 AM ET</strong><small>Wed–Sat processing</small></div><i>→</i><div><b>03</b><strong>HIGHEST BID</strong><small>Wins the player</small></div></div><div class="rules-faab-foot"><span>$0 bids allowed</span><span>FAAB can be traded</span><span>Budget is finite</span></div></div><h3>What is FAAB?</h3><p>FAAB (Free Agent Acquisition Budget) gives each team a set budget to bid on free agents throughout the season using a blind bidding system. When waivers process, the team with the highest bid wins the player. Other managers cannot see your bid before it processes.</p><p>Each team starts the season with $100 in FAAB. A $0 bid is allowed and wins if no other bids are made, or if the only other bids are also $0 and your waiver priority wins the tiebreaker. FAAB may also be included in trades.</p><p class="rules-source-note">For more detail, see <a href="https://support.sleeper.com/en/articles/1876040-how-does-faab-bidding-work" target="_blank" rel="noopener">Sleeper’s guide to FAAB bidding</a>.</p><h3>Adding Players</h3><p>At any moment, an un-rostered player is in one of two states:</p><ul><li><strong>On waivers —</strong> submit a blind FAAB bid. Claims are awarded when waivers process, with the highest bid winning.</li><li><strong>Free agent —</strong> first-come, first-served. Add an eligible player instantly without a bid. This is open on Sundays and Mondays. Tuesday is locked.</li></ul><div class="rules-visual rules-waiver-visual"><div class="rules-visual-title">WEEKLY WAIVER CYCLE <span>LEAGUE SETTINGS</span></div><div class="rules-week-grid"><div class="free"><b>MON</b><span class="rules-day-icon" aria-hidden="true">⚡</span><strong>FREE AGENTS</strong></div><div class="locked"><b>TUE</b><span class="rules-day-icon" aria-hidden="true">🔒</span><strong>LOCKED</strong></div><div class="waiver"><b>WED</b><span class="rules-day-icon" aria-hidden="true">💵</span><strong>WAIVERS</strong></div><div class="waiver"><b>THU</b><span class="rules-day-icon" aria-hidden="true">💵</span><strong>WAIVERS</strong></div><div class="waiver"><b>FRI</b><span class="rules-day-icon" aria-hidden="true">💵</span><strong>WAIVERS</strong></div><div class="waiver"><b>SAT</b><span class="rules-day-icon" aria-hidden="true">💵</span><strong>WAIVERS</strong></div><div class="free"><b>SUN</b><span class="rules-day-icon" aria-hidden="true">⚡</span><strong>FREE AGENTS</strong></div></div><p class="rules-chart-caption">Waivers process at 3 AM Eastern, Wednesday through Saturday.</p></div><h3>Players after kickoff</h3><p>Any player who appears in a game stays on waivers until the next scheduled waiver processing period. Under our league settings, waivers clear Wednesday at 3 AM Eastern.</p><h3>Dropped players</h3><p>A player you drop stays on waivers for 1 day before he can become a free agent. This prevents dropping a player and instantly re-adding him to dodge a bid. He is biddable during that window, then opens up.</p><p><strong>Bench-player drop setting:</strong> Prevent bench players from being dropped after their game starts is Off. Bench players can be dropped even after their game has started.</p><h3>Tied Bids</h3><p>If two teams bid the same amount on a player, the tie goes to the team with the better waiver order that week. Winning any claim sends you to the back of the waiver order, so priority constantly rotates. Sleeper handles this automatically.</p><h3>$0 bids</h3><p>You may bid $0. A $0 bid wins if no one else bids on that player, or if another $0 bid loses the tiebreaker to a team with better waiver priority. Once a player is a Sunday or Monday free agent, no bid is needed.</p><h3>FAAB in trades</h3><p>FAAB may be included in trades and does not have to be balanced (see the Trades section). You can effectively buy or sell budget FAAB via trades.</p><h3>The TNF Limitation</h3><p>Because players who play midweek during Thursday, Friday, or Saturday games are on waivers rather than instant free agency, you cannot add and start a player for a Thursday night game if you place your bid that same Thursday. Plan that add ahead and place your bid on Wednesday so the player is added when waivers run at 3 AM Eastern Thursday morning.</p>'},
    {id:"rules-trades",title:"Trades",body:'<div class="rules-trade-flow"><div><span>01</span><strong>TRADE ACCEPTED</strong><small>Both managers agree in Sleeper</small></div><i>→</i><div><span>02</span><strong>PROCESSES INSTANTLY</strong><small>No routine review or veto period</small></div><i>→</i><div><span>03</span><strong>FINAL &amp; AS-IS</strong><small>Not reversed for injury or performance</small></div></div><div class="rules-collusion-note"><b>ONLY EXCEPTION</b><span>Commissioner veto is reserved for clear collusion — a deal with no legitimate competitive purpose.</span></div><h3>Commissioner oversight &amp; collusion</h3><p>Trades process instantly in Sleeper once accepted. There is no routine commissioner review or veto period. The Commissioner may veto a trade only if the league identifies clear collusion.</p><p>Collusion means an agreement with no legitimate competitive purpose for one side, intended to funnel value to another team without a genuine exchange. A lopsided or objectively bad trade is not, by itself, collusion.</p><h3>Player trades</h3><ul><li><strong>Use Sleeper when possible.</strong> Trades should be entered and processed in Sleeper whenever the platform can represent the agreed exchange, including players and FAAB.</li><li><strong>League-approved exception.</strong> The league may agree to trade conditions or considerations that Sleeper cannot represent. For example, a manager may trade a player in exchange for another manager agreeing not to bid on a particular player on waivers. Any such condition must be clearly agreed to by everyone involved.</li><li><strong>No temporary trades or rentals.</strong> You may not trade a player under an arrangement to return that player afterward.</li><li><strong>Trades are final and as-is.</strong> Once processed, a trade cannot be reversed because of injury, suspension, or underperformance. You trade a player’s future, risk included.</li><li><strong>Roster and FAAB legality.</strong> A trade cannot leave a team over the roster limit or with negative FAAB. The receiving team must clear roster room for the trade to process and cannot include FAAB it does not have.</li></ul><h3>Trade eligibility</h3><p>There is no official trade deadline. However, once a team is eliminated from playoff contention, it may trade only with other teams that are also eliminated. Eliminated teams may continue trading with one another, including to improve their chances of avoiding the last-place punishment.</p>'},
    {id:"rules-playoffs",title:"Playoffs",body:'<div class="rules-playoff-bracket"><div id="rules-playoff-bracket"></div><div class="playoff-payout-legend"><span>REGULAR-SEASON WINNER <b>$120</b></span><span>CHAMPION <b>$300</b></span><span>RUNNER-UP <b>$180</b></span></div></div>'},
  ];
  const nav=sections.map(section=>'<a href="#'+section.id+'">'+section.title+'</a>').join("");
  const content=sections.map((section,index)=>'<section class="rules-section" id="'+section.id+'"><div class="rules-section-head"><span class="rules-index">'+String(index+1).padStart(2,"0")+'</span><h3>'+section.title+'</h3></div><div class="rules-section-body">'+section.body+'</div></section>').join("");
  target.innerHTML='<div class="rules-layout"><aside class="rules-toc"><div class="rules-toc-title">ON THIS PAGE</div>'+nav+'</aside><div class="rules-article">'+content+'</div></div>';
  const playoffBracketTarget=$("rules-playoff-bracket");
  if(playoffBracketTarget)playoffBracketTarget.innerHTML=hallPlayoffTemplateMarkup();
  target.dataset.ready="yes";
  const links=[...target.querySelectorAll(".rules-toc a")],sectionsEls=[...target.querySelectorAll(".rules-section")];
  links.forEach(link=>link.addEventListener("click",()=>links.forEach(item=>item.classList.toggle("active",item===link))));
  if("IntersectionObserver" in window){const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){const active=links.find(link=>link.getAttribute("href")==="#"+entry.target.id);if(active)links.forEach(link=>link.classList.toggle("active",link===active));}}),{rootMargin:"-18% 0px -68% 0px"});sectionsEls.forEach(section=>observer.observe(section));}
}

const LOTTERY_HISTORY = {
  2021: ["Tanz","Kev","Colb","Lee","Ben","Joey","Evan","Butta","Pat","Marc"],
  2022: ["Schmeef","Ben","Pat","Butta","Lee","Marc","Colb","Ders","Evan","Tanz","Kev","Joey"],
  2023: ["Kev","Marc","Tanz","Pat","Schmeef","Ders","Ben","Lee","Evan","Colb","Joey","Butta"],
  2024: ["Butta","Ders","Evan","Kev","Marc","Colb","Ben","Tanz","Joey","Pat","Lee","Schmeef"],
  2025: ["Marc","Butta","Colb","Brandon","Tanz","Pat","Kev","Evan","Joey","Ders","Ben","Lee"],
  2026: ["Pat","Evan","Ben","Lee","Ders","Marc","Brandon","Tanz","Colb","Butta","Joey","Kev"]
};
const LOTTERY_NAMES = { Kev:"Kevin", Colb:"Colby" };
function lotteryName(name) { return LOTTERY_NAMES[name] || name; }
function lotteryLuck(position, fieldSize) { const expectedPosition = fieldSize / 2 + 0.5; return expectedPosition - position; }
const LOTTERY_MANAGER_COLORS = ["#20b9d7","#ff4f91","#9a68ff","#e8b83d","#50c99a","#f0784f","#b5a0ff","#5dc4ee","#e47eb4","#a7d86c","#f1a34c","#8d9cf5"];
function lotteryColor(name) {
  const names = [...new Set(Object.values(LOTTERY_HISTORY).flat().map(lotteryName))].sort();
  return LOTTERY_MANAGER_COLORS[Math.max(0,names.indexOf(lotteryName(name))) % LOTTERY_MANAGER_COLORS.length];
}
function renderLotteryHistory() {
  const years=Object.keys(LOTTERY_HISTORY).map(Number).sort((a,b)=>b-a);
  const current=LOTTERY_HISTORY[2026];
  const draftSlots=state.actualDraftSlots || new Map();
  const fieldSize=current.length;
  const currentRows=current.map((name,index)=>{
    const manager=lotteryName(name);
    const luck=lotteryLuck(index+1,fieldSize);
    const slot=draftSlots.get(manager);
    const luckClass=luck>0?"up":luck<0?"dn":"even";
    const luckLabel=luck>0?"▲ "+luck.toFixed(1):luck<0?"▼ "+Math.abs(luck).toFixed(1):"—";
    return '<div class="ds-row"><span class="ds-pk">'+String(index+1)+'</span><span class="ds-tm"><span class="ds-dot" style="background:'+lotteryColor(manager)+'"></span><span style="color:'+lotteryColor(manager)+'">'+escapeHtml(manager)+'</span></span><span class="ds-mv '+luckClass+'">'+luckLabel+'</span><span class="ds-slot"><span class="pill">'+(slot?'#'+slot:'—')+'</span></span></div>';
  }).join("");
  $("lottery-current-results").innerHTML=currentRows;

  const totals=new Map();
  for(const [year,draw] of Object.entries(LOTTERY_HISTORY)){
    draw.forEach((name,index)=>{
      const manager=lotteryName(name);
      // Schmeef remains in the historical results but is excluded
      // from the current league's luck leaderboard.
      if(manager==="Schmeef") return;
      const entry=totals.get(manager)||{name:manager,years:0,luck:0};
      entry.years++;
      entry.luck+=lotteryLuck(index+1,draw.length);
      totals.set(manager,entry);
    });
  }
  const leaderboard=[...totals.values()].sort((a,b)=>b.luck-a.luck||a.name.localeCompare(b.name));
  const maxAbs=Math.max(1,...leaderboard.map(entry=>Math.abs(entry.luck)));
  $("lottery-luck-list").innerHTML=leaderboard.map(entry=>{
    const luckClass=entry.luck>0?"up":entry.luck<0?"dn":"even";
    const width=Math.abs(entry.luck)/maxAbs*46;
    const fill=entry.luck>0
      ? '<span class="ls-fill up" style="left:50%;width:'+width+'%"></span>'
      : entry.luck<0
        ? '<span class="ls-fill dn" style="right:50%;width:'+width+'%"></span>'
        : '';
    return '<div class="ls-luck"><span class="ls-lnm" style="color:'+lotteryColor(entry.name)+'">'+escapeHtml(entry.name)+'</span><span class="ls-track"><span class="ls-axis"></span>'+fill+'</span><span class="ls-lval '+luckClass+'">'+(entry.luck>0?'+':'')+entry.luck.toFixed(1)+'</span></div>';
  }).join("");

  $("lottery-history").innerHTML=years.map(year=>{
    const draw=LOTTERY_HISTORY[year];
    return '<article class="lottery-year-card"><div class="lottery-year-heading"><strong>'+year+'</strong><span>'+draw.length+' MANAGERS</span></div>'+draw.map((name,index)=>{
      const luck=lotteryLuck(index+1,draw.length);
      return '<div class="lottery-history-row"><span>'+String(index+1).padStart(2,"0")+'</span><strong>'+escapeHtml(lotteryName(name))+'</strong><small class="'+(luck>0?'luck-positive':luck<0?'luck-negative':'')+'">'+(luck>0?'+':'')+luck.toFixed(1)+'</small></div>';
    }).join("")+'</article>';
  }).join("");
}
async function loadActualDraftOrder() {
  const target=$("actual-draft-order");
  try {
    const drafts=await fetchJson('/league/'+LEAGUE_ID+'/drafts');
    if(!Array.isArray(drafts)||!drafts.length) throw new Error("No Sleeper draft found for this league.");
    const draft=[...drafts].sort((a,b)=>Number(b.season||0)-Number(a.season||0))[0];
    state.draftSeason=draft.season||"CURRENT";
    let ordered=[];
    if(draft.draft_order && typeof draft.draft_order==="object"){
      const usersById=new Map(state.users.map(user=>[String(user.user_id),user]));
      ordered=Object.entries(draft.draft_order).map(([userId,slot])=>{
        const user=usersById.get(String(userId));
        const username=String(user?.username||"").toLowerCase();
        const displayName=String(user?.display_name||"").toLowerCase();
        const manager=MANAGERS[username]||MANAGERS[displayName]||user?.display_name||user?.username||"Manager";
        return {slot:Number(slot),manager};
      }).filter(item=>Number.isFinite(item.slot)).sort((a,b)=>a.slot-b.slot);
    }
    if(!ordered.length && draft.slot_to_roster_id){
      ordered=Object.entries(draft.slot_to_roster_id).map(([slot,rosterId])=>({slot:Number(slot),manager:state.teams.get(Number(rosterId))?.name||"Manager"})).sort((a,b)=>a.slot-b.slot);
    }
    if(!ordered.length && draft.draft_id){
      const picks=await fetchJson('/draft/'+draft.draft_id+'/picks');
      const firstRound=picks.filter(p=>Number(p.round)===1).sort((a,b)=>Number(a.pick_no)-Number(b.pick_no));
      ordered=firstRound.map((pick,index)=>({slot:index+1,manager:state.teams.get(Number(pick.roster_id))?.name||"Manager"}));
    }
    if(!ordered.length) throw new Error("Sleeper did not return a draft-slot order.");
    state.actualDraftSlots=new Map(ordered.map(item=>[lotteryName(item.manager),item.slot]));
    $("draft-order-season").textContent=String(state.draftSeason)+" SLEEPER DRAFT";
    $("draft-order-count").textContent=ordered.length+" / 12";
    target.innerHTML=ordered.map(item=>'<div class="dob-slot"><span class="dob-n">#'+item.slot+'</span><span class="dob-dot" style="background:'+lotteryColor(item.manager)+'"></span><span class="dob-nm" style="color:'+lotteryColor(item.manager)+'">'+escapeHtml(item.manager)+'</span></div>').join("");
    renderLotteryHistory();
  } catch(error) {
    console.warn("Unable to load Sleeper draft order",error);
    $("draft-order-count").textContent="— / 12";
    target.innerHTML='<div class="lottery-empty">Draft order is not available from Sleeper yet.</div>';
    renderLotteryHistory();
  }
}


const AWARDS_2025=[{"category":"Most Valuable Player","winner":"Trey McBride","detail":"TE1 · 15.2 PPG","nominees":["Trey McBride (TE1, 15.2 PPG)","Christian McCaffrey (RB1, 22.3 PPG)","Josh Allen (QB1, 22.8 PPG)","Puka Nacua (WR1, 19.3 PPG)"]},{"category":"Steal of the Draft","winner":"Matt Stafford","detail":"Drafted 8.01 · QB22 · finished QB3","nominees":["Javonte Williams (drafted 10.05, RB38, finished RB11)","Travis Etienne (drafted 8.07, RB30, finished RB9)","Trey McBride (drafted 4.06, TE2, finished TE1 by >3 PPG)","George Pickens (drafted 7.02, WR27, finished WR4)","Drake Maye (drafted 5.03, QB15, finished QB2)","Matt Stafford (drafted 8.01, QB22, finished QB3)"]},{"category":"Bust of the Draft","winner":"Justin Jefferson","detail":"Drafted 1.10 · WR2 · finished WR28 and WR38 in PPG","nominees":["Lamar Jackson (drafted 1.02, QB2, finished QB20 / QB19 PPG)","Brian Thomas Jr. (drafted 3.01, WR8, finished WR44)","Ladd McConkey (drafted 3.08, WR11, finished WR26)","Justin Jefferson (drafted 1.10, WR2, finished WR28 and WR38 in PPG)"]},{"category":"Waiver Pickup of the Year","winner":"Jacoby Brissett","detail":"QB9 in PPG after becoming the starter in Week 6","nominees":["Jacoby Brissett (QB9 in PPG after becoming starter in Week 6)","Michael Wilson (WR3 in PPG after being added in Week 11)","Christian Watson (WR17 in PPG after being added in Week 10)","Joe Flacco (QB8 in PPG from Weeks 6–12 while Burrow was out)"]},{"category":"Breakout Player of the Year","winner":"Drake Maye","detail":"Finished QB2 with 21 PPG; highest previous finish QB23 in 2024","nominees":["Trey McBride (finished TE1 with 15.2 PPG, breaking the all-time TE receptions record)","Drake Maye (finished QB2 with 21 PPG, highest previous finish QB23 in 2024)","Javonte Williams (finished RB11 with 14 PPG following 3 consecutive seasons outside the top 30 RBs)","George Pickens (finished WR4 with 15.3 PPG, highest previous finish WR26 in 2023)"]},{"category":"Rookie of the Year","winner":"TreVeyon Henderson","detail":"RB20 · RB10 in PPG from Week 9 on","nominees":["TreVeyon Henderson (RB20, RB10 in PPG from Week 9 on)","RJ Harvey (RB19, RB9 in PPG after JK Dobbins injury in Week 10)","Emeka Egbuka (WR17)","Tet McMillan (WR14)","Jaxson Dart (QB16, QB8 in PPG after becoming the starter in Week 4)"]},{"category":"Comeback Player of the Year","winner":"Christian McCaffrey","detail":"RB1 following a season-long injury in 2024","nominees":["Daniel Jones (QB7 in PPG pre-injury after being a backup in Minnesota in 2024)","Christian McCaffrey (RB1 following season-long injury in 2024)","Trevor Lawrence (QB4 after missing the last 5 games of 2024)","Dak Prescott (QB5 after missing 9 games in 2024)"]},{"category":"Best Team Name","winner":"Puka & Rally","detail":"Manager: Colby","nominees":["Gibbs Me the Money","Exciting Whites","Nix Seven","Slim Pickens","Puka & Rally","Drake's Room","Bryce Likes 'Em Young","At DK, Have it Your Way"]},{"category":"Worst Team Name","winner":"Sorry Coop","detail":"Manager: Lee","nominees":["Sorry Coop","The Consheepsus","Fuck League Median","Haliee's Babiees"]},{"category":"Best Trade","winner":"Ben","detail":"Ben traded Omarion Hampton to Joey for Trevor Lawrence, helping him avoid the last-place punishment","nominees":["Joey: Chuba + Monangai for Egbuka + Jayden Reed (Evan)","Ben: Omarion Hampton for Trevor Lawrence (Joey)","Butta: Rico Dowdle + Devonta Smith for Amon-Ra St. Brown (Joey)","Pat: Drake London (injured) + Trey Benson (injured) for Jameson Williams + Quinshon Judkins (Marc)"]},{"category":"Best Manager","winner":"Joey","detail":"Made the most trades to create a well-balanced team and earn the 1 seed","nominees":["Joey (made the most trades to create a well balanced team and earn the 1 seed)","Evan (earned a bye week with first-round pick missing 10 weeks)","Brandon (highest % of max points)","Butta (arguably had the best trade and best waiver pickup of the year)"]},{"category":"Worst Manager","winner":"Ders","detail":"Made one trade for FAAB despite having a dogshit team","nominees":["Kev (worst % of max points)","Marc (worst trade right before the playoffs)","Ben (made 1 trade despite having a dogshit team)","Ders (made 1 trade for FAAB despite having a dogshit team)","Colby (had Puka and JT and didn't make the playoffs)"]},{"category":"Matchup of the Year","winner":"Butta vs. Marc · Week 15","detail":"113–113.76 · first-round playoff thriller with Achane clutch","nominees":["Ben vs. Kevin · Week 13 (81.22 to 76.38, battle of the punishment)","Butta vs. Marc · Week 15 (113 to 113.76, first-round playoff Achane clutch)","Evan vs. Colby · Week 7 (175.22 to 134.82, highest-scoring matchup of the year)","Kevin vs. Brandon · Week 14 (108.78 to 116.84, Kev redemption arc)","Butta vs. Brandon · Week 17 (87.22 to 101.46, championship Bijan legacy game)"]},{"category":"Luckiest Manager","winner":"Brandon","detail":"Avoided nearly all injuries; Nico Collins missing Week 8 was the only missed game from someone on his roster","nominees":["Joey (opponents averaged 10 PPG under their season-long averages against him; 9/14 scored below average)","Ders (opponents averaged 6.5 PPG under their season-long averages; 12/14 scored below average)","Brandon (avoided nearly all injuries; Nico Collins missing Week 8 was the only missed game from someone on his roster)","Butta (advanced to the championship with the second-fewest points in the league that week)"]},{"category":"Unluckiest Manager","winner":"Kevin","detail":"Opponents averaged 6 PPG over their season-long averages; Nabers and Purdy missed big chunks of the season","nominees":["Pat (opponents averaged 7.5 PPG over their season-long averages; 8/14 scored above average)","Kev (opponents averaged 6 PPG over their season-long averages; 7/14 scored above average, WR1 Nabers and QB1 Purdy missed big chunks of the season)"]}];
const AWARD_TEAM_MANAGERS={
 "Gibbs Me the Money":"Joey",
 "Exciting Whites":"Evan",
 "Nix Seven":"Brandon",
 "Slim Pickens":"Marc",
 "Puka & Rally":"Colby",
 "Drake's Room":"Pat",
 "Bryce Likes 'Em Young":"Ben",
 "At DK, Have it Your Way":"Kevin",
 "Sorry Coop":"Lee",
 "The Consheepsus":"Tanz",
 "Fuck League Median":"Ders",
 "Haliee's Babiees":"Butta"
};
const PARLAY_MANAGERS=["Evan","Tanz","Ben","Brandon","Colby","Joey","Marc","Butta","Lee","Ders","Pat","Kevin"];
const PARLAY_WEEKS=[["Loveland O4.5 REC","Lamar O215.5 pass yards","Saquon TD","Ja'marr Chase TD","Amon Ra TD","Omarion Hampton TD","Kenneth Walker 70+ rushing yards","Javonte Williams TD","Jayden Daniels TD","Josh Allen TD","Zay Flowers O66.5 receiving yards","Bucky Irving O60.5 rush yards"],["Mike Evans TD","Lamar O224.5 passing yards","Bucky TD","Derrick Henry 90+ rushing yards + TD","Jeanty TD","Eagles -6.5","Kenneth Walker O82.5 rushing yards","Drake Maye O1.5 passing TD","Bijan O95 rushing yards","Etienne O1.5 receptions","CMC TD","Ceedee O76.5 yards"],["Terrance Ferguson O3.5 rec","Lamar 230+ passing yards","Bengals ML","David Montgomery TD","Kyren Williams TD","Omarion Hampton TD","Stafford O1.5 pass TD","Jaylen Warren O86.5 rushing yards","Giants ML","Etienne TD","Chase Brown O63.5 rush yards","Breece Hall TD"],["Wicks O3.5 rec","N/A","Cardinals -2.5","CMC O4.5 rec","Chuba TD","Nabers O55.5 receiving yards","Goff O1.5 passing TD","Josh Downs TD","Aaron Jones TD","N/A","Jordan Addison O62.5 yards","Chiefs -4.5"],["Jacoby Brissett O1.5 passing TD","Monty U43.5 rushing yards","Amon Ra O81.5 receiving yards","Michael Wilson O71.5 receiving yards","Kyren TD","Pats ML","Trey McBride TD","LaPorta O51.5 receiving yards","Bills +3.5","Deshaun Watson O190.5 passing yards","Chase Brown TD","Lions -5.5"],["Tyler Higbee O32.5 receiving yards","Tucker Kraft 4+ receptions","Bijan 2+ TD","Omarion Hampton O32.5 rushing yards","Christian Watson TD","Jaylen Warren TD","Xavier Worthy O48.5 receiving yards","Dallas Goedert TD","Cam Skattebo U39.5 rushing yards","Drake London TD","Bryce Young 2+ Passing TD","Bills -5.5"],["Jordan Mason O12.5 rush attempts","Jalen Coker 6+ receptions","DK Metcalf TD","Brock Bowers TD","JJ McCarthy O0.5 passing TD","Bengals -2.5","N/A","Joe Burrow O1.5 passing TD","Bijan TD","N/A","CMC O53.5 rushing yards","George Kittle O69.5 receiving yards"],["Derrick Henry 80+ rush yards","Diggs O4.5 rec","Jonah Coleman O44.5 rush yards","Brock Bowers O68.5 rec yards","Kyren TD","Bills -3","Ken Walker TD","Javonte TD","Omar Cooper U41.5 rec yards","DK O4.5 receptions","Zay Flowers 80+ rec yards","Bucky Irving O70.5 rush yards"],["Keenan Allen O4.5 rec","Jayden Daniels O38.5 rush yards","Rashee TD","Ollie Gordon TD","Kyren TD","Jonah Coleman TD","Ken Walker O93.5 rush yards","Javonte TD","Antonio Williams O49.5 rec yards","Rome Odunze U50.5 rec yards","CMC TD","Puka O92.5 rec yards"],["George Kittle TD","Justin Herbert O0.5 INT","Emmett Johnson TD","Tuten TD","Chuba TD","Tee Higgins TD","Jonathan Taylor TD","Drake Maye O1.5 passing TD","Justin Jefferson TD","N/A","Zay Flowers O70.5 rec yards","Kyle McCord O0.5 INT"],[["Colston Loveland O50.5 receiving yards","Malik Nabers anytime TD"],"Omarion Hampton O63.5 rushing yards",["Tony Pollard O71.5 rushing yards","Jonah Coleman anytime TD"],["Chuba Hubbard anytime TD","Isaiah Likely anytime TD"],["Amon-Ra St. Brown anytime TD","Cam Skattebo anytime TD"],"Emmett Johnson O31.5 receiving yards","Cam Ward 2+ passing TD",["Sam LaPorta 40+ receiving yards","Jaylen Waddle O43.5 receiving yards"],"Cam Skattebo U56.5 rushing yards","N/A",["Kyle Monangai anytime TD","Parker Washington anytime TD"],["Bucky Irving anytime TD","George Kittle O4.5 receptions"]]];
const PARLAY_PLACERS=["Ben (random spin)","Ben","Tanz","Tanz","Tanz","Tanz","Joey","Lee","Marc","Tanz","Butta","","",""];

const PRE_SLEEPER_PLAYOFFS=[
 {year:2017,rounds:[{winner:"Evan",losers:["Ben"]},{winner:"Roth",losers:["Sam"]},{winner:"Roth",losers:["Evan"]}]},
 {year:2018,rounds:[{winner:"Joey",losers:["Colby","Tanz"]},{winner:"Roth",losers:["Evan"]},{winner:"Ben",losers:["Roth"]},{winner:"Sam",losers:["Joey"]},{winner:"Ben",losers:["Sam"]}]},
 {year:2019,rounds:[{winner:"Colby",losers:["Kevin"]},{winner:"Marc",losers:["Lee"]},{winner:"Marc",losers:["Sam"]},{winner:"Ben",losers:["Colby"]},{winner:"Ben",losers:["Marc"]}]},
 {year:2020,rounds:[{winner:"Evan",losers:["Tanz"]},{winner:"Pat",losers:["Ben"]},{winner:"Joey",losers:["Evan"]},{winner:"Marc",losers:["Pat"]},{winner:"Joey",losers:["Marc"]}]}
];
const PRE_SLEEPER_CHAMPIONS=[
 {year:2017,champion:"Roth",runnerUp:"Evan"},
 {year:2018,champion:"Ben",runnerUp:"Sam"},
 {year:2019,champion:"Ben",runnerUp:"Marc"},
 {year:2020,champion:"Joey",runnerUp:"Marc"}
];
const PRE_SLEEPER_STANDINGS = {
 2017:[["Evan",12,1],["Roth",9,4],["Sam",8,5],["Ben",6,7],["Joey",6,7],["Marc",5,8],["Hess",5,8],["Pat",1,12]],
 2018:[["Ben",10,3],["Sam",9,4],["Joey",8,5],["Evan",8,5],["Roth",7,6],["Colby & Tanz",7,6],["Marc",6,7],["Pat",4,9],["Butta",3,10],["Campbell",3,10]],
 2019:[["Sam",9,4],["Ben",9,4],["Colby",9,4],["Lee",7,6],["Marc",7,6],["Kevin",6,7],["Evan",5,8],["Joey",5,8],["Tanz",4,9],["Pat",4,9]],
 2020:[["Marc",9,4],["Joey",8,5],["Evan",8,5],["Pat",7,6],["Ben",7,6],["Tanz",7,6],["Colby",7,6],["Sam",7,6],["Lee",3,10],["Kevin",2,11]]
};
const PRE_SLEEPER_PLAYOFF_SLOTS = {2017:4,2018:6,2019:6,2020:6};
function hallLegacyStandings(year){
 return (PRE_SLEEPER_STANDINGS[year]||[]).map(([manager,wins,losses],index)=>({
  manager,wins,losses,rank:index+1,playoff:index<PRE_SLEEPER_PLAYOFF_SLOTS[year]
 }));
}
function hallLegacyStandingsMarkup(year){
 const rows=hallLegacyStandings(year);
 if(!rows.length)return "";
 return '<section class="hall-season-standings"><h3>FINAL REGULAR-SEASON STANDINGS</h3><div class="hall-season-table-wrap"><table class="hall-season-table"><thead><tr><th>#</th><th>MANAGER</th><th>W-L</th><th>PF</th><th>PA</th><th>STATUS</th></tr></thead><tbody>'+rows.map(row=>'<tr><td>'+row.rank+'</td><td>'+escapeHtml(row.manager)+'</td><td>'+row.wins+'-'+row.losses+'</td><td>—</td><td>—</td><td>'+(row.playoff?'<span class="hall-season-playoff">PLAYOFFS</span>':'—')+'</td></tr>').join("")+'</tbody></table></div><p class="hall-archive-note">PRE-SLEEPER ARCHIVE · POINTS-FOR AND POINTS-AGAINST WERE NOT RETAINED.</p></section>';
}
const RETIRED_MANAGERS=["Roth","Sam","Schmeef","Hess","Campbell"];
const MANAGER_TENURES={Brandon:"2025–present",Schmeef:"2021–2024"};
function getPreSleeperManagerStats(){
 const stats=new Map();
 const get=name=>{if(!stats.has(name))stats.set(name,{name,playoffWins:0,playoffAppearances:new Set(),championships:0,runnerUps:0,seasons:new Set()});return stats.get(name);};
 Object.entries(PRE_SLEEPER_STANDINGS).forEach(([year,rows])=>rows.forEach(([label,wins,losses])=>{
  const names=label==="Colby & Tanz"?["Colby","Tanz"]:[label];
  names.forEach(name=>{const row=get(name);row.seasons.add(Number(year));row.regularWins=(row.regularWins||0)+wins;row.regularLosses=(row.regularLosses||0)+losses;});
 }));
 PRE_SLEEPER_PLAYOFFS.forEach(season=>season.rounds.forEach(game=>{
  get(game.winner).playoffAppearances.add(season.year);get(game.winner).seasons.add(season.year);
  game.losers.forEach(name=>{get(name).playoffAppearances.add(season.year);get(name).seasons.add(season.year);});
  get(game.winner).playoffWins++;
 }));
 PRE_SLEEPER_CHAMPIONS.forEach(row=>{get(row.champion).championships++;get(row.runnerUp).runnerUps++;});
 return stats;
}
function hallManagerFromSleeperUser(user,managerByUserId=state.managerBySleeperUserId){
 const userId=String(user?.user_id||"").trim().replace(/^@/,"").toLowerCase();
 if(MANAGERS[userId])return MANAGERS[userId];
 const resolved=managerByUserId?.get(userId);
 if(resolved)return resolved;
 const username=String(user?.username||"").trim().replace(/^@/,"").toLowerCase();
 const display=String(user?.display_name||"").trim().replace(/^@/,"").toLowerCase();
 const currentAccount=state.users.find(current=>String(current.user_id||"")===userId);
 const currentUsername=String(currentAccount?.username||"").trim().replace(/^@/,"").toLowerCase();
 if(MANAGERS[currentUsername])return MANAGERS[currentUsername];
 if(MANAGERS[username])return MANAGERS[username];
 const known=[...new Set(Object.values(MANAGERS)),...RETIRED_MANAGERS];
 const normalized=value=>String(value||"").toLowerCase().replace(/[^a-z0-9]/g,"");
 const match=known.find(name=>normalized(name)===normalized(display)||normalized(name)===normalized(username));
 if(match)return match;
 if(normalized(username).includes("schmeef")||normalized(display).includes("schmeef"))return "Schmeef";
 return null;
}
function newHallStat(name){
 return {name,regularWins:0,regularLosses:0,regularTies:0,regularGames:0,weeksPlayed:0,pf:0,pa:0,playoffWins:0,playoffAppearances:new Set(),championships:0,runnerUps:0,thirdPlaces:0,regularSeasonChampionships:new Set(),seasons:new Set()};
}
function hallStatFor(stats,name){
 if(!stats.has(name))stats.set(name,newHallStat(name));
 return stats.get(name);
}
const HALL_HERO_AVATARS={
 "Kevin":0,"Marc":1,"Colby":2,"Ben":3,"Brandon":4,"Evan":5,"Pat":6,"Joey":7,"Butta":8,"Lee":9,"Ders":10,"Tanz":11,"Roth":12,"Sam":13,"Schmeef":14,"Hess":0,"Campbell":1
};
function hallScoringPoints(stats,settings){
 if(!stats||typeof stats!=="object")return 0;
 const rules=settings&&typeof settings==="object"?settings:{};
 let total=0,matched=0;
 for(const [key,multiplier] of Object.entries(rules)){
  if(typeof multiplier!=="number"||!Number.isFinite(multiplier))continue;
  const value=Number(stats[key]);
  if(Number.isFinite(value)){total+=value*multiplier;matched++;}
 }
 return matched?total:null;
}
async function loadHallDraftAndHonors(league,year,users,rosters,managerByRoster,regularWeeks,isCurrentSeason){
 const leagueId=league.league_id,errors=[];
 const playersPromise=state.hallPlayers?Promise.resolve(state.hallPlayers):(state.hallPlayersPromise||=fetchJson("/players/nfl",{attempts:2,timeoutMs:30000}).then(value=>(state.hallPlayers=value&&typeof value==="object"?value:{},state.hallPlayers)).catch(()=>({})));
 const [drafts,players]=await Promise.all([
  fetchJson("/league/"+leagueId+"/drafts",{attempts:2,timeoutMs:15000}).catch(error=>{errors.push("Draft list unavailable");return[];}),
  playersPromise
 ]);
 const draftRows=[];
 for(const draft of Array.isArray(drafts)?drafts:[]){
  try{
   const picks=await fetchJson("/draft/"+draft.draft_id+"/picks",{attempts:2,timeoutMs:20000});
   if(!Array.isArray(picks))continue;
   const draftOrder=draft.draft_order||{},slotMap=draft.slot_to_roster_id||{};
   const managerByUser=new Map(users.map(user=>[String(user.user_id),hallManagerFromSleeperUser(user)]));
   const managerBySlot=new Map();
   for(const [userId,slotValue] of Object.entries(draftOrder)){const slot=Number(slotValue),manager=managerByUser.get(String(userId));if(slot>0&&manager&&!managerBySlot.has(slot))managerBySlot.set(slot,manager);}
   for(const pick of picks){const slot=Number(pick.draft_slot),manager=managerByRoster.get(Number(pick.roster_id))||managerByUser.get(String(pick.picked_by||pick.metadata?.picked_by||""));if(slot>0&&manager&&!managerBySlot.has(slot))managerBySlot.set(slot,manager);}
   const picksMapped=picks.map(pick=>{
    const player=players?.[pick.player_id]||{};
    const rosterId=Number(pick.roster_id);
    const drafter=managerByRoster.get(rosterId)||managerByUser.get(String(pick.picked_by||pick.metadata?.picked_by||""))||null;
    const slot=Number(pick.draft_slot)||null;
    return {playerId:String(pick.player_id||""),player:player.full_name||pick.metadata?.first_name&&pick.metadata?.last_name?((player.full_name)||(pick.metadata.first_name+" "+pick.metadata.last_name)):pick.player_id||"Unknown player",position:player.position||pick.metadata?.position||"—",team:player.team||"FA",manager:drafter,rosterId,round:Number(pick.round)||Math.ceil(Number(pick.pick_no)/Math.max(1,rosters.length)),pick:Number(pick.pick_no)||0,pickInRound:((Number(pick.pick_no)||0)-((Number(pick.round)||1)-1)*(Number(draft.settings?.teams)||rosters.length)),slot,originalSlotManager:slot?managerByRoster.get(Number(slotMap[slot]||slotMap[String(slot)]))||null:null};
   });
   const slots=Number(draft.settings?.teams)||rosters.length;
   const slotManagers=Array.from({length:slots},(_,i)=>managerBySlot.get(i+1)||managerByRoster.get(Number(slotMap[i+1]||slotMap[String(i+1)]))||"");
   draftRows.push({draftId:draft.draft_id,type:draft.type||"snake",season:year,picks:picksMapped,slotManagers,rounds:Number(draft.settings?.rounds)||Math.ceil(picksMapped.length/Math.max(1,rosters.length)),slots});
  }catch(error){errors.push("Draft picks unavailable for "+(draft.draft_id||year));}
 }
 // Positional Leaders use full NFL regular-season half-PPR totals, not
 // only the fantasy league's Weeks 1 through playoff_week_start - 1.
 // Historical seasons include NFL regular-season Weeks 1-18; the current
 // season is limited to completed weeks passed in by the caller.
 const statsWeeks=isCurrentSeason?regularWeeks:18;
 const weeks=Array.from({length:statsWeeks},(_,i)=>i+1);
 const statsByPlayer=new Map();
 await Promise.all(weeks.map(async week=>{
  try{
   const data=await fetchJson("/stats/nfl/regular/"+year+"/"+week,{attempts:2,timeoutMs:20000});
   for(const [playerId,row] of Object.entries(data||{})){
    const pos=players?.[playerId]?.position;
    if(!["QB","RB","WR","TE"].includes(pos))continue;
    const stats=row?.stats||row;
    const halfPpr=stats?.pts_half_ppr!=null&&stats?.pts_half_ppr!==""?Number(stats.pts_half_ppr):NaN;
    if(!Number.isFinite(halfPpr))continue;
    const old=statsByPlayer.get(playerId)||{points:0,playerId,position:pos};
    old.points+=halfPpr;statsByPlayer.set(playerId,old);
   }
  }catch(error){errors.push("Player stats unavailable for "+year+" Week "+week);}
 }));
 const pickByPlayer=new Map();
 for(const draft of draftRows)for(const pick of draft.picks)if(pick.playerId)pickByPlayer.set(pick.playerId,pick);
 const leaders=["QB","RB","WR","TE"].map(position=>{
  const candidates=[...statsByPlayer.values()].filter(row=>row.position===position).sort((a,b)=>b.points-a.points);
  const best=candidates[0];if(!best)return {position,player:"Unavailable",points:null};
  const pick=pickByPlayer.get(best.playerId);
  return {position,player:players?.[best.playerId]?.full_name||best.playerId,playerId:best.playerId,points:best.points,manager:pick?.manager||"Undrafted / not in league draft",round:pick?.round||null,pick:pick?.pick||null,pickInRound:pick?.pickInRound??(pick?.pick&&pick?.round?pick.pick-(pick.round-1)*(draftRows.find(d=>d.picks.includes(pick))?.slots||rosters.length):null),team:players?.[best.playerId]?.team||"—"};
 });
 return {drafts:draftRows,leaders,errors};
}
function hallDraftMarkup(row){
 const drafts=row?.drafts||[];
 if(!drafts.length)return '<section class="hall-season-draft"><h3>LEAGUE DRAFT</h3><div class="hall-bracket-empty">SLEEPER DRAFT BOARD NOT AVAILABLE FOR THIS SEASON.</div></section>';
 return drafts.map((draft,index)=>{
  const picks=[...draft.picks].sort((a,b)=>a.pick-b.pick),columns=Array.from({length:draft.slots},(_,i)=>i+1),byCell=new Map(picks.map(p=>[p.round+":"+p.slot,p]));
  return '<section class="hall-season-draft"><h3>'+(drafts.length>1?"DRAFT "+(index+1):"LEAGUE DRAFT")+'</h3><div class="hall-draft-scroll"><table class="hall-draft-table"><thead><tr>'+columns.map(slot=>'<th class="hall-draft-slot-manager"><b>'+escapeHtml(draft.slotManagers?.[slot-1]||"—")+'</b></th>').join("")+'</tr></thead><tbody>'+Array.from({length:draft.rounds},(_,round)=>'<tr>'+columns.map(slot=>{
   const pick=byCell.get((round+1)+":"+slot);if(!pick)return '<td>—</td>';
   const position=String(pick.position||"").toUpperCase(),posClass=position==="QB"?"qb":position==="RB"?"rb":position==="WR"?"wr":position==="TE"?"te":["DEF","DST","D/ST"].includes(position)?"sflx":position==="K"?"flex":"other";
   const pickInRound=String(Number(pick.pickInRound)||slot).padStart(2,"0");
   return '<td class="hall-draft-pick pos-'+posClass+'"><b>'+escapeHtml(pick.player)+'</b><small>'+escapeHtml(position)+'</small><em>'+(round+1)+'.'+pickInRound+'</em></td>';
  }).join("")+'</tr>').join("")+'</tbody></table></div></section>';
 }).join("");
}
function hallLeadersMarkup(row){
 const leaders=row?.leaders||[];
 if(!leaders.length)return "";
 return '<section class="hall-season-leaders"><h3>POSITIONAL LEADERS</h3><div class="hall-leader-grid">'+leaders.map(item=>'<article class="hall-leader-card"><span>'+escapeHtml(item.position)+'</span><div class="hall-leader-player"><strong>'+escapeHtml(item.player)+'</strong><small>'+escapeHtml(item.manager||"Drafter unavailable")+(item.round?' · '+item.round+'.'+String(item.pickInRound||0).padStart(2,"0"):'')+'</small></div><b>'+(item.points==null?"—":fmt(item.points)+" PTS")+'</b></article>').join("")+'</div></section>';
}
async function loadSleeperHallHistory(){
 if(state.hallHistory)return state.hallHistory;
 if(state.hallHistoryPromise)return state.hallHistoryPromise;
 state.hallHistoryPromise=(async()=>{
  if(!state.league){
   const ready=await sleeperCoreReady;
   if(!ready||!state.league)throw new Error("Sleeper league data has not loaded. Refresh the page and try again.");
  }
  const seasons=[],unresolved=[],errors=[],recordGames=[],seasonTotals=[];
  const resolvedAccounts=await Promise.all(Object.entries(MANAGERS).map(async([username,manager])=>{
   try{const account=await fetchJson("/user/"+encodeURIComponent(username),{attempts:2,timeoutMs:12000});return account?.user_id?{userId:String(account.user_id),manager,username}:null;}
   catch(error){errors.push("Could not resolve manager account "+manager+" through Sleeper username lookup");return null;}
  }));
  state.managerBySleeperUserId=new Map(resolvedAccounts.filter(Boolean).map(row=>[row.userId,row.manager]));
  const resolvedAccountCount=state.managerBySleeperUserId.size;
  let league=state.league;
  const currentYear=Number(league?.season)||2026;
  let nflState=state.nflState;
  try{nflState=await fetchJson("/state/nfl",{attempts:2,timeoutMs:10000});state.nflState=nflState;}
  catch(error){nflState=state.nflState||null;}
  const nflCurrentWeek=Number(nflState?.week)||Number(state.currentWeek)||1;
  for(let year=currentYear;year>=2021;year--){
   if(!league||Number(league.season)!==year){
    const previousId=league?.previous_league_id;
    if(!previousId){errors.push("Sleeper history chain ended before "+year);break;}
    try{league=await fetchJson("/league/"+previousId,{attempts:2,timeoutMs:12000});}
    catch(error){errors.push(year+" league metadata unavailable: "+(error?.message||String(error)));break;}
   }
   if(Number(league?.season)!==year){errors.push("Expected "+year+" season but Sleeper returned "+String(league?.season||"an unknown season"));break;}
   try{
    const isCurrent=String(league.league_id)===String(state.league?.league_id);
    const [users,rosters]=isCurrent?[state.users,state.rosters]:await Promise.all([
     fetchJson("/league/"+league.league_id+"/users",{attempts:2,timeoutMs:12000}),
     fetchJson("/league/"+league.league_id+"/rosters",{attempts:2,timeoutMs:12000})
    ]);
    if(!Array.isArray(users)||!Array.isArray(rosters)||!rosters.length)throw new Error("Sleeper returned incomplete roster ownership data (users: "+(Array.isArray(users)?users.length:"invalid")+", rosters: "+(Array.isArray(rosters)?rosters.length:"invalid")+")");
    const userById=new Map(users.map(user=>[String(user.user_id),user]));
    const managerByRoster=new Map();
    for(const roster of rosters){
     const user=userById.get(String(roster.owner_id));
     const manager=hallManagerFromSleeperUser(user,state.managerBySleeperUserId);
     if(manager){managerByRoster.set(Number(roster.roster_id),manager);hallStatFor(state.hallStats,manager).seasons.add(year);}
     else unresolved.push({year,rosterId:roster.roster_id,username:user?.username||"unknown",displayName:user?.display_name||"unknown"});
    }
    const playoffStart=Math.max(2,Number(league.settings?.playoff_week_start)||15);
    const regularWeeks=playoffStart-1;
    // Sleeper's NFL state identifies the live scoring week. Only consider weeks
    // before it eligible for Hall of Fame stats; all-roster final scores below
    // provide a second safeguard against incomplete or placeholder matchup data.
    const latestCompletedWeek=year===currentYear?Math.max(0,Math.min(regularWeeks,nflCurrentWeek-1)):regularWeeks;
    const regularWeeksToLoad=latestCompletedWeek;
    const seasonExtras=await loadHallDraftAndHonors(league,year,users,rosters,managerByRoster,regularWeeksToLoad,year===currentYear);
    const weekData=[];
    const regularGamesBefore=recordGames.length;
    for(let batchStart=1;batchStart<=regularWeeksToLoad;batchStart+=4){
     const batch=Array.from({length:Math.min(4,regularWeeksToLoad-batchStart+1)},(_,i)=>batchStart+i);
     const loaded=await Promise.all(batch.map(async week=>{
      try{
       const rows=await fetchJson("/league/"+league.league_id+"/matchups/"+week,{attempts:2,timeoutMs:12000});
       return Array.isArray(rows)?{week,rows}:null;
      }catch(error){errors.push(year+" Week "+week+" unavailable: "+(error?.message||String(error)));return null;}
     }));
     weekData.push(...loaded.filter(Boolean));
    }
    const stats=state.hallStats;
    const seasonPoints=new Map(),seasonAgainst=new Map(),seasonWins=new Map();
    const addSeasonWin=manager=>seasonWins.set(manager,(seasonWins.get(manager)||0)+1);
    let completedScoringWeeks=0;
    for(const {week,rows} of weekData){
     // Sleeper returns placeholder matchup rows with 0/null points for future weeks.
     // Only count a week once every roster has a real, positive final score.
     const scoreRows=rows.filter(row=>managerByRoster.has(Number(row.roster_id))&&row.points!=null&&Number.isFinite(Number(row.points))&&Number(row.points)>0);
     if(scoreRows.length!==rosters.length)continue;
     completedScoringWeeks++;
     const scoreByRoster=new Map(scoreRows.map(row=>[Number(row.roster_id),Number(row.points)]));
     const groups=new Map();
     for(const row of scoreRows){
      const id=Number(row.roster_id),manager=managerByRoster.get(id),stat=hallStatFor(stats,manager),points=Number(row.points);
      stat.pf+=points;stat.regularGames++;stat.weeksPlayed++;
      seasonPoints.set(manager,(seasonPoints.get(manager)||0)+points);
      if(!groups.has(row.matchup_id))groups.set(row.matchup_id,[]);
      groups.get(row.matchup_id).push(row);
     }
     for(const group of groups.values()){
      if(group.length!==2)continue;
      const [a,b]=group,ma=managerByRoster.get(Number(a.roster_id)),mb=managerByRoster.get(Number(b.roster_id));
      if(!ma||!mb)continue;
      const sa=Number(a.points),sb=Number(b.points),ta=hallStatFor(stats,ma),tb=hallStatFor(stats,mb);
      recordGames.push({year,week,label:"Week "+week,type:"Regular Season",manager1:ma,manager2:mb,score1:sa,score2:sb});
      ta.pa+=sb;tb.pa+=sa;
      seasonAgainst.set(ma,(seasonAgainst.get(ma)||0)+sb);seasonAgainst.set(mb,(seasonAgainst.get(mb)||0)+sa);
      if(sa>sb){ta.regularWins++;tb.regularLosses++;addSeasonWin(ma);}
      else if(sa<sb){tb.regularWins++;ta.regularLosses++;addSeasonWin(mb);}
      else{ta.regularTies++;tb.regularTies++;}
     }
     const medianEnabled=Number(league.settings?.league_average_match)===1||league.settings?.league_average_match===true;
     if(medianEnabled){
      const sorted=scoreRows.map(row=>Number(row.points)).sort((a,b)=>a-b);
      const median=(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;
      for(const row of scoreRows){
       const manager=managerByRoster.get(Number(row.roster_id));
       if(!manager)continue;
       const stat=hallStatFor(stats,manager),score=Number(row.points);
       if(score>median){stat.regularWins++;addSeasonWin(manager);}
       else if(score<median)stat.regularLosses++;
       else stat.regularTies++;
      }
     }
    }
    let bracket=[];
    try{const value=await fetchJson("/league/"+league.league_id+"/winners_bracket",{attempts:2,timeoutMs:12000});if(Array.isArray(value))bracket=value;}
    catch(error){errors.push(year+" playoff bracket unavailable");}
    const completed=bracket.filter(game=>game.w!=null&&game.l!=null);
    const completedRegularWeeks=completedScoringWeeks;
    const playoffFieldFinalized=year!==currentYear||completedRegularWeeks>=regularWeeks;
    const standingsWeeksComplete=completedScoringWeeks;
    const medianGameEnabled=Number(league.settings?.league_average_match)===1||league.settings?.league_average_match===true;
    const playoffTeams=Number(league.settings?.playoff_teams)||0;
    const seasonStandings=[...seasonPoints.entries()].map(([manager,points])=>({manager,points,pointsAgainst:seasonAgainst.get(manager)||0,wins:seasonWins.get(manager)||0,losses:Math.max(0,standingsWeeksComplete*(medianGameEnabled?2:1)-(seasonWins.get(manager)||0))})).sort((a,b)=>b.wins-a.wins||b.points-a.points).map((row,index)=>({...row,rank:index+1,playoff:index<playoffTeams}));
    const regularSeasonChampion=completedRegularWeeks>=regularWeeks?seasonStandings[0]?.manager||null:null;
    if(regularSeasonChampion)hallStatFor(stats,regularSeasonChampion).regularSeasonChampionships.add(year);
    const rawBracketById=new Map(bracket.map(game=>[Number(game.m),game]));
    const resolveBracketRoster=(rosterId,source)=>{
     if(rosterId!=null&&typeof rosterId!=="object")return Number(rosterId);
     const ref=source||(rosterId&&typeof rosterId==="object"?rosterId:null);
     if(!ref)return null;
     const sourceGame=rawBracketById.get(Number(ref.w??ref.l));
     if(!sourceGame)return null;
     const resolvedRoster=ref.w!=null?sourceGame.w:sourceGame.l;
     return resolvedRoster!=null?Number(resolvedRoster):null;
    };
    const resolveBracketSlot=(rosterId,source)=>{
     const resolved=resolveBracketRoster(rosterId,source);
     return resolved!=null?(managerByRoster.get(resolved)||null):null;
    };
    const playoffScoreByWeek=new Map();
    await Promise.all([1,2,3].map(async round=>{
     try{
      const rows=await fetchJson("/league/"+league.league_id+"/matchups/"+(playoffStart+round-1),{attempts:2,timeoutMs:12000});
      if(Array.isArray(rows))playoffScoreByWeek.set(round,new Map(rows.filter(row=>row.points!=null&&Number.isFinite(Number(row.points))).map(row=>[Number(row.roster_id),Number(row.points)])));
     }catch(error){errors.push(year+" playoff Week "+(playoffStart+round-1)+" scores unavailable");}
    }));
    const rosterByManager=new Map([...managerByRoster.entries()].map(([rosterId,manager])=>[manager,Number(rosterId)]));
    const seedByRoster=new Map(seasonStandings.map((standing,index)=>[rosterByManager.get(standing.manager),index+1]).filter(([rosterId])=>rosterId!=null));
    const hasFirstRoundByes=playoffTeams>=6||bracket.filter(game=>Number(game.r)===1&&!game.p).length===2;
    const byeTeams=hasFirstRoundByes?seasonStandings.slice(0,2).map((standing,index)=>({seed:index+1,manager:standing.manager})):[];
    const seasonBracketGames=bracket.map(game=>({
     matchId:Number(game.m)||0,round:Number(game.r)||1,placement:Number(game.p)||null,
     team1:resolveBracketSlot(game.t1,game.t1_from),team2:resolveBracketSlot(game.t2,game.t2_from),
     source1:game.t1_from||(game.t1&&typeof game.t1==="object"?game.t1:null),source2:game.t2_from||(game.t2&&typeof game.t2==="object"?game.t2:null),
     seed1:seedByRoster.get(resolveBracketRoster(game.t1,game.t1_from))||null,
     seed2:seedByRoster.get(resolveBracketRoster(game.t2,game.t2_from))||null,
     winner:managerByRoster.get(Number(game.w))||null,loser:managerByRoster.get(Number(game.l))||null,
     score1:game.p1!=null&&Number.isFinite(Number(game.p1))?Number(game.p1):(playoffScoreByWeek.get(Number(game.r)||1)?.get(resolveBracketRoster(game.t1,game.t1_from))??null),
     score2:game.p2!=null&&Number.isFinite(Number(game.p2))?Number(game.p2):(playoffScoreByWeek.get(Number(game.r)||1)?.get(resolveBracketRoster(game.t2,game.t2_from))??null),
     bye:game.t2==null&&!game.t2_from
    })).filter(game=>game.team1||game.team2||game.winner||game.source1||game.source2);
    for(const game of seasonBracketGames){
     if(game.winner&&game.loser&&game.team1&&game.team2&&game.score1!=null&&game.score2!=null&&game.score1>0&&game.score2>0){
      recordGames.push({year,week:null,label:"Playoff Round "+game.round,type:"Playoffs",manager1:game.team1,manager2:game.team2,score1:game.score1,score2:game.score2});
     }
    }
    if(playoffFieldFinalized)for(const game of bracket){
     for(const rosterId of [game.t1,game.t2]){
      if(rosterId==null)continue;
      const manager=managerByRoster.get(Number(rosterId));
      if(manager)hallStatFor(stats,manager).playoffAppearances.add(year);
     }
     if(game.w!=null){
      const winner=managerByRoster.get(Number(game.w));
      if(winner)hallStatFor(stats,winner).playoffWins++;
     }
    }
    let champion=null,runnerUp=null,thirdPlace=null;
    const firstPlaceGame=bracket.find(game=>Number(game.p)===1)||null;
    const thirdPlaceGame=bracket.find(game=>Number(game.p)===3)||null;
    if(firstPlaceGame?.w!=null){
     champion=managerByRoster.get(Number(firstPlaceGame.w))||null;
     runnerUp=managerByRoster.get(Number(firstPlaceGame.l))||null;
    }else if(completed.length){
     const finalRound=Math.max(...completed.map(game=>Number(game.r)||0));
     const finalGame=completed.filter(game=>(Number(game.r)||0)===finalRound&&(!game.p||Number(game.p)===1)).slice(-1)[0];
     champion=managerByRoster.get(Number(finalGame?.w))||null;
     runnerUp=managerByRoster.get(Number(finalGame?.l))||null;
    }
    if(thirdPlaceGame?.w!=null)thirdPlace=managerByRoster.get(Number(thirdPlaceGame.w))||null;
    if(playoffFieldFinalized&&champion)hallStatFor(stats,champion).championships++;
    if(playoffFieldFinalized&&runnerUp)hallStatFor(stats,runnerUp).runnerUps++;
    if(playoffFieldFinalized&&thirdPlace)hallStatFor(stats,thirdPlace).thirdPlaces++;
    const bracketGames=seasonBracketGames;
    if(completedRegularWeeks>=regularWeeks)seasonPoints.forEach((points,manager)=>seasonTotals.push({year,manager,points}));
    const regularMatchups=recordGames.length-regularGamesBefore;
    const playoffMatchups=seasonBracketGames.filter(game=>game.winner&&game.loser&&game.team1&&game.team2&&game.score1!=null&&game.score2!=null&&game.score1>0&&game.score2>0).length;
    seasons.push({year,champion,runnerUp:runnerUp||null,thirdPlace,regularSeasonChampion,standings:seasonStandings,byeTeams,drafts:seasonExtras.drafts,leaders:seasonExtras.leaders,extraErrors:seasonExtras.errors,bracket:bracketGames,leagueId:league.league_id,regularWeeks,completedRegularWeeks,managerCount:managerByRoster.size,mappedManagers:managerByRoster.size,regularMatchups,playoffMatchups});
   }catch(error){errors.push(year+" season failed: "+(error?.message||String(error)));}
   if(year>2021){
    const previousId=league.previous_league_id;
    if(!previousId){errors.push("No previous league ID supplied after "+year);break;}
    try{league=await fetchJson("/league/"+previousId,{attempts:2,timeoutMs:12000});}
    catch(error){errors.push("Could not load "+(year-1)+" season metadata");break;}
   }
  }
  const result={seasons,unresolved,errors,recordGamesLoaded:recordGames.length,seasonTotalsLoaded:seasonTotals.length,recordBook:buildHallRecordBook(recordGames,seasonTotals)};
  state.hallHistory=result;
  return result;
 })().catch(error=>{
  state.hallHistoryError=error?.message||String(error);
  const result={seasons:[],unresolved:[],errors:[state.hallHistoryError],recordGamesLoaded:0,seasonTotalsLoaded:0,recordBook:[]};
  state.hallHistory=result;
  return result;
 }).finally(()=>{state.hallHistoryPromise=null;});
 return state.hallHistoryPromise;
}
function buildHallRecordBook(games,seasonTotals){
 const scored=[];
 for(const game of games){
  const {score1,score2}=game;
  if(!Number.isFinite(score1)||!Number.isFinite(score2)||!game.manager1||!game.manager2)continue;
  const common={year:game.year,label:game.label,type:game.type,manager1:game.manager1,manager2:game.manager2,score1,score2};
  const margin=Math.abs(score1-score2),combined=score1+score2;
  scored.push({...common,margin,combined,winner:score1>score2?game.manager1:score2>score1?game.manager2:null,loser:score1>score2?game.manager2:score2>score1?game.manager1:null,winnerScore:Math.max(score1,score2),loserScore:Math.min(score1,score2)});
 }
 const best=(items,selector,mode="max")=>items.length?items.reduce((chosen,item)=>chosen==null||(mode==="min"?selector(item)<selector(chosen):selector(item)>selector(chosen))?item:chosen,null):null;
 const weekScores=scored.flatMap(game=>[
  {year:game.year,label:game.label,type:game.type,manager:game.manager1,points:game.score1,opponent:game.manager2,opponentPoints:game.score2},
  {year:game.year,label:game.label,type:game.type,manager:game.manager2,points:game.score2,opponent:game.manager1,opponentPoints:game.score1}
 ]);
 const seasonBest=best(seasonTotals,row=>row.points);
 const highWeek=best(weekScores,row=>row.points);
 const blowout=best(scored.filter(game=>game.winner),row=>row.margin);
 const closest=best(scored,row=>row.margin,"min");
 const lowCombined=best(scored,row=>row.combined,"min");
 const highCombined=best(scored,row=>row.combined);
 const pointsLoss=best(scored.filter(game=>game.loser),row=>row.loserScore);
 const lowestWin=best(scored.filter(game=>game.winner),row=>row.winnerScore,"min");
 return [
  {key:"high-week",title:"Highest Scoring Week",icon:"🔥",value:highWeek?fmt(highWeek.points):"—",holder:highWeek?.manager||"No data",detail:highWeek?highWeek.year+" · "+highWeek.label+" · vs "+highWeek.opponent:"No completed matchups"},
  {key:"high-season",title:"Highest Scoring Season",icon:"📈",value:seasonBest?fmt(seasonBest.points):"—",holder:seasonBest?.manager||"No data",detail:seasonBest?seasonBest.year+" · Regular-season points":"No complete season data"},
  {key:"biggest-blowout",title:"Biggest Blowout",icon:"💥",value:blowout?fmt(blowout.margin)+" pts":"—",holder:blowout?blowout.winner+" over "+blowout.loser:"No data",detail:blowout?blowout.year+" · "+blowout.label+" · "+fmt(blowout.score1)+"–"+fmt(blowout.score2):"No completed matchups"},
  {key:"closest-game",title:"Closest Game",icon:"🎯",value:closest?fmt(closest.margin)+" pts":"—",holder:closest?closest.manager1+" vs "+closest.manager2:"No data",detail:closest?closest.year+" · "+closest.label+" · "+fmt(closest.score1)+"–"+fmt(closest.score2):"No completed matchups"},
  {key:"lowest-combined",title:"Lowest Combined Score",icon:"🧊",value:lowCombined?fmt(lowCombined.combined)+" pts":"—",holder:lowCombined?lowCombined.manager1+" vs "+lowCombined.manager2:"No data",detail:lowCombined?lowCombined.year+" · "+lowCombined.label+" · "+fmt(lowCombined.score1)+"–"+fmt(lowCombined.score2):"No completed matchups"},
  {key:"highest-combined",title:"Highest Combined Score",icon:"🚀",value:highCombined?fmt(highCombined.combined)+" pts":"—",holder:highCombined?highCombined.manager1+" vs "+highCombined.manager2:"No data",detail:highCombined?highCombined.year+" · "+highCombined.label+" · "+fmt(highCombined.score1)+"–"+fmt(highCombined.score2):"No completed matchups"},
  {key:"points-loss",title:"Most Points in a Loss",icon:"😵",value:pointsLoss?fmt(pointsLoss.loserScore)+" pts":"—",holder:pointsLoss?pointsLoss.loser+" in a loss to "+pointsLoss.winner:"No data",detail:pointsLoss?pointsLoss.year+" · "+pointsLoss.label+" · "+fmt(pointsLoss.loserScore)+"–"+fmt(pointsLoss.winnerScore):"No completed matchups"},
  {key:"lowest-win",title:"Fewest Points in a Win",icon:"😬",value:lowestWin?fmt(lowestWin.winnerScore)+" pts":"—",holder:lowestWin?lowestWin.winner+" over "+lowestWin.loser:"No data",detail:lowestWin?lowestWin.year+" · "+lowestWin.label+" · "+fmt(lowestWin.winnerScore)+"–"+fmt(lowestWin.loserScore):"No completed matchups"}
 ];
}
const HALL_CHARACTER_DESIGNS={
 Kevin:{suit:"#2479d8",shadow:"#12345f",trim:"#f4c542",skin:"#d9a17d",hair:"#d9b46c",hairPath:"M35 37Q29 17 46 12Q62 4 76 17Q88 25 80 43L72 34L63 29Q51 38 35 37Z",beard:"",eyes:"#3b91d4",brow:"#68452f",accessory:'<path d="M38 25L48 13L58 20L69 12L81 26" fill="none" stroke="#f4c542" stroke-width="4" stroke-linecap="round"/><path d="M70 14L82 4" stroke="#fff1a8" stroke-width="2.5" stroke-linecap="round"/>',emblem:"⚡"},
 Marc:{suit:"#8a55d8",shadow:"#38235f",trim:"#f3b4ff",skin:"#e5ad83",hair:"#27233d",hairPath:"M34 37Q28 15 45 13Q63 4 78 18Q87 28 79 40L73 30Q60 33 53 25Q45 35 34 37Z",beard:'<path d="M40 54Q45 64 59 63Q72 62 76 53L72 65Q60 75 47 66Z" fill="#27233d"/>',eyes:"#8a55d8",brow:"#27233d",accessory:'<path d="M34 34Q47 29 58 34" fill="none" stroke="#b98aff" stroke-width="3"/><circle cx="76" cy="42" r="8" fill="none" stroke="#f3b4ff" stroke-width="2.5"/><path d="M82 48L87 54" stroke="#f3b4ff" stroke-width="2"/>',emblem:"✦"},
 Colby:{suit:"#2eaa70",shadow:"#14543c",trim:"#d8ef72",skin:"#c98b67",hair:"#50352b",hairPath:"M33 39Q25 23 36 15Q42 5 51 13Q59 2 67 12Q82 9 84 25Q88 35 78 42L73 30Q62 35 57 26Q48 35 39 31Z",beard:'<path d="M40 54Q43 69 59 70Q75 68 77 53L70 68Q59 75 48 68Z" fill="#50352b"/>',eyes:"#4b9e65",brow:"#50352b",accessory:'<path d="M34 27Q57 15 82 27" fill="none" stroke="#d8ef72" stroke-width="5"/><circle cx="44" cy="46" r="1.5" fill="#9b5e4a"/><circle cx="73" cy="46" r="1.5" fill="#9b5e4a"/>',emblem:"✚"},
 Ben:{suit:"#d94b38",shadow:"#70251f",trim:"#ffc34d",skin:"#e2a47f",hair:"#8e2d26",hairPath:"M34 39Q27 23 37 15L43 18L45 3L54 14L62 1L66 17L80 11Q87 28 78 41L72 30Q56 35 42 30Z",beard:'<path d="M39 53Q42 68 58 71Q74 69 78 52L73 68Q59 80 45 68Z" fill="#8e2d26"/>',eyes:"#477caa",brow:"#68251f",accessory:'<path d="M43 19L50 7L57 17L64 5L68 22" fill="none" stroke="#ffc34d" stroke-width="3" stroke-linejoin="round"/>',emblem:"★"},
 Brandon:{suit:"#db8a24",shadow:"#68401a",trim:"#f7e07a",skin:"#d69a72",hair:"#34251f",hairPath:"M33 38Q27 24 36 16L44 20L42 8L54 16L59 5L66 18L78 12Q87 28 79 40L71 31Q54 35 42 30Z",beard:'<path d="M41 54Q47 61 58 60Q69 61 75 53L70 64Q58 70 46 64Z" fill="#34251f"/>',eyes:"#7d5528",brow:"#34251f",accessory:'<path d="M34 32Q57 25 81 32" fill="none" stroke="#f7e07a" stroke-width="3"/><rect x="34" y="28" width="18" height="10" rx="4" fill="#25364a" stroke="#f7e07a" stroke-width="2"/><rect x="63" y="28" width="18" height="10" rx="4" fill="#25364a" stroke="#f7e07a" stroke-width="2"/><path d="M52 32H63" stroke="#f7e07a" stroke-width="2"/>',emblem:"☀"},
 Evan:{suit:"#258dba",shadow:"#16445e",trim:"#e9e8f2",skin:"#e9b995",hair:"#332d32",hairPath:"M33 39Q27 21 39 13Q53 4 67 13Q84 15 82 36L75 31Q68 21 59 25Q47 18 38 34Z",beard:'<path d="M40 55Q45 65 58 66Q70 65 76 54L70 66Q58 72 47 66Z" fill="#51434a" opacity=".85"/>',eyes:"#4d9fc0",brow:"#332d32",accessory:'<path d="M33 28Q57 21 82 28" fill="none" stroke="#e9e8f2" stroke-width="3"/><path d="M35 21L30 15M79 21L85 15" stroke="#e9e8f2" stroke-width="2.5" stroke-linecap="round"/>',emblem:"✧"},
 Pat:{suit:"#b94e9b",shadow:"#5a2854",trim:"#f2d46d",skin:"#d49a78",hair:"#743b4d",hairPath:"M34 38Q27 17 43 11Q59 3 75 15Q87 28 80 48L73 39L72 27Q60 19 51 25Q43 20 37 35Z",beard:"",eyes:"#8f5e9f",brow:"#552b42",accessory:'<path d="M31 32Q57 22 84 32L80 41Q57 34 35 42Z" fill="#5a2854" stroke="#f2d46d" stroke-width="2"/><path d="M36 34L80 34" stroke="#f2d46d" stroke-width="1.5"/>',emblem:"✦"},
 Joey:{suit:"#d44a36",shadow:"#63231f",trim:"#39d5e6",skin:"#e3ad8b",hair:"#211d2b",hairPath:"M34 38Q27 21 39 13Q54 3 70 13Q84 21 80 40L72 32Q60 30 53 24Q44 35 35 34Z",beard:'<path d="M41 55Q46 66 59 67Q72 66 76 54L71 67Q58 75 46 67Z" fill="#211d2b"/>',eyes:"#39d5e6",brow:"#211d2b",accessory:'<path d="M65 40L82 40L79 49L64 49Z" fill="#39d5e6" opacity=".88"/><path d="M66 44H78" stroke="#fff" stroke-width="1.5"/>',emblem:"◆"},
 Butta:{suit:"#5c9d35",shadow:"#2b4b22",trim:"#e8cb50",skin:"#a96f53",hair:"#252629",hairPath:"M35 38Q30 24 40 16Q53 8 68 15Q79 19 80 36L72 31Q58 27 44 32Z",beard:'<path d="M40 54Q46 64 58 64Q70 64 76 54L70 65Q58 71 46 65Z" fill="#252629"/>',eyes:"#86b75a",brow:"#252629",accessory:'<path d="M35 50Q57 55 81 50L78 58Q58 64 38 58Z" fill="#2b4b22" stroke="#e8cb50" stroke-width="1.5"/><path d="M43 53L73 53" stroke="#e8cb50" stroke-width="1.5"/>',emblem:"✚"},
 Lee:{suit:"#596bdb",shadow:"#29346d",trim:"#d5e5ff",skin:"#e4b18d",hair:"#c8cbd5",hairPath:"M33 39Q27 19 43 12Q60 4 76 17Q86 26 80 41L74 32Q60 26 53 31Q43 25 36 37Z",beard:"",eyes:"#5479c9",brow:"#777f99",accessory:'<path d="M33 42Q57 36 82 42" fill="none" stroke="#d5e5ff" stroke-width="2.5"/><circle cx="45" cy="46" r="7" fill="none" stroke="#d5e5ff" stroke-width="2"/><circle cx="70" cy="46" r="7" fill="none" stroke="#d5e5ff" stroke-width="2"/><path d="M52 45H63" stroke="#d5e5ff" stroke-width="2"/>',emblem:"✦"},
 Ders:{suit:"#c3a12e",shadow:"#66521a",trim:"#f4e5a2",skin:"#d49a76",hair:"#b77b3e",hairPath:"M34 38Q27 22 40 14Q54 6 70 13Q84 20 80 39L73 32Q62 26 52 30Q42 25 36 36Z",beard:'<path d="M42 54Q48 60 59 60Q69 60 75 54L70 64Q58 69 47 64Z" fill="#8a512d"/>',eyes:"#6d8b8a",brow:"#8a512d",accessory:'<path d="M36 24Q57 13 80 25" fill="none" stroke="#f4e5a2" stroke-width="3.5"/><path d="M57 15L62 7L67 16" fill="#f4e5a2" stroke="#8a6b20" stroke-width="1.5"/>',emblem:"★"},
 Tanz:{suit:"#a64cc4",shadow:"#4b2362",trim:"#f5a7d7",skin:"#e6ad89",hair:"#51244e",hairPath:"M33 40Q26 19 42 11Q59 2 76 16Q88 29 79 47L72 37Q67 26 58 27Q46 33 37 38Z",beard:"",eyes:"#b35bd2",brow:"#51244e",accessory:'<path d="M34 34Q57 24 82 34L78 43Q57 36 37 43Z" fill="#51244e" stroke="#f5a7d7" stroke-width="2"/><path d="M41 36L49 35M67 35L76 36" stroke="#f5a7d7" stroke-width="1.5"/>',emblem:"✧"},
 Roth:{suit:"#737b8c",shadow:"#343b4c",trim:"#eeeeef",skin:"#c8a28c",hair:"#aeb6c4",hairPath:"M34 38Q28 20 42 12Q59 4 75 16Q85 26 80 40L73 32Q57 26 47 31Q40 29 35 38Z",beard:'<path d="M41 54Q47 65 59 65Q71 65 76 54L70 66Q58 72 47 66Z" fill="#8e929c"/>',eyes:"#8493b2",brow:"#747d8e",accessory:'<path d="M34 25Q57 17 81 26" fill="none" stroke="#eeeeef" stroke-width="3"/>',emblem:"♜"},
 Sam:{suit:"#65758c",shadow:"#303d51",trim:"#e9eef5",skin:"#c99e83",hair:"#604d43",hairPath:"M34 39Q27 22 40 14Q55 5 70 14Q84 23 79 40L72 31Q61 26 52 30Q43 26 36 37Z",beard:'<path d="M40 54Q45 67 59 68Q72 67 77 54L70 69Q58 76 46 68Z" fill="#604d43"/>',eyes:"#7d9aa8",brow:"#604d43",accessory:'<path d="M34 27Q56 20 81 28" fill="none" stroke="#e9eef5" stroke-width="3"/><path d="M77 29L85 23" stroke="#e9eef5" stroke-width="2"/>',emblem:"♜"},
 Schmeef:{suit:"#737373",shadow:"#3d3d3d",trim:"#e6e6e6",skin:"#c5a18c",hair:"#686868",hairPath:"M34 39Q27 20 42 13Q59 4 75 17Q85 27 79 40L72 32Q58 27 47 31Q39 29 34 39Z",beard:"",eyes:"#9b9b9b",brow:"#555",accessory:'<path d="M34 25Q57 17 81 26" fill="none" stroke="#e6e6e6" stroke-width="3"/>',emblem:"◇"},
 Hess:{suit:"#737373",shadow:"#3d3d3d",trim:"#e6e6e6",skin:"#d0a78d",hair:"#423c38",hairPath:"M33 39Q28 22 40 14Q54 6 69 14Q84 22 80 40L73 31Q59 27 49 31Q40 28 35 38Z",beard:'<path d="M40 54Q46 65 59 65Q71 65 76 54L70 66Q58 72 46 66Z" fill="#423c38"/>',eyes:"#999",brow:"#423c38",accessory:'<path d="M35 27Q57 19 81 27" fill="none" stroke="#e6e6e6" stroke-width="3"/>',emblem:"◇"},
 Campbell:{suit:"#737373",shadow:"#3d3d3d",trim:"#e6e6e6",skin:"#b98368",hair:"#262626",hairPath:"M34 38Q28 22 40 15Q55 6 70 14Q83 21 79 39L72 32Q57 28 47 31Q39 28 35 38Z",beard:'<path d="M40 54Q46 67 59 67Q72 67 77 54L70 68Q58 75 46 68Z" fill="#262626"/>',eyes:"#9b9b9b",brow:"#262626",accessory:'<path d="M34 26Q57 18 81 27" fill="none" stroke="#e6e6e6" stroke-width="3"/>',emblem:"◇"}
};
function hallPixelAvatar(name){
 const spriteIds={"Kevin":"kevin","Marc":"marc","Colby":"colby","Ben":"ben","Brandon":"brandon","Evan":"evan","Pat":"pat","Joey":"joey","Butta":"butta","Ders":"ders","Tanz":"tanz","Roth":"roth","Sam":"sam","Schmeef":"schmeef","Hess":"hess","Campbell":"campbell","Lee":"lee"};
 const sprite=spriteIds[name];if(!sprite)return "";
 const dimensions={kevin:[32,98],marc:[38,98],colby:[48,98],ben:[50,98],brandon:[72,98],evan:[42,50],pat:[50,50],joey:[64,80],butta:[64,100],ders:[52,82],tanz:[46,86],roth:[36,100],sam:[48,100],schmeef:[48,96],hess:[56,96],campbell:[42,96],lee:[44,100]}[sprite];
 return '<svg class="hall-character-avatar hall-pixel-sprite" viewBox="0 0 '+dimensions[0]+' '+dimensions[1]+'" role="img" aria-label="'+escapeHtml(name)+' character" focusable="false"><use href="/assets/hall-sprites.svg#'+sprite+'"></use></svg>';
}
function hallManagerHonors(name,stat){
 const playoffYears=[...(stat.playoffAppearances||new Set())].sort((a,b)=>a-b);
 const championYears=[...PRE_SLEEPER_CHAMPIONS.filter(row=>row.champion===name).map(row=>row.year),...(state.hallHistory?.seasons||[]).filter(row=>row.champion===name).map(row=>row.year)].sort((a,b)=>a-b);
 const runnerUpYears=[...PRE_SLEEPER_CHAMPIONS.filter(row=>row.runnerUp===name).map(row=>row.year),...(state.hallHistory?.seasons||[]).filter(row=>row.runnerUp===name).map(row=>row.year)].sort((a,b)=>a-b);
 const thirdPlaceYears=(state.hallHistory?.seasons||[]).filter(row=>row.thirdPlace===name).map(row=>row.year).sort((a,b)=>a-b);
 const regularChampionYears=(state.hallHistory?.seasons||[]).filter(row=>row.regularSeasonChampion===name).map(row=>row.year).sort((a,b)=>a-b);
 const honors=[];
 if(championYears.length)honors.push({icon:"🏆",tone:"gold",label:championYears.length+"× Champion",detail:championYears.join(", ")});
 if(runnerUpYears.length)honors.push({icon:"🏆",tone:"silver",label:runnerUpYears.length+"× Runner-up",detail:runnerUpYears.join(", ")});
 if(thirdPlaceYears.length)honors.push({icon:"🏆",tone:"bronze",label:thirdPlaceYears.length+"× 3rd Place",detail:thirdPlaceYears.join(", ")});
 if(regularChampionYears.length)honors.push({icon:"🥇",tone:"gold",label:regularChampionYears.length+"× Regular Season Champion",detail:regularChampionYears.join(", ")});
 if(playoffYears.length)honors.push({icon:"🥈",tone:"silver",label:playoffYears.length+"× Playoff Appearance",detail:playoffYears.join(", ")});
 return honors;
}
function hallPreSleeperBracket(year){
 const season=PRE_SLEEPER_PLAYOFFS.find(row=>row.year===year);
 if(!season)return [];
 if(Number(year)===2017){
  const seedByManager=new Map(hallLegacyStandings(year).map(row=>[row.manager,Number(row.rank)]));
  return season.rounds.map((game,index)=>{
   const loser=game.losers.join(" & ");
   const teams=[game.winner,loser].sort((a,b)=>(seedByManager.get(a)||99)-(seedByManager.get(b)||99));
   return {
    matchId:index+1,round:index<2?1:3,placement:null,
    team1:teams[0],team2:teams[1],
    seed1:seedByManager.get(teams[0])||null,seed2:seedByManager.get(teams[1])||null,
    winner:game.winner,loser,
    score1:null,score2:null,legacy:true
   };
  });
 }
 const standings=hallLegacyStandings(year);
 const seedByManager=new Map();
 standings.forEach(row=>seedByManager.set(row.manager,Number(row.rank)));
 const rank=name=>seedByManager.get(String(name||"").trim())||99;
 const firstRound=season.rounds.slice(0,2).map(game=>{
  const loser=game.losers.join(" & ");
  const participants=[game.winner,loser].sort((a,b)=>rank(a)-rank(b));
  return {winner:game.winner,loser,team1:participants[0],team2:participants[1],seed1:rank(participants[0]),seed2:rank(participants[1])};
 });
 const pair=game=>[game.seed1,game.seed2].sort((a,b)=>a-b).join(",");
 const game45=firstRound.find(game=>pair(game)==="4,5");
 const game36=firstRound.find(game=>pair(game)==="3,6");
 const orderedFirst=[game45,game36,...firstRound.filter(game=>game!==game45&&game!==game36)].filter(Boolean);
 const bracket=orderedFirst.map((game,index)=>({...game,matchId:index+1,round:1,score1:null,score2:null,legacy:false}));
 const byeTeams=[];
 season.rounds.slice(2,4).forEach((game,index)=>{
  const participants=[game.winner,...game.losers];
  const bye=participants.find(name=>rank(name)<=2);
  const firstRoundWinner=participants.find(name=>bracket.some(item=>item.winner===name));
  if(bye)byeTeams.push({seed:rank(bye),manager:bye});
  const sourceGame=bracket.find(item=>item.winner===firstRoundWinner);
  bracket.push({
   matchId:3+index,round:2,team1:bye||"TBD",team2:firstRoundWinner||null,
   seed1:bye?rank(bye):null,seed2:firstRoundWinner?rank(firstRoundWinner):null,
   winner:game.winner,loser:game.losers.join(" & "),
   score1:null,score2:null,legacy:false
  });
 });
 const final=season.rounds[4];
 if(final){
  const finalLoser=final.losers.join(" & ");
  const finalTeams=[final.winner,finalLoser].sort((a,b)=>rank(a)-rank(b));
  bracket.push({
   matchId:5,round:3,team1:finalTeams[0],team2:finalTeams[1],
   seed1:rank(finalTeams[0]),seed2:rank(finalTeams[1]),
   winner:final.winner,loser:finalLoser,
   score1:null,score2:null,legacy:false
  });
 }
 return {bracket,byeTeams:byeTeams.sort((a,b)=>a.seed-b.seed)};
}
function hallPlayoffTemplateMarkup(){
 const bracket=[
  {matchId:1,round:1,team1:"Seed 4",team2:"Seed 5",seed1:4,seed2:5},
  {matchId:2,round:1,team1:"Seed 3",team2:"Seed 6",seed1:3,seed2:6},
  {matchId:3,round:2,team1:"Seed 1",team2:null,seed1:1,source2:{w:2}},
  {matchId:4,round:2,team1:"Seed 2",team2:null,seed1:2,source2:{w:1}},
  {matchId:5,round:3,team1:null,team2:null,source1:{w:3},source2:{w:4}},
  {matchId:6,round:3,placement:3,team1:null,team2:null,source1:{l:3},source2:{l:4}},
  {matchId:7,round:3,placement:5,team1:null,team2:null,source1:{l:1},source2:{l:2}}
 ];
 const row={bracket,byeTeams:[{seed:1,manager:"Seed 1"},{seed:2,manager:"Seed 2"}]};
 return '<div class="hall-bracket-scroll">' + hallBracketMarkup(Number(state.league?.season)||new Date().getFullYear(),row) + '</div>';
}
function hallBracketMarkup(year,championRow){
 const legacyData=championRow?.bracket?.length?null:hallPreSleeperBracket(year);
 const games=championRow?.bracket?.length?championRow.bracket:(Array.isArray(legacyData)?legacyData:(legacyData?.bracket||[]));
 if(legacyData&&!Array.isArray(legacyData))championRow={...championRow,byeTeams:legacyData.byeTeams};
 if(!games.length)return '<div class="hall-bracket-empty">PLAYOFF BRACKET NOT AVAILABLE FOR THIS SEASON.</div>';
 const byId=new Map(games.map(game=>[Number(game.matchId),game]));
 const slot=(team,source,seed)=>{
  if(team)return (seed?'<small class="hall-bracket-seed">#'+seed+'</small>':'')+'<span>'+escapeHtml(team)+'</span>';
  if(source){
   const id=Number(source.w??source.l),kind=source.w!=null?"Winner":"Loser",earlier=byId.get(id),resolved=earlier?(source.w!=null?earlier.winner:earlier.loser):null;
   const resolvedSeed=earlier&&resolved?(resolved===earlier.team1?earlier.seed1:earlier.seed2):null;
   return resolved?(resolvedSeed?'<small class="hall-bracket-seed">#'+resolvedSeed+'</small>':'')+'<span>'+escapeHtml(resolved)+'</span>':'<span class="hall-bracket-pending">'+kind+' of Game '+id+'</span>';
  }
  return '<span class="hall-bracket-pending">TBD</span>';
 };
 const matchCard=(game)=>{
  const firstWinner=!!game.winner&&game.winner===game.team1,secondWinner=!!game.winner&&game.winner===game.team2;
  const team1=slot(game.team1,game.source1,game.seed1),team2=slot(game.team2,game.source2,game.seed2);
  const score1=game.score1!=null?'<small class="hall-bracket-score">'+fmt(game.score1)+'</small>':"";
  const score2=game.score2!=null?'<small class="hall-bracket-score">'+fmt(game.score2)+'</small>':"";
  return '<article class="hall-tree-game '+(game.winner?'completed':'')+'"><div class="hall-tree-team '+(firstWinner?'winner':'')+'">'+team1+score1+'</div><div class="hall-tree-team '+(secondWinner?'winner':'')+'">'+team2+score2+'</div></article>';
 };
 if(games.some(game=>!game.legacy)){
  const round1=games.filter(game=>game.round===1&&!game.placement);
  const round2=games.filter(game=>game.round===2&&!game.placement);
  const final=games.find(game=>game.placement===1)||games.filter(game=>game.round>=3&&!game.placement).sort((a,b)=>a.round-b.round)[0];
  const third=games.find(game=>game.placement===3);
  const otherPlacements=games.filter(game=>game.placement&&![1,3].includes(game.placement));
  const byeRows=(championRow?.byeTeams||[]).map(team=>({seed:Number(team.seed)||99,html:'<article class="hall-tree-game hall-tree-bye"><div class="hall-tree-team"><span><small class="hall-bracket-seed">#'+team.seed+'</small>'+escapeHtml(team.manager)+'</span></div><div class="hall-tree-team hall-bye-opponent"><span>BYE</span></div></article>'})).sort((a,b)=>a.seed-b.seed);
  const seedPair=game=>[Number(game.seed1)||99,Number(game.seed2)||99].sort((a,b)=>a-b);
  const matchup45=round1.find(g=>seedPair(g)[0]===4&&seedPair(g)[1]===5);
  const matchup36=round1.find(g=>seedPair(g)[0]===3&&seedPair(g)[1]===6);
  const orderedGames=[matchup45,matchup36,...round1.filter(g=>g!==matchup45&&g!==matchup36)];
  const firstRoundHtml=[byeRows[0]?.html,matchup45?matchCard(matchup45):null,byeRows[1]?.html,matchup36?matchCard(matchup36):null,...orderedGames.slice(2).map(matchCard)].filter(Boolean).join("");
  // Match each semifinal to the BYE team it advances from, rather than
  // relying on the order returned by the Sleeper bracket data.
  const byeManagers=(championRow?.byeTeams||[]).slice().sort((a,b)=>(Number(a.seed)||99)-(Number(b.seed)||99)).map(team=>String(team.manager||""));
  const hasManager=(game,manager)=>[game.team1,game.team2,game.winner,game.loser].some(name=>String(name||"").toLowerCase()===manager.toLowerCase());
  const orderedSemifinals=[...byeManagers.map(manager=>round2.find(game=>hasManager(game,manager))).filter(Boolean),...round2.filter(game=>!byeManagers.some(manager=>hasManager(game,manager)))];
  const placements=[...(third?[{label:"3RD PLACE GAME",game:third}]:[]),...otherPlacements.map(game=>({label:(game.placement||"")+"TH PLACE GAME",game}))];
  return '<div class="hall-bracket-tree hall-bracket-playoff"><section class="hall-tree-column hall-tree-round-one"><span class="hall-bracket-round-label">WEEK 15 · FIRST ROUND</span><div class="hall-round-games">'+(firstRoundHtml||'<div class="hall-bracket-empty">NO FIRST-ROUND GAMES</div>')+'</div></section><section class="hall-tree-column hall-tree-round-two"><span class="hall-bracket-round-label">WEEK 16 · SEMIFINALS</span><div class="hall-round-games">'+(orderedSemifinals.map(matchCard).join("")||'<div class="hall-bracket-empty">SEMIFINALS NOT AVAILABLE</div>')+'</div></section><section class="hall-tree-column hall-tree-finals"><span class="hall-bracket-round-label">WEEK 17 · CHAMPIONSHIP</span><div class="hall-round-games">'+(final?'<div class="hall-tree-final">'+matchCard(final)+'</div>':'<div class="hall-bracket-empty">CHAMPIONSHIP NOT DECIDED</div>')+'</div>'+'</section>'+(placements.length?'<div class="hall-placement-games">'+placements.map(item=>'<div class="hall-placement-game"><span class="hall-bracket-round-label">'+item.label+'</span>'+matchCard(item.game)+'</div>').join("")+'</div>':"")+'</div>';
 }
 const roundOne=games.filter(game=>game.round===1);
 const semifinals=games.filter(game=>game.round===2);
 const championship=games.find(game=>game.round===3)||games.find(game=>game.round===2&&game.matchId===3);
 const isFourTeam=Number(year)===2017;
 const finalHtml=championship?matchCard(championship):'<div class="hall-bracket-empty">CHAMPIONSHIP NOT DECIDED</div>';
 const tree=isFourTeam
  ? '<div class="hall-bracket-tree hall-bracket-playoff hall-bracket-legacy-playoff"><section class="hall-tree-column hall-tree-round-one"><span class="hall-bracket-round-label">PLAYOFF ROUND 1</span><div class="hall-round-games"></div></section><section class="hall-tree-column hall-tree-round-two"><span class="hall-bracket-round-label">PLAYOFF SEMIFINALS</span><div class="hall-round-games">'+roundOne.map(matchCard).join("")+'</div></section><section class="hall-tree-column hall-tree-finals"><span class="hall-bracket-round-label">CHAMPIONSHIP</span><div class="hall-round-games"><div class="hall-tree-final">'+finalHtml+'</div></div></section></div>'
  : '<div class="hall-bracket-tree hall-bracket-playoff hall-bracket-legacy-playoff"><section class="hall-tree-column hall-tree-round-one"><span class="hall-bracket-round-label">PLAYOFF ROUND 1</span><div class="hall-round-games">'+roundOne.map(matchCard).join("")+'</div></section><section class="hall-tree-column hall-tree-round-two"><span class="hall-bracket-round-label">PLAYOFF SEMIFINALS</span><div class="hall-round-games">'+semifinals.map(matchCard).join("")+'</div></section><section class="hall-tree-column hall-tree-finals"><span class="hall-bracket-round-label">CHAMPIONSHIP</span><div class="hall-round-games"><div class="hall-tree-final">'+finalHtml+'</div></div></section></div>';
 return '<div class="hall-bracket-scroll">'+tree+'</div>';
}
function hallSleeperStandingsMarkup(row){
 const standings=row?.standings||[];
 if(!standings.length)return "";
 return '<section class="hall-season-standings"><h3>'+(Number(row.completedRegularWeeks)>=Number(row.regularWeeks)&&Number(row.regularWeeks)>0?"FINAL":"CURRENT")+' REGULAR-SEASON STANDINGS</h3><div class="hall-season-table-wrap"><table class="hall-season-table"><thead><tr><th>#</th><th>MANAGER</th><th>W-L</th><th>POINTS FOR</th><th>POINTS AGAINST</th><th>STATUS</th></tr></thead><tbody>'+standings.map(item=>'<tr><td>'+item.rank+'</td><td>'+escapeHtml(item.manager)+'</td><td>'+item.wins+'-'+item.losses+'</td><td>'+fmt(item.points)+'</td><td>'+fmt(item.pointsAgainst||0)+'</td><td>'+(item.playoff?'<span class="hall-season-playoff">PLAYOFFS</span>':'—')+'</td></tr>').join("")+'</tbody></table></div></section>';
}
function hallAwardsMarkup(){
 const count=AWARDS_2025.reduce((n,a)=>n+a.nominees.length,0);
 const managerLabel=name=>AWARD_TEAM_MANAGERS[name]?' <span class="award-team-manager">· '+escapeHtml(AWARD_TEAM_MANAGERS[name])+'</span>':'';
 return '<section class="hall-season-awards"><div class="hall-section-heading"><div><span class="hall-kicker">2025 SEASON · LEAGUE VOTING</span><h3>Monkey Boys Awards</h3></div><span class="hall-count">15 AWARDS</span></div><div class="awards-grid">'+AWARDS_2025.map((a,i)=>{const teamAward=a.category==="Best Team Name"||a.category==="Worst Team Name";return '<article class="award-card"><div class="award-card-top"><span class="award-number">'+String(i+1).padStart(2,"0")+'</span><span class="award-category">'+escapeHtml(a.category)+'</span></div><div class="award-winner"><span class="award-kicker">2025 WINNER</span><strong>'+escapeHtml(a.winner)+'</strong><p>'+escapeHtml(a.detail)+'</p></div><details class="award-nominees"><summary><span>VIEW ALL NOMINEES</span><b>'+a.nominees.length+'</b></summary><ol>'+a.nominees.map(n=>'<li class="'+((n.toLowerCase().includes(a.winner.toLowerCase())||(a.winner==="Kevin"&&n.startsWith("Kev ")))?"selected":"")+'">'+escapeHtml(n)+(teamAward?managerLabel(n):'')+'</li>').join("")+'</ol></details></article>';}).join("")+'</div></section>';
}
function openHallSeasonPage(year,updateUrl=true){
 if(!state.hallHistory&&!state.hallHistoryPromise){loadSleeperHallHistory().then(()=>openHallSeasonPage(year,updateUrl));return;}
 if(state.hallHistoryPromise){state.hallHistoryPromise.then(()=>openHallSeasonPage(year,updateUrl));return;}
 const row=state.hallHistory?.seasons?.find(item=>Number(item.year)===Number(year))||PRE_SLEEPER_CHAMPIONS.find(item=>Number(item.year)===Number(year));
 if(!row)return;
 const champion=row.champion||"TBD",runner=row.runnerUp||"—";
 const legacyStandings=hallLegacyStandingsMarkup(year)||hallSleeperStandingsMarkup(row);
 const awardMarkup=year===2025?hallAwardsMarkup():"";
 let page=document.getElementById("hall-season-page");
 if(!page){page=document.createElement("section");page.id="hall-season-page";page.className="hall-season-page";document.querySelector("main").appendChild(page);}
 document.querySelectorAll(".tab-panel").forEach(panel=>panel.hidden=true);
 document.querySelectorAll(".nav-tab").forEach(tab=>tab.classList.remove("active"));
 page.hidden=false;
 page.innerHTML='<button class="hall-season-back" type="button">← BACK TO HALL OF FAME</button><header class="hall-season-header"><div class="hall-kicker">MONKEY BOYS · SEASON ARCHIVE</div><h1>'+Number(year)+' Season Detail</h1><div class="hall-season-champion"><span>🏆 CHAMPION</span><strong>'+escapeHtml(champion)+'</strong><small>Runner-up · '+escapeHtml(runner)+(row.thirdPlace?' · 3rd Place · '+escapeHtml(row.thirdPlace):'')+(row.regularSeasonChampion?' · Regular Season Champion · '+escapeHtml(row.regularSeasonChampion):'')+'</small></div></header><section class="hall-season-section"><h2>Playoff Bracket</h2>'+hallBracketMarkup(year,row)+'</section><div class="hall-season-summary-grid">'+legacyStandings+hallLeadersMarkup(row)+'</div>'+awardMarkup+hallDraftMarkup(row);
 page.querySelector(".hall-season-back").addEventListener("click",()=>{page.hidden=true;document.querySelectorAll(".tab-panel").forEach(panel=>panel.hidden=panel.dataset.panel!=="hall");document.querySelector('[data-tab="hall"]')?.classList.add("active");history.pushState(null,"","#hall");renderHallOfFame();window.scrollTo({top:0,behavior:"smooth"});});
 if(updateUrl)history.pushState(null,"","#season-"+Number(year));
 window.scrollTo({top:0,behavior:"smooth"});
}

function renderHallOfFame(){
 const target=$("hall-content");if(!target)return;
 if(!state.hallStats){
  state.hallStats=new Map();
  const historical=getPreSleeperManagerStats();
  for(const [name,stat] of historical){
   const merged=newHallStat(name);
   merged.playoffWins=stat.playoffWins;merged.playoffAppearances=new Set(stat.playoffAppearances);
   merged.championships=stat.championships;merged.runnerUps=stat.runnerUps;merged.seasons=new Set(stat.seasons||[]);
   merged.regularWins=stat.regularWins||0;merged.regularLosses=stat.regularLosses||0;merged.regularGames=merged.regularWins+merged.regularLosses;
   state.hallStats.set(name,merged);
  }
 }
 const allStats=state.hallStats;
 if(!state.hallHistory&&!state.hallHistoryPromise){
  target.innerHTML='<div class="hall-loading">CONNECTING TO SLEEPER · BUILDING CAREER RECORDS…</div>';
  loadSleeperHallHistory().then(()=>renderHallOfFame());
  return;
 }
 if(state.hallHistoryPromise){
  target.innerHTML='<div class="hall-loading">AGGREGATING SEASON RESULTS…</div>';
  return;
 }
 const active=[...new Set(Object.values(MANAGERS))],retired=[...RETIRED_MANAGERS],historical=["Hess","Campbell"],managers=[...new Set([...active,...retired,...historical])];
  const managerOrderStats=name=>{const stat=allStats.get(name)||newHallStat(name),games=stat.regularWins+stat.regularLosses+stat.regularTies;return {championships:stat.championships||0,winPct:games?stat.regularWins/games:0,runnerUps:stat.runnerUps||0,regularTitles:stat.regularSeasonChampionships?.size||0,points:stat.pf||0};};
  const sortManagers=(key)=>managers.sort((a,b)=>{const retiredOrder=Number(retired.includes(a))-Number(retired.includes(b));if(retiredOrder)return retiredOrder;const x=managerOrderStats(a),y=managerOrderStats(b);const playoffX=allStats.get(a)?.playoffAppearances?.size||0,playoffY=allStats.get(b)?.playoffAppearances?.size||0;if(key==="championships")return y.championships-x.championships||y.winPct-x.winPct||playoffY-playoffX;if(key==="playoffs")return playoffY-playoffX||y.winPct-x.winPct||y.championships-x.championships;return y.winPct-x.winPct||y.championships-x.championships||playoffY-playoffX;});
  sortManagers("winPct");
 const statFor=name=>allStats.get(name)||newHallStat(name);
 const makeCard=(name,index,isRetired)=>{
  const stat=statFor(name),games=stat.regularWins+stat.regularLosses+stat.regularTies;
  const record=stat.seasons.size?stat.regularWins+"-"+stat.regularLosses+(stat.regularTies?"-"+stat.regularTies:""):"—";
  const winPct=games?(100*stat.regularWins/games).toFixed(1)+"%":"—";
  const avg=stat.weeksPlayed?fmt(stat.pf/stat.weeksPlayed):"—";
  const honors=hallManagerHonors(name,stat);
  const honorIcons=honors.map(honor=>Array.from({length:(honor.detail||"").split(",").filter(Boolean).length||1},()=>'<span class="hall-honor-icon '+(honor.tone||"")+'" title="'+escapeHtml(honor.label)+'" aria-label="'+escapeHtml(honor.label)+'">'+honor.icon+'</span>').join("")).join("");
  const honorList=honors.length?honors.map(honor=>'<li><span class="hall-honor-icon '+(honor.tone||"")+'">'+honor.icon+'</span><div><strong>'+escapeHtml(honor.label)+'</strong><small>'+escapeHtml(honor.detail||"")+'</small></div></li>').join(""):'<li class="hall-no-honors">NO RECORDED HONORS YET</li>';
  const years=isRetired?(MANAGER_TENURES[name]||"FORMER MANAGER"):"YEAR "+Math.max(1,stat.seasons.size);
  const palette=["#67D9F2","#FF8A7A","#C3A0FF","#F4D06F","#7FE0B5","#FF9BCB","#83B5FF","#FFB36B","#C2DF72","#D4B4F0","#63D6C8","#F28FA3"];
  const activeOrder=[...state.teams.values()].map(team=>team.name);
  const managerColor=isRetired?"#aaa":palette[Math.max(0,activeOrder.indexOf(name))%palette.length];
  const cardTop=isRetired?'<span class="hall-card-top"><span class="hall-card-number">'+String(index+1).padStart(2,"0")+'</span><span class="hall-status">RETIRED</span></span>':"";
  return '<button class="hall-flip-card '+(isRetired?'retired':'active')+'" style="--manager-color:'+managerColor+'" type="button" aria-expanded="false" aria-label="View '+escapeHtml(name)+' career record"><div class="hall-flip-inner"><div class="hall-card-face hall-card-front">'+cardTop+'<span class="hall-avatar-line">'+hallPixelAvatar(name)+'</span><span class="hall-manager-name">'+escapeHtml(name)+'</span>'+(name==="Evan"?'<span class="hall-commissioner-label">COMMISSIONER</span>':"")+'<span class="hall-front-honors">'+(honorIcons||'<span class="hall-honor-empty">—</span>')+'</span><span class="hall-manager-years">'+escapeHtml(years)+'</span><span class="hall-flip-hint">CLICK TO VIEW CAREER ↻</span></div><div class="hall-card-face hall-card-back"><span class="hall-back-heading"><strong>'+escapeHtml(name)+'</strong><small>CAREER RECORD</small></span><span class="hall-back-stats"><span><b>'+record+'</b><small>REGULAR W-L</small></span><span><b>'+winPct+'</b><small>WIN %</small></span><span><b>'+avg+'</b><small>AVG POINTS</small></span><span><b>'+stat.playoffAppearances.size+'</b><small>PLAYOFF APPS</small></span><span><b>'+stat.playoffWins+'</b><small>PLAYOFF WINS</small></span><span><b>'+stat.championships+'</b><small>CHAMPIONSHIPS</small></span></span><div class="hall-back-honors"><small>HONORS</small><ul>'+honorList+'</ul></div><span class="hall-flip-hint">CLICK TO FLIP BACK ↻</span></div></div></button>';
 };
 const knownSeasons=new Map(PRE_SLEEPER_CHAMPIONS.map(row=>({...row,regularSeasonChampion:hallLegacyStandings(row.year)[0]?.manager||null})).concat((state.hallHistory.seasons||[]).map(row=>({year:row.year,champion:row.champion,runnerUp:row.runnerUp,thirdPlace:row.thirdPlace,regularSeasonChampion:row.regularSeasonChampion,bracket:row.bracket}))).map(row=>[Number(row.year),row]));
 const archiveEnd=Math.max(2020,Number(state.league?.season)||2026);
 const champions=Array.from({length:archiveEnd-2017+1},(_,index)=>{const year=2017+index;return knownSeasons.get(year)||{year,champion:null,runnerUp:null,thirdPlace:null,regularSeasonChampion:null,bracket:[]};});
 const championCards=champions.map((row,index)=>'<button class="hall-champion-card" type="button" data-hall-year="'+row.year+'"><span class="hall-champion-season">'+row.year+' SEASON</span><span class="hall-champion-crown">🏆</span><strong>'+escapeHtml(row.champion||"IN PROGRESS")+'</strong><span class="hall-champion-runner">RUNNER-UP · '+escapeHtml(row.runnerUp||"TBD")+'</span>'+(row.thirdPlace?'<span class="hall-champion-runner">3RD PLACE · '+escapeHtml(row.thirdPlace)+'</span>':'')+(row.regularSeasonChampion?'<span class="hall-champion-runner">REGULAR SEASON · '+escapeHtml(row.regularSeasonChampion)+'</span>':'')+'<span class="hall-champion-link">VIEW SEASON DETAIL ↗</span></button>').join("");
 const unresolved=state.hallHistory.unresolved||[],errors=state.hallHistory.errors||[];
 const diagnostic=unresolved.length?'<p class="hall-footnote">'+unresolved.length+' HISTORICAL ROSTER RECORDS COULD NOT BE MATCHED TO A MANAGER.</p>':'';
 const errorNote=errors.length?'<p class="hall-footnote">DATA NOTES: '+errors.map(escapeHtml).join(' · ')+'</p>':'';
 const recordBook=state.hallHistory.recordBook||[];
 const recordCards=recordBook.map((record,index)=>'<article class="hall-record-card"><div class="hall-record-card-top"><span class="hall-record-icon">'+record.icon+'</span><span class="hall-record-number">'+String(index+1).padStart(2,"0")+'</span></div><span class="hall-record-title">'+escapeHtml(record.title)+'</span><strong class="hall-record-value">'+escapeHtml(record.value)+'</strong><span class="hall-record-holder">'+escapeHtml(record.holder)+'</span><small class="hall-record-detail">'+escapeHtml(record.detail)+'</small></article>').join("");
 const dataSummary="";
 target.innerHTML='<section class="hall-record-section hall-champions-section"><div class="hall-section-heading"><div><span class="hall-kicker">THE HARDWARE</span><h2>Champions by Year</h2></div><span class="hall-count">2017–'+(champions[champions.length-1]?.year||2026)+' ARCHIVE</span></div><div class="hall-champion-grid">'+championCards+'</div></section><section class="hall-record-section"><div class="hall-section-heading"><div class="hall-manager-heading"><span class="hall-kicker">THE LEAGUE</span><h2>Managers</h2><label class="hall-sort-control">SORT BY <select id="hall-manager-sort" aria-label="Sort managers"><option value="winPct" selected>Win %</option><option value="championships">Championships</option><option value="playoffs">Playoff Appearances</option></select></label></div><span class="hall-count">'+managers.length+' FRANCHISES</span></div>'+dataSummary+'<div class="hall-manager-grid" id="hall-manager-grid">'+managers.map((name,i)=>makeCard(name,i,retired.includes(name))).join("")+'</div></section><section class="hall-record-section hall-record-book"><div class="hall-section-heading"><div><span class="hall-kicker">THE RECORD BOOK</span><h2>League Records</h2></div><span class="hall-count">ALL-TIME BESTS</span></div><div class="hall-record-grid">'+recordCards+'</div><div class="hall-history-notes">'+diagnostic+errorNote+'<p class="hall-footnote">Records include completed regular-season head-to-head matchups and playoff games with available scores. Highest scoring season uses regular-season points. Median matchups are excluded from matchup records. Pre-Sleeper seasons played are counted only where postseason participation is documented.</p></div></section>';
 const managerSort=$("hall-manager-sort"),managerGrid=$("hall-manager-grid");
 if(managerSort&&managerGrid)managerSort.addEventListener("change",()=>{sortManagers(managerSort.value);managerGrid.innerHTML=managers.map((name,i)=>makeCard(name,i,retired.includes(name))).join("");managerGrid.querySelectorAll(".hall-flip-card").forEach(card=>card.addEventListener("click",()=>{const flipped=card.classList.toggle("is-flipped");card.setAttribute("aria-expanded",String(flipped));}));});
 target.querySelectorAll(".hall-flip-card").forEach(card=>card.addEventListener("click",()=>{
  const flipped=card.classList.toggle("is-flipped");
  card.setAttribute("aria-expanded",String(flipped));
 }));
 target.querySelectorAll("[data-hall-year]").forEach(card=>card.addEventListener("click",()=>openHallSeasonPage(Number(card.dataset.hallYear))));
}

function renderAwards(){
 const target=$("awards-content");if(!target||target.dataset.ready==="yes")return;
 const count=AWARDS_2025.reduce((n,a)=>n+a.nominees.length,0);
 const managerLabel=name=>AWARD_TEAM_MANAGERS[name]?' <span class="award-team-manager">· '+escapeHtml(AWARD_TEAM_MANAGERS[name])+'</span>':'';
 target.innerHTML='<div class="awards-intro"><span class="award-kicker">2025 SEASON · LEAGUE VOTING</span><strong>THE MONKEY BOYS AWARDS</strong><p>Last season’s nominees, with the league’s selected winners highlighted.</p><div class="awards-summary"><span><b>15</b> AWARDS</span><span><b>15</b> WINNERS</span><span><b>'+count+'</b> NOMINEES</span></div></div><div class="awards-grid">'+AWARDS_2025.map((a,i)=>{const teamAward=a.category==="Best Team Name"||a.category==="Worst Team Name";return '<article class="award-card"><div class="award-card-top"><span class="award-number">'+String(i+1).padStart(2,"0")+'</span><span class="award-category">'+escapeHtml(a.category)+'</span></div><div class="award-winner"><span class="award-kicker">2025 WINNER</span><strong>'+escapeHtml(a.winner)+(teamAward?managerLabel(a.winner):'')+'</strong><p>'+escapeHtml(a.detail)+'</p></div><details class="award-nominees"><summary><span>VIEW ALL NOMINEES</span><b>'+a.nominees.length+'</b></summary><ol>'+a.nominees.map(n=>{const teamName=n;return '<li class="'+((n.toLowerCase().includes(a.winner.toLowerCase())||(a.winner==='Kevin'&&n.startsWith('Kev ')))?'selected':'')+'">'+escapeHtml(n)+(teamAward?managerLabel(teamName):'')+'</li>';}).join("")+'</ol></details></article>';}).join("")+'</div>';
 target.dataset.ready="yes";
}

const PARLAY_PLAYER_ALIASES = {
 "loveland":"Colston Loveland","lamar":"Lamar Jackson","saquon":"Saquon Barkley","ja'marr chase":"Ja'Marr Chase","jamarr chase":"Ja'Marr Chase","amon ra":"Amon-Ra St. Brown","amon-ra":"Amon-Ra St. Brown","omarion hampton":"Omarion Hampton","kenneth walker":"Kenneth Walker III","ken walker":"Kenneth Walker III","javonte williams":"Javonte Williams","javonte":"Javonte Williams","jayden daniels":"Jayden Daniels","zay flowers":"Zay Flowers","bucky irving":"Bucky Irving","bucky":"Bucky Irving","mike evans":"Mike Evans","derrick henry":"Derrick Henry","jeanty":"Ashton Jeanty","drake maye":"Drake Maye","bijan":"Bijan Robinson","etienne":"Travis Etienne","cmc":"Christian McCaffrey","ceedee":"CeeDee Lamb","cee dee":"CeeDee Lamb","terrance ferguson":"Terrance Ferguson","stafford":"Matthew Stafford","jaylen warren":"Jaylen Warren","chuba":"Chuba Hubbard","nabers":"Malik Nabers","goff":"Jared Goff","wicks":"Dontayvion Wicks","josh downs":"Josh Downs","aaron jones":"Aaron Jones","jordan addison":"Jordan Addison","monty":"David Montgomery","david montgomery":"David Montgomery","kyren williams":"Kyren Williams","kyren":"Kyren Williams","michael wilson":"Michael Wilson","trey mcbride":"Trey McBride","laporta":"Sam LaPorta","deshaun watson":"Deshaun Watson","chase brown":"Chase Brown","tyler higbee":"Tyler Higbee","tucker kraft":"Tucker Kraft","xavier worthy":"Xavier Worthy","dallas goedert":"Dallas Goedert","cam skattebo":"Cam Skattebo","drake london":"Drake London","bryce young":"Bryce Young","jalen coker":"Jalen Coker","dk metcalf":"DK Metcalf","dk":"DK Metcalf","brock bowers":"Brock Bowers","jj mccarthy":"J.J. McCarthy","joe burrow":"Joe Burrow","george kittle":"George Kittle","diggs":"Stefon Diggs","jonah coleman":"Jonah Coleman","omar cooper":"Omar Cooper","rashee":"Rashee Rice","ollie gordon":"Ollie Gordon II","antonio williams":"Antonio Williams","rome odunze":"Rome Odunze","jonathan taylor":"Jonathan Taylor","tuten":"Bhayshul Tuten","emmett johnson":"Emmett Johnson","tee higgins":"Tee Higgins","justin herbert":"Justin Herbert","justin jefferson":"Justin Jefferson","kyle mccord":"Kyle McCord","jacoby brissett":"Jacoby Brissett","christian watson":"Christian Watson","breece hall":"Breece Hall","josh allen":"Josh Allen","keenan allen":"Keenan Allen","jaylen waddle":"Jaylen Waddle","jordan mason":"Jordan Mason","puka":"Puka Nacua","cam ward":"Cam Ward","kyle monangai":"Kyle Monangai","parker washington":"Parker Washington","isaiah likely":"Isaiah Likely","tony pollard":"Tony Pollard"
};
const PARLAY_TEAM_ALIASES = {
 "eagles":"Philadelphia Eagles","bengals":"Cincinnati Bengals","giants":"New York Giants","cardinals":"Arizona Cardinals","patriots":"New England Patriots","pats":"New England Patriots","chiefs":"Kansas City Chiefs","bills":"Buffalo Bills","lions":"Detroit Lions"
};
const PARLAY_PLAYER_ID_OVERRIDES = { "lamar jackson": "4881", "justin jefferson": "6794", "kenneth walker iii": "8151", "josh allen": "4984", "antonio williams": "13301", "jaylen waddle": "7526" };
function normalizeParlayPlayerName(value){
 return String(value||"").toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv|v)\.?\b/g,"")
  .replace(/[^a-z0-9]+/g," ")
  .trim()
  .replace(/\s+/g," ");
}
const PARLAY_PLAYER_INDEX = new WeakMap();
const PARLAY_TEAM_ABBR = {eagles:"PHI",bengals:"CIN",giants:"NYG",cardinals:"ARI",patriots:"NE",pats:"NE",chiefs:"KC",bills:"BUF",lions:"DET"};
function normalizeParlayStats(value){
 let source=value;
 if(source&&typeof source==="object"&&!Array.isArray(source)&&!source.player_id&&!source.id){
  for(const key of ["stats","players","data","results"]){
   const candidate=source[key];
   if(candidate&&typeof candidate==="object"&&(Array.isArray(candidate)||Object.keys(candidate).length)){
    source=candidate;break;
   }
  }
 }
 const normalized={};
 const add=(id,row)=>{
  const key=String(id??"");
  if(!key||!row||typeof row!=="object")return;
  const nested=row.stats&&typeof row.stats==="object"?row.stats:{};
  normalized[key]={...row,...nested};
 };
 if(Array.isArray(source)){
  for(const row of source)add(row?.player_id??row?.playerId??row?.id,row);
 }else if(source&&typeof source==="object"){
  for(const [sourceId,row] of Object.entries(source)){
   if(!row||typeof row!=="object")continue;
   // Sleeper's stats response is keyed by player ID. Preserve that key even
   // when a row also contains a different player_id/id field.
   add(sourceId,row);
   if(row.player_id!=null)add(row.player_id,row);
   if(row.playerId!=null)add(row.playerId,row);
   if(row.id!=null)add(row.id,row);
  }
 }
 return normalized;
}
function parlayPlayerEntry(players, fullName){
 if(!players||typeof players!=="object")return null;
 let index=PARLAY_PLAYER_INDEX.get(players);
 if(!index){
  index=new Map();
  const candidatesByName=new Map();
  for(const [id,p] of Object.entries(players)){
   const name=normalizeParlayPlayerName(p.full_name||[p.first_name,p.last_name].filter(Boolean).join(" "));
   if(!name)continue;
   if(!candidatesByName.has(name))candidatesByName.set(name,[]);
   candidatesByName.get(name).push([String(p.player_id||id),p]);
  }
  for(const [name,candidates] of candidatesByName){
   const overrideId=PARLAY_PLAYER_ID_OVERRIDES[name];
   let selected=overrideId?candidates.find(([id])=>id===overrideId):null;
   // Duplicate names exist in Sleeper's directory. If an override ID is not
   // present in this directory snapshot, prefer the known NFL position/team.
   if(!selected&&name==="justin jefferson")selected=candidates.find(([,p])=>String(p.position||"").toUpperCase()==="WR"&&String(p.team||"").toUpperCase()==="MIN");
   if(!selected&&name==="lamar jackson")selected=candidates.find(([,p])=>String(p.position||"").toUpperCase()==="QB"&&String(p.team||"").toUpperCase()==="BAL");
   if(!selected&&!overrideId)selected=candidates[0];
   if(selected)index.set(name,selected);
  }
  PARLAY_PLAYER_INDEX.set(players,index);
 }
 return index.get(normalizeParlayPlayerName(fullName))||null;
}
function parlayStatNumber(stat,key){const value=stat?.[key];return value==null||!Number.isFinite(Number(value))?null:Number(value);}
function parlayPickIdentity(raw){
 const lower=String(raw||"").toLowerCase();
 const team=Object.keys(PARLAY_TEAM_ALIASES).find(name=>lower.includes(name));
 if(team)return {name:PARLAY_TEAM_ALIASES[team],team:true};
 const alias=Object.keys(PARLAY_PLAYER_ALIASES).sort((a,b)=>b.length-a.length).find(name=>lower.includes(name));
 return alias?{name:PARLAY_PLAYER_ALIASES[alias],team:false}:{name:"",team:false};
}
function describeParlayPick(pick){
 const raw=String(pick||"").trim();
 if(!raw||raw==="N/A")return "No selection";
 const identity=parlayPickIdentity(raw),lower=raw.toLowerCase();
 if(identity.team){
  const spread=raw.match(/([+-]\d+(?:\.\d+)?)/);
  return identity.name+" — "+(spread?"Spread: "+spread[1]+" points":"Moneyline");
 }
 const name=identity.name||"Unresolved player";
 if(/yards?\s*\+\s*TD/i.test(raw))return name+" — 90+ rushing yards AND 1+ anytime touchdown";
 if(/pass(?:ing)?\s*(?:TD|touchdowns?)/i.test(raw)){
  const line=raw.match(/\b(O|U)\s*(\d+(?:\.\d+)?)/i)||raw.match(/\b(\d+(?:\.\d+)?)\s*\+/);
  return name+" — "+(line?(line[0].match(/^[OU]/i)?line[1].toUpperCase()+" "+line[2]:line[1]+"+"):"")+" passing touchdowns";
 }
 if(/\bTD\b/i.test(raw))return name+" — Anytime touchdown scorer";
 let type="";
 if(/pass(?:ing)?\s*(?:yards?|yds?)/i.test(raw))type="passing yards";
 else if(/rush(?:ing)?\s*(?:yards?|yds?)/i.test(raw))type="rushing yards";
 else if(/receiv(?:ing)?\s*(?:yards?|yds?)/i.test(raw))type="receiving yards";
 else if(/\brec(?:eptions?)?\b/i.test(raw))type="receptions";
 else if(/rush attempts?/i.test(raw))type="rushing attempts";
 else if(/\bint(?:erceptions?)?\b/i.test(raw))type="interceptions thrown";
 else if(/\byards?\b/i.test(raw)){
  if(/bijan|kenneth walker|ken walker|derrick henry|jaylen warren|jonah coleman/i.test(raw))type="rushing yards";
  else if(/nabers|deshaun watson|lamar|keenan|puka|ceedee|cee dee|jordan addison/i.test(raw))type=/deshaun watson|lamar/i.test(raw)?"passing yards":"receiving yards";
 }
 const line=raw.match(/\b(O|U)\s*(\d+(?:\.\d+)?)/i);
 const plus=raw.match(/\b(\d+(?:\.\d+)?)\s*\+/);
 const bare=raw.match(/\b(\d+(?:\.\d+)?)\s+(?:rush|rushing)\s*yards/i);
 const threshold=line?(line[1].toUpperCase()+" "+line[2]):plus?(plus[1]+"+"):bare?(bare[1]+"+"):"";
 return name+" — "+(threshold?threshold+" ":"")+(type||"Prop needs clarification");
}
function gradeParlayPick(pick,stats,players,schedule,diagnostics={}){
 const raw=String(pick||"").trim();
 if(!raw||raw==="N/A")return {status:"NA",detail:"No pick"};
 const lower=raw.toLowerCase(),identity=parlayPickIdentity(raw);
 if(identity.team){
  const teamAlias=Object.keys(PARLAY_TEAM_ALIASES).find(name=>lower.includes(name));
  const abbr=PARLAY_TEAM_ABBR[teamAlias];
  const event=(schedule?.events||[]).find(ev=>(ev.competitions?.[0]?.competitors||[]).some(c=>String(c.team?.abbreviation||"").toUpperCase()===abbr));
  const comp=event?.competitions?.[0],teams=comp?.competitors||[];
  const team=teams.find(c=>String(c.team?.abbreviation||"").toUpperCase()===abbr),opp=teams.find(c=>c!==team);
  const finalStatus=comp?.status?.type||event?.status?.type||{};
  if(!comp||!team||!opp||!(finalStatus.completed===true||finalStatus.state==="post"||finalStatus.name==="STATUS_FINAL"||event?.status?.type?.completed===true||event?.status?.type?.state==="post"))return {status:"PENDING",detail:"Game not final"};
  const margin=Number(team.score)-Number(opp.score),spread=raw.match(/([+-]\d+(?:\.\d+)?)/),adjusted=margin+(spread?Number(spread[1]):0);
  return {status:adjusted===0?"PUSH":adjusted>0?"HIT":"MISS",detail:team.score+"–"+opp.score+(spread?" · "+(adjusted>0?"covered":"did not cover"):"")};
 }
 if(!identity.name)return {status:"REVIEW",detail:"Player not recognized"};
 if(!players||typeof players!=="object"||!Object.keys(players).length)return {status:"PENDING",detail:diagnostics.playerError?"Player directory request failed: "+diagnostics.playerError:"Sleeper player directory unavailable; use Retry player data below"};
 const playerEntry=parlayPlayerEntry(players,identity.name);
 if(!playerEntry)return {status:"REVIEW",detail:"Player not found in Sleeper directory"};
 const [playerId,player]=playerEntry,stat=stats?.[playerId];
 if(!stat){
  const count=Object.keys(stats||{}).length;
  const detail=diagnostics.statsError
   ?"Stats request failed: "+diagnostics.statsError
   :count
    ?"Stats loaded ("+count+" players), but player ID "+playerId+" was not present"
    :"Stats request returned no player records";
  return {status:"PENDING",detail};
 }
 const rawTeam=String(player.team||player.team_abbr||player.team_abbreviation||"").toUpperCase();
 const playerTeam=({JAC:"JAX",WAS:"WSH",LA:"LAR",BAL:"BAL"}[rawTeam]||rawTeam);
 const teamNames={BAL:"baltimore ravens",JAX:"jacksonville jaguars",LAR:"los angeles rams",WAS:"washington commanders"};
 const game=(schedule?.events||[]).find(ev=>(ev.competitions?.[0]?.competitors||[]).some(c=>{
  const abbreviation=String(c.team?.abbreviation||"").toUpperCase();
  const displayName=String(c.team?.displayName||c.team?.name||"").toLowerCase();
  return abbreviation===playerTeam||(teamNames[playerTeam]&&displayName===teamNames[playerTeam]);
 }));
 const competition=game?.competitions?.[0],competitionStatus=competition?.status?.type||competition?.status||{},eventStatus=game?.status?.type||game?.status||{};
 const finished=Boolean(
  competitionStatus.completed===true||eventStatus.completed===true||
  competitionStatus.state==="post"||eventStatus.state==="post"||
  competitionStatus.name==="STATUS_FINAL"||eventStatus.name==="STATUS_FINAL"||
  competitionStatus.description==="Final"||eventStatus.description==="Final"
 );
 if(!finished)return {status:"PENDING",detail:!schedule?"NFL schedule unavailable":!playerTeam?"Player team unavailable":!game?"No schedule game found for "+playerTeam:"Game status not final ("+String(competitionStatus.state||eventStatus.state||competitionStatus.name||eventStatus.name||"unknown")+")"};
 if(/yards?\s*\+\s*TD/i.test(raw)){
  const yards=parlayStatNumber(stat,"rush_yd"),td=["rush_td","rec_td","def_td","st_td","fum_rec_td"].reduce((sum,key)=>sum+(parlayStatNumber(stat,key)||0),0);
  if(yards==null)return {status:"PENDING",detail:"Rushing yards unavailable"};
  const hit=yards>=90&&td>=1;
  return {status:hit?"HIT":"MISS",detail:yards+" rush yds · "+td+" TD"};
 }
 const passingTd=/pass(?:ing)?\s*(?:TD|touchdowns?)/i.test(raw);
 if(passingTd){
  const overUnder=raw.match(/\b(O|U)\s*(\d+(?:\.\d+)?)/i),plus=raw.match(/\b(\d+(?:\.\d+)?)\s*\+/),threshold=overUnder?Number(overUnder[2]):plus?Number(plus[1]):null;
  if(threshold==null)return {status:"REVIEW",detail:"Passing TD threshold unclear"};
  // Sleeper omits zero-valued counting stats from some player rows.
  const value=parlayStatNumber(stat,"pass_td")??0;
  const push=!plus&&value===threshold,hit=plus?value>=threshold:overUnder[1].toUpperCase()==="U"?value<threshold:value>threshold;
  return {status:push?"PUSH":hit?"HIT":"MISS",detail:value+" pass TD"};
 }
 if(/\bTD\b/i.test(raw)){
  const total=["rush_td","rec_td","def_td","st_td","fum_rec_td"].reduce((sum,key)=>sum+(parlayStatNumber(stat,key)||0),0);
  const multi=raw.match(/\b(\d+)\s*\+?\s*TD/i),needed=multi?Number(multi[1]):1;
  return {status:total>=needed?"HIT":"MISS",detail:total+" TD"};
 }
 const overUnder=raw.match(/\b(O|U)\s*(\d+(?:\.\d+)?)/i),plus=raw.match(/\b(\d+(?:\.\d+)?)\s*\+/),bare=raw.match(/\b(\d+(?:\.\d+)?)\s+(?:rush|rushing)\s*yards/i);
 const threshold=overUnder?Number(overUnder[2]):plus?Number(plus[1]):bare?Number(bare[1]):null;
 if(threshold==null)return {status:"REVIEW",detail:"No clear prop threshold"};
 let key=null,label="";
 if(/pass(?:ing)?\s*(?:yards?|yds?)/i.test(raw)){key="pass_yd";label="PASS YDS"}
 else if(/rush(?:ing)?\s*(?:yards?|yds?)/i.test(raw)){key="rush_yd";label="RUSH YDS"}
 else if(/receiv(?:ing)?\s*(?:yards?|yds?)/i.test(raw)){key="rec_yd";label="REC YDS"}
 else if(/\brec(?:eptions?)?\b/i.test(raw)){key="rec";label="REC"}
 else if(/rush attempts?/i.test(raw)){key="rush_att";label="RUSH ATT"}
 else if(/\bint(?:erceptions?)?\b/i.test(raw)){key="pass_int";label="INT"}
 else if(/\byards?\b/i.test(raw)){
  const position=String(player.position||"").toUpperCase();
  if(position==="QB"){key="pass_yd";label="PASS YDS"}
  else if(position==="RB"){key="rush_yd";label="RUSH YDS"}
  else if(position==="WR"||position==="TE"){key="rec_yd";label="REC YDS"}
  else return {status:"REVIEW",detail:"Yardage type unclear for "+(position||"unknown")+" position"};
 }
 else return {status:"REVIEW",detail:"Prop type not recognized"};
 // Sleeper omits zero-valued counting stats from some player rows.
 // Once the player's game is final, an omitted prop stat is a recorded zero.
 const value=parlayStatNumber(stat,key)??0;
 const hit=plus||bare?value>=threshold:overUnder?.[1].toUpperCase()==="U"?value<threshold:value>threshold;
 const push=!plus&&!bare&&value===threshold;
 return {status:push?"PUSH":hit?"HIT":"MISS",detail:value+" "+label};
}
function summarizeParlayResults(results){
 const statuses=results.filter(r=>r.status!=="NA").map(r=>r.status);
 if(!statuses.length)return "PENDING";
 if(statuses.includes("MISS"))return "MISS";
 if(statuses.includes("REVIEW"))return "REVIEW";
 if(statuses.every(status=>status==="HIT"||status==="PUSH"))return "HIT";
 return "PENDING";
}
async function loadParlayWeek(week){
 if((state.parlayDataByWeek[week]?.loaded&&!state.parlayDataByWeek[week]?.playerError)||state.parlayDataByWeek[week]?.loading)return;
 state.parlayDataByWeek[week]={loading:true};
 const season=state.league?.season||String(new Date().getFullYear());
 let statsError=null;
 const [stats,schedule,playerResult]=await Promise.all([
  fetchJson("/api/sleeper-stats/regular/"+season+"/"+week,{attempts:1,timeoutMs:18000}).catch(error=>{statsError=error?.message||String(error);console.warn("Parlay Sleeper stats unavailable for week "+week,error);return null;}),
  fetchJson("/api/nfl-schedule?seasontype=2&week="+week+"&year="+encodeURIComponent(season),{attempts:1,timeoutMs:18000}).catch(error=>{console.warn("Parlay NFL schedule unavailable for week "+week,error);return null;}),
  loadSleeperPlayers().then(players=>({players,error:null})).catch(error=>{const message=error?.message||String(error);console.error("Parlay player directory request failed",error);return {players:{},error:message};})
 ]);
 const normalizedStats=normalizeParlayStats(stats);
 state.parlayDataByWeek[week]={loaded:true,stats:normalizedStats,statsError,schedule:schedule||null,players:playerResult.players||{},playerError:playerResult.error};
}
function renderParlays(){
 const target=$("parlays-content");if(!target)return;
 const weeks=PARLAY_WEEKS.map((row,i)=>{
  const week=i+1,data=state.parlayDataByWeek[week]||{};
  const picks=row.flatMap((managerPicks,j)=>(Array.isArray(managerPicks)?managerPicks:[managerPicks]).map(pick=>({manager:PARLAY_MANAGERS[j],pick,result:pick&&pick!=="N/A"?gradeParlayPick(pick,data.stats,data.players,data.schedule,data):{status:"NA"}})))
    .filter(item=>item.pick&&item.pick!=="N/A");
  return {week,row,picks,placer:PARLAY_PLACERS[i]||"Not assigned"};
 }).filter(item=>item.picks.length);
 const totalPicks=weeks.reduce((n,w)=>n+w.picks.length,0);
 const settledPicks=weeks.reduce((n,w)=>n+w.picks.filter(p=>["HIT","MISS","PUSH"].includes(p.result.status)).length,0);
 const totalHits=weeks.reduce((n,w)=>n+w.picks.filter(p=>p.result.status==="HIT").length,0);
 const memberRecords=PARLAY_MANAGERS.map(manager=>{
  const picks=weeks.flatMap(w=>w.picks.filter(p=>p.manager===manager));
  const hits=picks.filter(p=>p.result.status==="HIT").length;
  const misses=picks.filter(p=>p.result.status==="MISS").length;
  const pushes=picks.filter(p=>p.result.status==="PUSH").length;
  const pending=picks.filter(p=>["PENDING","REVIEW"].includes(p.result.status)).length;
  const graded=hits+misses;
  return {manager,picks:picks.length,hits,misses,pushes,pending,rate:graded?hits/graded:-1};
 }).sort((a,b)=>b.rate-a.rate||b.hits-a.hits||a.misses-b.misses||a.manager.localeCompare(b.manager));
 target.innerHTML=
  '<div class="parlay-summary"><div><span class="parlay-kicker">2026 SEASON</span><strong>'+weeks.length+'</strong><small>WEEKS WITH PICKS</small></div><div><span class="parlay-kicker">LEAGUE PICKS</span><strong>'+totalPicks+'</strong><small>RECORDED SELECTIONS</small></div><div><span class="parlay-kicker">CORRECT PICKS</span><strong>'+totalHits+'</strong><small>'+settledPicks+' SETTLED</small></div></div>'+
  '<div class="parlay-dashboard"><section class="parlay-weeks-panel"><div class="parlay-panel-heading"><span class="parlay-kicker">WEEK BY WEEK</span><h2>Parlay History</h2></div>'+
  '<div class="parlay-week-list">'+weeks.map(({week,picks,placer})=>{
   const hits=picks.filter(p=>p.result.status==="HIT").length;
   const misses=picks.filter(p=>p.result.status==="MISS").length;
   const pushes=picks.filter(p=>p.result.status==="PUSH").length;
   const pending=picks.filter(p=>["PENDING","REVIEW"].includes(p.result.status)).length;
   const denominator=picks.length;
   return '<details class="parlay-week-dropdown"><summary><span class="parlay-week-label"><b>WEEK '+String(week).padStart(2,"0")+'</b><small>'+escapeHtml(placer==='Not assigned'?'':('PLACED BY '+placer.toUpperCase()))+'</small></span><span class="parlay-week-record"><strong>'+hits+'/'+denominator+'</strong><small>CORRECT</small></span><span class="parlay-chevron" aria-hidden="true">⌄</span></summary>'+
    '<div class="parlay-week-details"><div class="parlay-detail-meta"><span>'+hits+' HIT · '+misses+' MISS'+(pushes?' · '+pushes+' PUSH':'')+(pending?' · '+pending+' PENDING':'')+'</span><span>$5 LEAGUE PARLAY</span></div>'+
    '<div class="parlay-pick-list">'+picks.map(({manager,pick,result})=>
     '<div class="parlay-pick"><span class="parlay-manager">'+escapeHtml(manager)+'</span><span class="parlay-selection"><strong>'+escapeHtml(describeParlayPick(pick))+'</strong></span><span class="parlay-result '+result.status.toLowerCase()+'">'+result.status+(result.detail?'<small>'+escapeHtml(result.detail)+'</small>':"")+'</span></div>'
    ).join("")+'</div></div></details>';
  }).join("")+'</div></section>'+
  '<aside class="parlay-members-panel"><div class="parlay-panel-heading"><span class="parlay-kicker">LEAGUE LEADERBOARD</span><h2>Pick Performance</h2><p>Ranked by hit rate on settled picks. Pushes and pending picks are excluded from the rate.</p></div>'+
  '<div class="parlay-member-list">'+memberRecords.map((m,i)=>
   '<div class="parlay-member-row"><span class="parlay-member-rank">'+String(i+1).padStart(2,"0")+'</span><span class="parlay-member-name"><strong>'+escapeHtml(m.manager)+'</strong><small>'+m.hits+' HIT · '+m.misses+' MISS'+(m.pushes?' · '+m.pushes+' PUSH':'')+(m.pending?' · '+m.pending+' PENDING':'')+'</small></span><span class="parlay-member-record"><strong>'+m.hits+'/'+m.picks+'</strong><small>'+ (m.rate>=0?Math.round(m.rate*100)+'%':'—')+'</small></span></div>'
  ).join("")+'</div></aside></div>';
 if(!state.parlayHistoryStarted){
  state.parlayHistoryStarted=true;
  state.parlayHistoryLoading=true;
  (async()=>{
   try {
    for(let start=1;start<=11;start+=3){
     await Promise.all(Array.from({length:Math.min(3,12-start)},(_,j)=>loadParlayWeek(start+j)));
     if(!$("parlays-content")?.hidden)renderParlays();
    }
   } finally {
    state.parlayHistoryLoading=false;
    if(!$("parlays-content")?.hidden)renderParlays();
   }
  })();
 }
 const failedDirectoryWeeks=Object.entries(state.parlayDataByWeek).filter(([,data])=>data?.playerError).map(([week])=>Number(week));
 if(failedDirectoryWeeks.length){
  const retry=document.createElement("button");
  retry.type="button";retry.className="parlay-retry-button";retry.dataset.parlayRetry="yes";
  retry.textContent="RETRY PLAYER DATA";
  retry.addEventListener("click",async()=>{
   retry.disabled=true;retry.textContent="RETRYING…";
   await Promise.all(failedDirectoryWeeks.map(week=>loadParlayWeek(week)));
   renderParlays();
  });
  target.prepend(retry);
 }
 target.dataset.ready="yes";
}

function setupNavigation() {
  const tabs = [...document.querySelectorAll(".nav-tab")];
  const panels = [...document.querySelectorAll(".tab-panel")];
  function activateTab(target, options = {}) {
    const tab = tabs.find(item => item.dataset.tab === target);
    if (!tab) return;
    tabs.forEach(item => item.classList.toggle("active", item === tab));
    panels.forEach(panel => {
      panel.hidden = panel.dataset.panel !== target;
    });
    // Season detail is appended outside the tab panels, so explicitly hide it
    // whenever navigation leaves the Hall of Fame view.
    const seasonPage = document.getElementById("hall-season-page");
    if (seasonPage) seasonPage.hidden = true;
    if (target === "rules") renderRules();
    if (target === "schedule") renderSchedule();
    if (target === "playoffs") { if (!$("playoff-predictor-content")?.dataset.ready) loadPlayoffEditions(); renderScheduleComparison(); }
    if (target === "matchups") renderMatchups(state.matchupWeek);
    if (target === "hall") renderHallOfFame();
    if (target === "parlays") renderParlays();
    if (target === "lottery") renderLotteryHistory();
    if (target === "rankings") renderPowerRankings(state.selectedRankingWeek ?? getDefaultRankingEdition());
    if (options.updateUrl) {
      const nextHash = "#" + target;
      if (window.location.hash !== nextHash) history.replaceState(null, "", nextHash);
    }
    if (options.scroll) window.scrollTo({top:0,behavior:"smooth"});
  }
  tabs.forEach(tab => tab.addEventListener("click", () => {
    activateTab(tab.dataset.tab, { updateUrl: true, scroll: true });
  }));
  const initialTab = window.location.hash.replace(/^#/, "");
  const seasonRoute=initialTab.match(/^season-(\d{4})$/);
  if(seasonRoute){activateTab("hall");openHallSeasonPage(Number(seasonRoute[1]),false);}
  else activateTab(tabs.some(tab => tab.dataset.tab === initialTab) ? initialTab : "league");
  window.addEventListener("popstate",()=>{const route=window.location.hash.replace(/^#/, "").match(/^season-(\d{4})$/);if(route)openHallSeasonPage(Number(route[1]),false);else if(window.location.hash==="#hall")activateTab("hall");});
}
setupNavigation();
const ppMedianToggle=$("pp-include-median");
if(ppMedianToggle)ppMedianToggle.addEventListener("change",renderScheduleComparison);

init();