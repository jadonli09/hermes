import { setSink, resetSink } from '../utils/progress-events.js';
import { processPostWithClaude } from '../ai-processor.js';

// The dashboard's cost estimate is only as good as this event. It has to carry
// the model that actually answered and every token bucket the API bills for.
describe('processPostWithClaude usage reporting', () => {
  let events;
  const originalLog = console.log;

  beforeEach(() => {
    events = [];
    process.env.HERMES_PROGRESS = 'json';
    setSink(line => events.push(JSON.parse(line)));
    console.log = () => {};
  });

  afterEach(() => {
    resetSink();
    delete process.env.HERMES_PROGRESS;
    console.log = originalLog;
  });

  const answer = (json, usage, model) => ({
    messages: {
      create: async () => ({
        model,
        content: [{ type: 'text', text: JSON.stringify(json) }],
        usage
      })
    }
  });

  const post = { accountName: 'msjbio', caption: 'Meeting Friday in room 12 at lunch', imageUrls: [], postUrl: 'https://x/p/1' };

  it('emits one claude:usage event per Claude call, with the billed token buckets', async () => {
    const anthropic = answer(
      { event_date: '2026-08-21', event_time: '12:00 PM', event_type: 'Meeting', location: 'Room 12', description: 'Weekly meeting', confidence: 0.9, is_multi_day: false, detected_days: 1 },
      { input_tokens: 321, output_tokens: 45, cache_read_input_tokens: 12, cache_creation_input_tokens: 3 },
      'claude-haiku-4-5-20251001'
    );

    await processPostWithClaude(anthropic, post, null);

    const usage = events.filter(e => e.t === 'claude:usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 321,
      outputTokens: 45,
      cacheReadTokens: 12,
      cacheWriteTokens: 3
    });
  });

  it('treats missing cache counters as zero rather than NaN', async () => {
    const anthropic = answer(
      { event_date: null, event_time: null, event_type: null, location: null, description: null, confidence: 0.1, is_multi_day: false, detected_days: 1 },
      { input_tokens: 10, output_tokens: 2 },
      'claude-sonnet-5'
    );

    await processPostWithClaude(anthropic, post, null);

    const [usage] = events.filter(e => e.t === 'claude:usage');
    expect(usage).toMatchObject({ model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
