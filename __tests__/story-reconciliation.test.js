import fs from 'node:fs';
import {samePresentationEvent,consolidateEvents} from '../story/consolidate.js';
import {prepareEvents} from '../story/prepare-events.js';
import {groupByTime,sortEvents} from '../story/paginate.js';
import {processPostWithClaude} from '../ai-processor.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/oct16-events.json',import.meta.url)));
const a={club_name:'relay',event_date:'10/16/2026',event_time:'',location:'C120',event_type:'Event',description:'Kickoff Meeting',post_url:'https://www.instagram.com/p/A/'};
const b={...a,event_time:'Lunch',event_type:'Club Meeting',description:'Mandatory kickoff meeting for all participants',post_url:'https://www.instagram.com/p/B/'};
test('cross-post consolidation preserves source records and prefers explicit time',()=>{
 const input=[a,b];const frozen=JSON.stringify(input);const [e]=consolidateEvents(input);
 expect(consolidateEvents(input)).toHaveLength(1);expect(e.event_time).toBe('Lunch');expect(e.source_urls).toEqual([a.post_url,b.post_url]);expect(e.source_events).toEqual(input);expect(JSON.stringify(input)).toBe(frozen);
});
test.each([
 ['club',{club_name:'other'}],['date',{event_date:'2026-10-17'}],['room',{location:'C121'}],['unknown room',{location:''}],['event type',{event_type:'Fundraiser'}],['different event',{description:'Luminaria bag making'}],['generic title',{description:'Club meeting'}]
])('does not merge distinct or uncertain %s',(_,over)=>expect(samePresentationEvent(b,{...a,...over})).toBe(false));
test('explicit conflicting times stay separate',()=>expect(consolidateEvents([b,{...b,event_time:'After School'}])).toHaveLength(2));
test('same post URL does not collapse separate times or rooms',()=>expect(consolidateEvents([b,{...b,location:'C2'},{...b,event_time:'After School'}])).toHaveLength(3));
test('generic titles never merge',()=>expect(consolidateEvents([{...a,description:'Club meeting'},{...b,description:'Club meeting'}])).toHaveLength(2));
test('all-day is explicit and distinct from missing or contextual time',()=>{
 const labels=groupByTime([{event_time:''},{event_time:'All day'},{event_time:'Health/ethnic studies period'}]).map(g=>g.time);
 expect(labels).toEqual(['Time not specified','All day','Health/ethnic studies period']);
});
test('October 16 replay has seven events, one Relay and all eight source rows',()=>{
 const before=JSON.stringify(fixture);const events=prepareEvents(fixture);
 expect(events).toHaveLength(7);expect(events.flatMap(e=>e.source_events)).toHaveLength(8);
 const relay=events.filter(e=>e.club_name==='msjrelayforlife');expect(relay).toHaveLength(1);expect(relay[0].event_time).toBe('Lunch');expect(relay[0].source_urls).toHaveLength(2);
 expect(events.find(e=>e.club_name==='msjaviationclub').event_time).toBe('Lunch');
 expect(events.find(e=>e.club_name==='msjhs_2030').event_time).toBe('Health/ethnic studies period');
 expect(JSON.stringify(fixture)).toBe(before);
});
test.each(['event_time','description','location','event_date','event_type'])('review correction cannot overwrite later manual %s edit',field=>{
 const event={...fixture.find(e=>e.club_name==='msjaviationclub'),[field]:'Manually reviewed'};
 const [result]=prepareEvents([event]);expect(result[field]).toBe('Manually reviewed');expect(result.reviewed_correction).toBeUndefined();
});
test.each(['Club Meeting','Fundraiser','Workshop'])('extractor no longer invents lunch for %s',async type=>{
 const anthropic={messages:{create:async()=>({content:[{type:'text',text:JSON.stringify({event_date:'2026-10-16',event_time:null,event_type:type,location:'P3',description:'Basic instruments',confidence:0.9,is_multi_day:false,detected_days:1})}],usage:{}})}};
 const result=await processPostWithClaude(anthropic,{accountName:'aviation',caption:'Meeting October 16 in P3',postUrl:'https://www.instagram.com/p/TEST/',imageUrls:[]},null);
 expect(result.event_time).toBeNull();
});

test('ambiguous unknown-time bridge does not choose one of two distinct sessions',()=>{
 const late={...b,event_time:'After School'};
 for(const input of [[a,b,late],[b,a,late],[late,b,a]]) expect(consolidateEvents(input)).toHaveLength(3);
});
test('weekly meeting is too generic to merge across posts',()=>expect(consolidateEvents([{...a,description:'Weekly meeting'},{...b,description:'Weekly meeting'}])).toHaveLength(2));

test('collaborating clubs retain separate events even with the same source URL',()=>{
 expect(consolidateEvents([b,{...b,club_name:'another.club'}])).toHaveLength(2);
});
test('different Instagram handles preserve significant dots and underscores',()=>{
 expect(consolidateEvents([{...b,club_name:'club.a'},{...b,club_name:'club_a'}])).toHaveLength(2);
});
test('weekly recurring occurrences on different dates never merge',()=>{
 expect(consolidateEvents([b,{...b,event_date:'10/23/2026'}])).toHaveLength(2);
});
test('matching handles tolerate only casing and surrounding whitespace',()=>{
 expect(consolidateEvents([b,{...b,club_name:' RELAY '}])).toHaveLength(1);
});

