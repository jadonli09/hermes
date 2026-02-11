// Zod schema for validating Claude AI response structure
import { z } from 'zod';

// Valid event types enum
const EventTypes = [
  // Club events
  'Club Meeting',
  'Fundraiser',
  'Volunteer',
  'Social Event',
  'Announcement',
  'Competition',
  'Workshop',
  // Sports events
  'Game',
  'Tryout',
  // ASB/School events
  'Dance',
  'Assembly',
  'Election',
  'Activity',
  'Spirit Day',
  'Event',
  // General
  'Other'
];

// Schema for a single event
const SingleEventSchema = z.object({
  event_date: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .nullable()
    .optional()
    .transform(val => val || null),

  event_time: z.string()
    .nullable()
    .optional()
    .transform(val => val || null),

  event_type: z.enum(EventTypes)
    .nullable()
    .optional()
    .transform(val => val || null)
    .catch(null),

  location: z.string()
    .nullable()
    .optional()
    .transform(val => val || null),

  description: z.string()
    .nullable()
    .optional()
    .transform(val => val || null),

  confidence: z.number()
    .min(0.0)
    .max(1.0)
    .nullable()
    .optional()
    .transform(val => val ?? null)
    .catch(null)
});

// Schema for Claude's extracted event data (single event with multi-day detection)
export const ClaudeResponseSchema = SingleEventSchema.extend({
  is_multi_day: z.boolean()
    .optional()
    .default(false),

  detected_days: z.number()
    .optional()
    .nullable()
    .transform(val => val || null)
}).passthrough();

// Schema for multi-day response (array of events)
export const MultiDayResponseSchema = z.object({
  events: z.array(SingleEventSchema)
}).passthrough();

/**
 * Validates and transforms Claude API response (single event)
 * @param {Object} data - Raw response data from Claude
 * @returns {Object} - Validated and normalized response
 */
export function validateClaudeResponse(data) {
  try {
    const result = ClaudeResponseSchema.safeParse(data);

    if (!result.success) {
      console.warn('Claude response validation warnings:', result.error.errors);

      return {
        event_date: data.event_date && /^\d{4}-\d{2}-\d{2}$/.test(data.event_date) ? data.event_date : null,
        event_time: data.event_time || null,
        event_type: EventTypes.includes(data.event_type) ? data.event_type : null,
        location: data.location || null,
        description: data.description || null,
        confidence: typeof data.confidence === 'number' && data.confidence >= 0 && data.confidence <= 1 ? data.confidence : null,
        is_multi_day: data.is_multi_day === true,
        detected_days: typeof data.detected_days === 'number' ? data.detected_days : null
      };
    }

    return result.data;
  } catch (error) {
    console.error('Error validating Claude response:', error.message);
    return {
      event_date: null,
      event_time: null,
      event_type: null,
      location: null,
      description: null,
      confidence: null,
      is_multi_day: false,
      detected_days: null
    };
  }
}

/**
 * Validates and transforms Claude API response (multi-day events)
 * @param {Object} data - Raw response data from Claude
 * @returns {Object} - Validated and normalized response with events array
 */
export function validateMultiDayResponse(data) {
  try {
    // Handle case where Claude returns events array directly
    const toValidate = Array.isArray(data) ? { events: data } : data;

    const result = MultiDayResponseSchema.safeParse(toValidate);

    if (!result.success) {
      console.warn('Multi-day response validation warnings:', result.error.errors);

      // Try to salvage the events array
      const events = toValidate.events || [];
      return {
        events: events.map(event => ({
          event_date: event.event_date && /^\d{4}-\d{2}-\d{2}$/.test(event.event_date) ? event.event_date : null,
          event_time: event.event_time || null,
          event_type: EventTypes.includes(event.event_type) ? event.event_type : null,
          location: event.location || null,
          description: event.description || null,
          confidence: typeof event.confidence === 'number' ? event.confidence : null
        }))
      };
    }

    return result.data;
  } catch (error) {
    console.error('Error validating multi-day response:', error.message);
    return { events: [] };
  }
}

// Export event types for use elsewhere
export { EventTypes };
