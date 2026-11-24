import fs from "node:fs";
import path from "node:path";

// Shared, deterministic weekly edition publisher.
const LEAGUE_ID = "1313563024161787904";
const SEASON = "2026";
const SIMULATIONS = 100000;
const SD = 20;
const BASE = "https://api.sleeper.com";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const MANAGERS = { khogan99:"Kevin", marcd9:"Marc", cjmyers210:"Colby", tajbhall:"Ben", itsdonk:"Brandon", turtmonk:"Evan", pgdoyle5:"Pat", joeysolomon:"Joey", abutta31:"Butta", lee2222:"Lee", dersnation:"Ders", tanzi14:"Tanz" };
const outDir = "data/playoff-editions";
const get = async (url) => {
  const response = await fetch(url, { headers: { "User-Agent": "MonkeyBoysFantasySite/1.0", "Accept": "application/json" } });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response.json();
};
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const normalizeTeam = value => ({ JAC:"JAX", LA:"LAR", WSH:"WAS" }[String(value || "").toUpperCase()] || String(value || "").toUpperCase());
function gaussian(random) {
  const u = Math.max(1e-9, random()), v = random();
  return SD * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function accepts(slot, positions) {
  const s = String(slot || "").toUpperCase();
  if (["QB","RB","WR","TE"].includes(s)) return positions.has(s);
  if (["FLEX","WRRB_FLEX","REC_FLEX"].includes(s)) return ["RB","WR","TE"].some(p => positions.has(p));
  if (["SUPER_FLEX","SUPERFLEX","SFLX"].includes(s)) return ["QB","RB","WR","TE"].some(p => positions.has(p));
  return false;
}
function bestLineup(ids, players, projectionMap, slots, byes, waiverPool) {
  const pool = [...new Set(ids.map(String))].map(id => {
    const p = players[id] || {};
    const positions = new Set((p.fantasy_positions?.length ? p.fantasy_positions : [p.position]).filter(Boolean).map(x => String(x).toUpperCase()));
    return { id, positions, points: n(projectionMap.get(id)?.stats?.pts_half_ppr), bye: byes.has(normalizeTeam(p.team)) };
  }).filter(p => p.positions.size && !p.bye);
  const gaps = slots.map((slot,i)=>({slot,i})).filter(x => !pool.some(p=>accepts(x.slot,p.positions)));
  const orderedGaps = gaps.sort((a,b)=>waiverPool.filter(p=>accepts(a.slot,p.positions)).length-waiverPool.filter(p=>accepts(b.slot,p.positions)).length);
  const additions=[], used=new Set();
  for (const gap of orderedGaps) { const candidate=waiverPool.find(p=>!used.has(p.id)&&accepts(gap.slot,p.positions)); if(candidate){ additions.push(candidate); used.add(candidate.id); } }
  const candidates=[...pool,...additions];
  const ordered=slots.map((slot,i)=>({slot,i})).sort((a,b)=>candidates.filter(p=>accepts(a.slot,p.positions)).length-candidates.filter(p=>accepts(b.slot,p.positions)).length);
  const memo=new Map();
  function solve(i,mask) {
    if(i===ordered.length)return 0;
    const key=i+":"+mask; if(memo.has(key))return memo.get(key);
    let best=solve(i+1,mask);
    for(let j=0;j<candidates.length;j++){const bit=1<<j;if((mask&bit)||!accepts(ordered[i].slot,candidates[j].positions))continue;best=Math.max(best,candidates[j].points+solve(i+1,mask|bit));}
    memo.set(key,best); return best;
  }
  return solve(0,0);
}
function isFinal(event) {
  const c=event.competitions?.[0], s=c?.status?.type || event.status?.type || {};
  return s.completed===true || s.state==="post" || s.name==="STATUS_FINAL";
}
function scheduleByes(schedule) {
  const nfl=["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB","HOU","IND","JAX","KC","LV","LAC","LAR","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SF","SEA","TB","TEN","WAS"];
  const playing=new Set((schedule.events||[]).flatMap(e=>(e.competitions?.[0]?.competitors||[]).map(c=>normalizeTeam(c.team?.abbreviation))));
  return new Set(nfl.filter(t=>!playing.has(t)));
}
function standings(teams, matchups, completed) {
  const rows=teams.map(t=>({id:t.id,name:t.name,w:0,l:0,t:0,pf:0})), byId=new Map(rows.map(x=>[x.id,x]));
  for(let week=1;week<=completed;week++){
    const games=matchups[week]||[], valid=games.filter(m=>n(m.points)>0);
    if(valid.length!==teams.length)throw new Error("Incomplete fantasy scoring data in Week "+week);
    const scores=valid.map(m=>n(m.points)).sort((a,b)=>a-b), median=(scores[5]+scores[6])/2, groups=new Map();
    for(const m of valid){const t=byId.get(Number(m.roster_id));if(!t)continue;const p=n(m.points);t.pf+=p;if(p>median)t.w++;else if(p<median)t.l++;else t.t++;if(m.matchup_id!=null){const key=String(m.matchup_id);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(m);}}
    for(const g of groups.values()){if(g.length!==2)continue;const a=byId.get(Number(g[0].roster_id)),b=byId.get(Number(g[1].roster_id));if(!a||!b)continue;if(n(g[0].points)>n(g[1].points))a.w++,b.l++;else if(n(g[0].points)<n(g[1].points))b.w++,a.l++;else a.t++,b.t++;}
  }
  return rows;
}
function matchupMap(rows, week, teamCount) {
  const groups=new Map();
  for(const m of rows){if(m.matchup_id==null)continue;const key=String(m.matchup_id);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(Number(m.roster_id));}
  const valid=[...groups.values()].filter(g=>g.length===2);
  if(valid.length!==teamCount/2)throw new Error("Week "+week+" matchup schedule is incomplete.");
  const map=new Map();for(const [a,b] of valid){map.set(a,b);map.set(b,a);}return map;
}
async function main() {
  const league=await get(`https://api.sleeper.app/v1/league/${LEAGUE_ID}`);
  const regular=Math.max(1,n(league.settings?.playoff_week_start)||15)-1;
  const [users,rosters,players,nflState]=await Promise.all([
    get(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/users`),
    get(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`),
    get("https://api.sleeper.app/v1/players/nfl"),
    get("https://api.sleeper.app/v1/state/nfl")
  ]);
  const userById=new Map(users.map(u=>[String(u.user_id),u]));
  const teams=rosters.map(r=>{const owner=userById.get(String(r.owner_id));const username=String(owner?.username||"").toLowerCase(),display=String(owner?.display_name||"").toLowerCase();return {id:Number(r.roster_id),name:MANAGERS[username]||MANAGERS[display]||("Manager "+r.roster_id),roster:r};}).sort((a,b)=>a.id-b.id);
  if(teams.length!==12)throw new Error("Expected 12 league teams; found "+teams.length);
  const matchups={};
  for(let w=1;w<=regular;w++)matchups[w]=await get(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/${w}`);
  let completed=0;
  for(let w=1;w<=regular;w++){
    const rows=matchups[w]||[];
    if(rows.length!==teams.length||rows.some(m=>!Number.isFinite(Number(m.points))||n(m.points)<=0))break;
    const scoreboard=await get(`${ESPN}?seasontype=2&week=${w}&year=${SEASON}`);
    const events=scoreboard.events||[];
    if(!events.length||events.some(e=>!isFinal(e)))break;
    completed=w;
  }
  if(completed===0){console.log("No fully completed fantasy week yet; nothing to publish.");return;}
  fs.mkdirSync(outDir,{recursive:true});
  const indexPath=path.join(outDir,"index.json");
  const index=fs.existsSync(indexPath)?JSON.parse(fs.readFileSync(indexPath,"utf8")):{season:SEASON,editions:[]};
  const latest=Math.max(0,...index.editions.map(e=>Number(e.week)||0));
  if(completed<=latest){console.log(`Week ${completed} is already published (latest ${latest}); no new edition.`);return;}
  const actual=standings(teams,matchups,completed),actualById=new Map(actual.map(t=>[t.id,t]));
  const future=Array.from({length:regular-completed},(_,i)=>completed+i+1);
  const maxWins=new Map(teams.map(t=>[t.id,actualById.get(t.id).w+future.length*2]));
  const mathematicalStatus=new Map(teams.map(team=>{
    const own=actualById.get(team.id),maxOwn=maxWins.get(team.id);
    const opponents=teams.filter(other=>other.id!==team.id).map(other=>actualById.get(other.id));
    const eliminated=opponents.filter(other=>other.w>maxOwn).length>=6;
    const canFinishAhead=opponents.filter(other=>other.w+future.length*2>=own.w).length;
    return [team.id,{eliminated,playoffsClinched:!eliminated&&canFinishAhead<6,byeClinched:!eliminated&&canFinishAhead<2,firstPlaceClinched:!eliminated&&canFinishAhead===0,actualWins:own.w,actualPf:own.pf}];
  }));
  const rostered=new Set(rosters.flatMap(r=>[...(r.players||[]),...(r.reserve||[])].map(String)));
  const slots=(league.roster_positions||[]).filter(s=>!["BN","IR"].includes(String(s).toUpperCase()));
  const weekly=new Map(), opponents=new Map();
  for(const week of future){
    const [raw,schedule]=await Promise.all([
      get(`${BASE}/projections/nfl/${SEASON}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=pts_half_ppr`),
      get(`${ESPN}?seasontype=2&week=${week}&year=${SEASON}`)
    ]);
    const rows=Array.isArray(raw)?raw:(raw?.data||raw?.projections||[]);
    const projectionMap=new Map(rows.map(r=>[String(r.player_id??r.player?.player_id??""),r]).filter(([id])=>id));
    if(!projectionMap.size)throw new Error("Sleeper projections unavailable for Week "+week);
    const byes=scheduleByes(schedule);
    const waiver=[...projectionMap.entries()].filter(([id])=>!rostered.has(id)).map(([id,row])=>{const p=players[id]||{};const positions=new Set((p.fantasy_positions?.length?p.fantasy_positions:[p.position]).filter(Boolean).map(x=>String(x).toUpperCase()));return {id,positions,points:n(row?.stats?.pts_half_ppr),bye:byes.has(normalizeTeam(p.team))};}).filter(p=>p.positions.size&&!p.bye&&p.points>0).sort((a,b)=>b.points-a.points);
    const means=new Map();
    for(const team of teams){const r=team.roster,ids=[...(r.players||[]),...(r.reserve||[])];means.set(team.id,bestLineup(ids,players,projectionMap,slots,byes,waiver));}
    weekly.set(week,means);
    opponents.set(week,matchupMap(matchups[week]||[],week,teams.length));
  }
  const random=makeRandom(20260000+completed*7919);
  const accum=new Map(teams.map(t=>[t.id,{playoffs:0,bye:0,lastPlace:0,seeds:Array(12).fill(0),wins:0,losses:0,pf:0}]));
  for(let sim=0;sim<SIMULATIONS;sim++){
    const w=new Map(teams.map(t=>[t.id,actualById.get(t.id).w]));
    const l=new Map(teams.map(t=>[t.id,actualById.get(t.id).l]));
    const tiebreak=new Map(teams.map(t=>[t.id,actualById.get(t.id).t]));
    const pf=new Map(teams.map(t=>[t.id,actualById.get(t.id).pf]));
    for(const week of future){
      const scores=new Map();
      for(const team of teams)scores.set(team.id,Math.max(0,weekly.get(week).get(team.id)+gaussian(random)));
      const ordered=[...scores.values()].sort((a,b)=>a-b),median=(ordered[5]+ordered[6])/2;
      for(const team of teams){const score=scores.get(team.id),opp=scores.get(opponents.get(week).get(team.id));pf.set(team.id,pf.get(team.id)+score);if(score>median)w.set(team.id,w.get(team.id)+1);else if(score<median)l.set(team.id,l.get(team.id)+1);else tiebreak.set(team.id,tiebreak.get(team.id)+1);if(score>opp)w.set(team.id,w.get(team.id)+1);else if(score<opp)l.set(team.id,l.get(team.id)+1);else tiebreak.set(team.id,tiebreak.get(team.id)+1);}
    }
    const sorted=teams.map(team=>({id:team.id,w:w.get(team.id),pf:pf.get(team.id)})).sort((a,b)=>b.w-a.w||b.pf-a.pf);
    sorted.forEach((r,i)=>accum.get(r.id).seeds[i]++);
    sorted.slice(0,6).forEach(r=>accum.get(r.id).playoffs++);
    sorted.slice(0,2).forEach(r=>accum.get(r.id).bye++);
     accum.get(sorted[11].id).lastPlace++;
    for(const team of teams){const a=accum.get(team.id);a.wins+=w.get(team.id);a.losses+=l.get(team.id);a.pf+=pf.get(team.id)-actualById.get(team.id).pf;}
  }
  const results=teams.map(team=>{
    const a=accum.get(team.id),seedIndex=a.seeds.indexOf(Math.max(...a.seeds)),actualRow=actualById.get(team.id);
    const status=mathematicalStatus.get(team.id);\n    return {rosterId:team.id,manager:team.name,odds:status.eliminated?0:a.playoffs/SIMULATIONS*100,byeOdds:a.bye/SIMULATIONS*100,lastPlaceOdds:a.lastPlace/SIMULATIONS*100,actualWins:status.actualWins,actualPf:status.actualPf,mathematicallyEliminated:status.eliminated,playoffsClinched:status.playoffsClinched,byeClinched:status.byeClinched,firstPlaceClinched:status.firstPlaceClinched,record:(a.wins/SIMULATIONS).toFixed(1)+"–"+(a.losses/SIMULATIONS).toFixed(1),pf:actualRow.pf+a.pf/SIMULATIONS,seed:seedIndex+1,seedPct:a.seeds[seedIndex]/SIMULATIONS*100,eliminated:status.eliminated};
  }).sort((a,b)=>b.odds-a.odds||b.pf-a.pf);
  const edition={season:SEASON,week:completed,publishedAt:new Date().toISOString(),simulations:SIMULATIONS,standardDeviation:SD,regularSeasonWeeks:regular,results};
  const filename=`week-${String(completed).padStart(2,"0")}.json`;
  fs.writeFileSync(path.join(outDir,filename),JSON.stringify(edition,null,2)+"\n");
  index.season=SEASON;index.editions=[...index.editions.filter(e=>Number(e.week)!==completed),{week:completed,publishedAt:edition.publishedAt,file:filename}].sort((a,b)=>a.week-b.week);
  fs.writeFileSync(indexPath,JSON.stringify(index,null,2)+"\n");
  console.log(`Published Week ${completed}: ${SIMULATIONS.toLocaleString()} simulations, SD ${SD}. ${filename}`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