test('October 16 edition puts STEM-PAC first and records user-confirmed Aviation lunch',()=>{
 const events=sortEvents(prepareEvents(fixture));
 expect(events).toHaveLength(7);expect(events[0].club_name).toBe('msjstempac');
 const aviation=events.find(e=>e.club_name==='msjaviationclub');
 expect(aviation.event_time).toBe('Lunch');expect(aviation.reviewed_correction.reason).toContain('Jadon confirmed');
 expect(events.flatMap(e=>e.source_events)).toHaveLength(8);
});
test('edition-specific ordering and confirmed time do not apply to another date',()=>{
 const events=prepareEvents(fixture.map(e=>({...e,event_date:'10/23/2026',...(e.club_name==='msjaviationclub'?{event_time:''}:{})})));
 expect(events.every(e=>e.presentation_order===undefined)).toBe(true);
 expect(events.find(e=>e.club_name==='msjaviationclub').event_time).toBe('Lunch');
 expect(events.find(e=>e.club_name==='msjaviationclub').display_time_fallback).toBeDefined();
 expect(events.find(e=>e.club_name==='msjaviationclub').reviewed_correction).toBeUndefined();
});


test.each(['', '   ', null, undefined, 'Time not specified'])('unspecified %s displays Lunch with source provenance',time=>{
 const input={...a,event_time:time};const [e]=prepareEvents([input],[]);
 expect(e.event_time).toBe('Lunch');expect(e.display_time_fallback.reason).toContain('not source-confirmed');
 expect(e.source_events[0]).toEqual(input);expect(input.event_time).toBe(time);
 expect(groupByTime(sortEvents([e]))[0].time).toBe('Lunch');
});
test.each(['After School','Before School','All day','23:59','Health/ethnic studies period','TBD'])('preserves stated %s without a fallback',time=>{
 const [e]=prepareEvents([{...a,event_time:time}],[]);expect(e.event_time).toBe(time);expect(e.display_time_fallback).toBeUndefined();
});
test('fallback cannot manufacture evidence to merge different events or sessions',()=>{
 const events=prepareEvents([a,b,{...b,event_time:'After School'}],[]);
 expect(events).toHaveLength(3);expect(events.filter(e=>e.display_time_fallback)).toHaveLength(1);
});
const oct20=JSON.parse(fs.readFileSync(new URL('./fixtures/oct20-events.json',import.meta.url)));
test('October 20 VSA captions reconcile using exact reviewed evidence and explicit Lunch',()=>{
 const input=JSON.stringify(oct20);const events=prepareEvents(oct20);const vsa=events.filter(e=>e.club_name==='msj.vsa');
 expect(events).toHaveLength(4);expect(vsa).toHaveLength(1);expect(vsa[0].event_time).toBe('Lunch');
 expect(vsa[0].display_time_fallback).toBeUndefined();expect(vsa[0].source_urls).toHaveLength(2);
 expect(vsa[0].source_events.map(e=>e.event_time)).toEqual(['Lunch','']);
 const red=events.find(e=>e.club_name==='msj.redcross');expect(red.event_time).toBe('Lunch');expect(red.display_time_fallback.original_time).toBe('');
 expect(events.find(e=>e.club_name==='msj.mun').event_time).toBe('23:59');expect(JSON.stringify(oct20)).toBe(input);
});
test.each(['event_date','event_time','location','description'])('VSA review does not generalize to changed %s',field=>{
 const rows=oct20.filter(e=>e.club_name==='msj.vsa').map(e=>({...e,[field]:'Changed'}));
 expect(prepareEvents(rows).filter(e=>e.reviewed_event_group)).toHaveLength(0);
 expect(prepareEvents(rows)).toHaveLength(2);
});

test('the same post saved twice under different link formats shows once, keeping filled-in fields',()=>{
 const first={club_name:'msj.redcross',event_date:'10/20/2026',event_time:'',location:'Horseshoe',event_type:'Fundraiser',description:'MSJ Red Cross Club is hosting a boba fundraiser at the Horseshoe on October 20th, selling milk tea and passion fruit tea for $5.',post_url:'https://www.instagram.com/p/DeqRPxNN5B1/'};
 const again={...first,event_time:'Lunch',description:'MSJ Red Cross is hosting a boba fundraiser at the Horseshoe on October 20th, with milk tea and passion fruit tea.',post_url:'https://www.instagram.com/msj.redcross/p/DeqRPxNN5B1/'};
 const out=prepareEvents([first,again],[]);
 expect(out).toHaveLength(1);expect(out[0].event_time).toBe('Lunch');
});
test('a spreadsheet time serial is not treated as a real time when merging duplicates',()=>{
 const first={club_name:'msjleoclub',event_date:'10/24/2026',event_time:'12:30 PM',location:'Niles Elementary',event_type:'Volunteer',description:'MSJ Leo Club members can volunteer at the Niles Halloween Carnival.',post_url:'https://www.instagram.com/p/DeqSaonxO81/'};
 const again={...first,event_time:'0.5208333333',description:"MSJ Leo Club's Niles Halloween Carnival on Saturday, October 24th.",post_url:'https://www.instagram.com/msjleoclub/p/DeqSaonxO81/'};
 const out=prepareEvents([first,again],[]);
 expect(out).toHaveLength(1);expect(out[0].event_time).toBe('12:30 PM');
});
