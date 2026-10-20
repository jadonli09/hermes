// Presentation-only reconciliation: never rewrite the source spreadsheet.
import { normalizeDate } from '../sheets-writer.js';
import { canonicalPostUrl } from '../automation/state.js';
const norm = x => String(x || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const generic = new Set('weekly monthly annual regular general informational a an the for all our club meeting event activity mandatory participants to learn about happening during on in at of and this next friday monday tuesday wednesday thursday lunch school'.split(' '));
const clubKey = x => String(x || '').trim().toLowerCase();
const words = x => norm(x).split(' ').filter(Boolean);
const compatible = (a,b) => !norm(a) || !norm(b) || norm(a) === norm(b);

export function samePresentationEvent(a,b) {
  if (!clubKey(a.club_name) || clubKey(a.club_name) !== clubKey(b.club_name)) return false;
  if (!a.event_date || normalizeDate(a.event_date) !== normalizeDate(b.event_date)) return false;
  if (!compatible(a.event_time,b.event_time) || !compatible(a.location,b.location)) return false;
  // A shared explicit room is required: unknown locations are not evidence.
  if (!norm(a.location) || !norm(b.location)) return false;
  const types = [norm(a.event_type),norm(b.event_type)].filter(x=>x && x !== 'event' && x !== 'other');
  if (new Set(types).size > 1) return false;
  // Exact-row reviewed links can reconcile differently worded captions.
  // Date, club, explicit room, compatible source times and types still gate it.
  if (a.reviewed_correction && b.reviewed_correction && a.reviewed_event_group &&
      a.reviewed_event_group === b.reviewed_event_group) return true;
  const aa = words(a.description), bb = words(b.description);
  const [short,long] = aa.length <= bb.length ? [aa,bb] : [bb,aa];
  // Only a contiguous event title, not a bag-of-words similarity score.
  // Require distinctive wording and at least two title words. Generic
  // "club meeting" and "mandatory meeting" never identify an event.
  if (short.length < 2 || !short.some(w=>!generic.has(w))) return false;
  const title = short.join(' '), text = long.join(' ');
  return (` ${text} `).includes(` ${title} `);
}

export function consolidateEvents(events) {
  // Form candidate components first. Merge only complete pairwise matches;
  // ambiguous bridges must not select a session based on source row order.
  const remaining=new Set(events.map((_,i)=>i)), groups=[];
  while(remaining.size) {
    const first=remaining.values().next().value, component=[first];
    remaining.delete(first);
    for(let p=0;p<component.length;p++) {
      for(const i of [...remaining]) if(samePresentationEvent(events[component[p]],events[i])) {
        component.push(i);remaining.delete(i);
      }
    }
    const group=component.map(i=>events[i]);
    if(group.every((a,i)=>group.every((b,j)=>i===j || samePresentationEvent(a,b)))) groups.push(group);
    else groups.push(...group.map(e=>[e]));
  }
  return groups.map(group=>{
    const ranked=[...group].sort((a,b)=>(Boolean(b.event_time)+Boolean(b.location))-(Boolean(a.event_time)+Boolean(a.location)) || String(b.description||'').length-String(a.description||'').length);
    const best={...ranked[0]};
    best.event_time=ranked.find(e=>String(e.event_time||'').trim())?.event_time || '';
    best.location=ranked.find(e=>String(e.location||'').trim())?.location || '';
    return {...best, source_urls:[...new Set(group.map(e=>e.post_url).filter(Boolean))], source_events:group.map(e=>({...e}))};
  });
}

// A spreadsheet time serial (0.5208333333 = 12:30 PM) is a formatting accident,
// not a time a person can read.
const realTime = x => { const t = String(x || '').trim(); return /^\d*\.?\d+$/.test(t) ? '' : t; };

// The same post saved twice (Apify and Playwright record different link
// formats) shows once. Separate sessions from one post keep distinct explicit
// times or rooms, so those stay apart.
export function dedupeSamePost(events) {
  const kept = [];
  for (const event of events) {
    const twin = kept.find(k => canonicalPostUrl(k.post_url) === canonicalPostUrl(event.post_url) &&
      clubKey(k.club_name) === clubKey(event.club_name) && normalizeDate(k.event_date) === normalizeDate(event.event_date) &&
      compatible(realTime(k.event_time), realTime(event.event_time)) && compatible(k.location, event.location));
    if (!twin) { kept.push({ ...event, event_time: realTime(event.event_time) || event.event_time }); continue; }
    if (!realTime(twin.event_time)) twin.event_time = realTime(event.event_time);
    if (!String(twin.location || '').trim()) twin.location = event.location;
  }
  return kept;
}
