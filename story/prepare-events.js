import fs from 'node:fs';
import { consolidateEvents, dedupeSamePost } from './consolidate.js';
export function prepareEvents(events, reviews=JSON.parse(fs.readFileSync(new URL('./reviewed-events.json',import.meta.url),'utf8'))) {
  const reviewed=dedupeSamePost(events).map(event=>{
    const correction=reviews.find(r=>Object.entries(r.match).every(([key,value])=>event[key]===value));
    return correction ? {...event,...correction.set, reviewed_correction:{reason:correction.reason, original:{...event}}} : {...event};
  });
  // Exact-event reviews may order cards within their existing time band.
  // sortEvents remains responsible for chronological time groups.
  // Apply the user's display default only AFTER source-based reconciliation.
  // Source records retain the extracted time; this is not a confirmed time.
  const displayed = consolidateEvents(reviewed).map(event => {
    const time = String(event.event_time ?? '').trim();
    if (time && time.toLowerCase() !== 'time not specified') return event;
    return {...event, event_time:'Lunch', display_time_fallback:{
      original_time:event.event_time ?? null,
      reason:'User-requested Lunch display default for unspecified times (2026-10-20); not source-confirmed.'
    }};
  });
  return displayed.sort((a,b)=>(a.presentation_order ?? 0)-(b.presentation_order ?? 0));
}
