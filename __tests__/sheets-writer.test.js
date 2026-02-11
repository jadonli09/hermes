import { compareEventData, normalizeDate } from '../sheets-writer.js';

describe('normalizeDate', () => {
  describe('YYYY-MM-DD format', () => {
    it('should return YYYY-MM-DD as-is', () => {
      expect(normalizeDate('2024-01-15')).toBe('2024-01-15');
    });

    it('should return YYYY-MM-DD with leading zeros', () => {
      expect(normalizeDate('2024-12-05')).toBe('2024-12-05');
    });
  });

  describe('MM/DD/YYYY format', () => {
    it('should convert MM/DD/YYYY to YYYY-MM-DD', () => {
      expect(normalizeDate('01/15/2024')).toBe('2024-01-15');
    });

    it('should convert M/D/YYYY to YYYY-MM-DD with padding', () => {
      expect(normalizeDate('1/5/2024')).toBe('2024-01-05');
    });

    it('should handle 12/25/2023', () => {
      expect(normalizeDate('12/25/2023')).toBe('2023-12-25');
    });

    it('should handle single digit month', () => {
      expect(normalizeDate('6/15/2024')).toBe('2024-06-15');
    });

    it('should handle single digit day', () => {
      expect(normalizeDate('11/5/2024')).toBe('2024-11-05');
    });
  });

  describe('edge cases', () => {
    it('should return empty string for null', () => {
      expect(normalizeDate(null)).toBe('');
    });

    it('should return empty string for undefined', () => {
      expect(normalizeDate(undefined)).toBe('');
    });

    it('should return empty string for empty string', () => {
      expect(normalizeDate('')).toBe('');
    });

    it('should handle whitespace', () => {
      expect(normalizeDate('  2024-01-15  ')).toBe('2024-01-15');
    });

    it('should handle whitespace with MM/DD/YYYY', () => {
      expect(normalizeDate('  01/15/2024  ')).toBe('2024-01-15');
    });

    it('should return trimmed string for unrecognized formats', () => {
      expect(normalizeDate('Jan 15, 2024')).toBeTruthy();
    });
  });
});

describe('compareEventData', () => {
  describe('identical data', () => {
    it('should return false when data is identical', () => {
      const existing = {
        club_name: 'Chess Club',
        meeting_date: '2024-01-15',
        meeting_time: '3:30 PM',
        meeting_type: 'Club Meeting',
        location: 'Room B101',
        description: 'Weekly meeting',
        recurrence: 'weekly',
        confidence: '0.9'
      };
      const newEvent = { ...existing };
      expect(compareEventData(existing, newEvent)).toBe(false);
    });

    it('should return false with different whitespace', () => {
      const existing = {
        club_name: ' Chess Club ',
        meeting_date: '2024-01-15',
        meeting_time: '3:30 PM',
        meeting_type: 'Club Meeting',
        location: 'Room B101',
        description: 'Weekly meeting',
        recurrence: null,
        confidence: 0.9
      };
      const newEvent = {
        club_name: 'Chess Club',
        meeting_date: '2024-01-15',
        meeting_time: '3:30 PM',
        meeting_type: 'Club Meeting',
        location: 'Room B101',
        description: 'Weekly meeting',
        recurrence: '',
        confidence: '0.9'
      };
      expect(compareEventData(existing, newEvent)).toBe(false);
    });

    it('should return false when null and empty string are compared', () => {
      const existing = {
        club_name: 'Chess Club',
        meeting_date: '2024-01-15',
        meeting_time: null,
        meeting_type: 'Club Meeting',
        location: undefined,
        description: '',
        recurrence: null,
        confidence: 0.9
      };
      const newEvent = {
        club_name: 'Chess Club',
        meeting_date: '2024-01-15',
        meeting_time: '',
        meeting_type: 'Club Meeting',
        location: '',
        description: null,
        recurrence: '',
        confidence: '0.9'
      };
      expect(compareEventData(existing, newEvent)).toBe(false);
    });
  });

  describe('field changes', () => {
    const baseEvent = {
      club_name: 'Chess Club',
      meeting_date: '2024-01-15',
      meeting_time: '3:30 PM',
      meeting_type: 'Club Meeting',
      location: 'Room B101',
      description: 'Weekly meeting',
      recurrence: 'weekly',
      confidence: '0.9'
    };

    it('should return true when club_name changes', () => {
      const existing = { ...baseEvent };
      const newEvent = { ...baseEvent, club_name: 'Math Club' };
      expect(compareEventData(existing, newEvent)).toBe(true);
    });

    it('should return true when meeting_time changes', () => {
      const existing = { ...baseEvent };
      const newEvent = { ...baseEvent, meeting_time: '4:00 PM' };
      expect(compareEventData(existing, newEvent)).toBe(true);
    });

    it('should return true when meeting_type changes', () => {
      const existing = { ...baseEvent };
      const newEvent = { ...baseEvent, meeting_type: 'Workshop' };
      expect(compareEventData(existing, newEvent)).toBe(true);
    });

    it('should return true when location changes', () => {
      const existing = { ...baseEvent };
      const newEvent = { ...baseEvent, location: 'Room C202' };
      expect(compareEventData(existing, newEvent)).toBe(true);
    });

    it('should return true when description changes', () => {
      const existing = { ...baseEvent };
      const newEvent = { ...baseEvent, description: 'Special event' };
      expect(compareEventData(existing, newEvent)).toBe(true);
    });

    it('should return true when recurrence changes', () => {
      const existing = { ...baseEvent };
      const newEvent = { ...baseEvent, recurrence: 'monthly' };
      expect(compareEventData(existing, newEvent)).toBe(true);
    });

    it('should return true when confidence changes', () => {
      const existing = { ...baseEvent };
      const newEvent = { ...baseEvent, confidence: '0.85' };
      expect(compareEventData(existing, newEvent)).toBe(true);
    });

    it('should return true when new value is null but existing has value', () => {
      const existing = { ...baseEvent };
      const newEvent = { ...baseEvent, location: null };
      expect(compareEventData(existing, newEvent)).toBe(true);
    });

    it('should return true when existing is null but new has value', () => {
      const existing = { ...baseEvent, location: null };
      const newEvent = { ...baseEvent };
      expect(compareEventData(existing, newEvent)).toBe(true);
    });
  });

  describe('date format normalization', () => {
    it('should return false when dates are the same but in different formats (YYYY-MM-DD vs MM/DD/YYYY)', () => {
      const existing = {
        club_name: 'Chess Club',
        meeting_date: '01/15/2024',
        meeting_time: '3:30 PM',
        meeting_type: 'Club Meeting',
        location: 'Room B101',
        description: 'Weekly meeting',
        recurrence: null,
        confidence: '0.9'
      };
      const newEvent = {
        club_name: 'Chess Club',
        meeting_date: '2024-01-15',
        meeting_time: '3:30 PM',
        meeting_type: 'Club Meeting',
        location: 'Room B101',
        description: 'Weekly meeting',
        recurrence: null,
        confidence: '0.9'
      };
      expect(compareEventData(existing, newEvent)).toBe(false);
    });

    it('should return false when dates are the same (M/D/YYYY vs YYYY-MM-DD)', () => {
      const existing = {
        club_name: 'Test Club',
        meeting_date: '1/5/2024',
        meeting_time: 'Lunch',
        meeting_type: 'Meeting',
        location: 'Library',
        description: 'Test',
        recurrence: null,
        confidence: '0.8'
      };
      const newEvent = {
        club_name: 'Test Club',
        meeting_date: '2024-01-05',
        meeting_time: 'Lunch',
        meeting_type: 'Meeting',
        location: 'Library',
        description: 'Test',
        recurrence: null,
        confidence: '0.8'
      };
      expect(compareEventData(existing, newEvent)).toBe(false);
    });

    it('should return true when dates are actually different', () => {
      const existing = {
        club_name: 'Chess Club',
        meeting_date: '01/15/2024',
        meeting_time: '3:30 PM',
        meeting_type: 'Club Meeting',
        location: 'Room B101',
        description: 'Weekly meeting',
        recurrence: null,
        confidence: '0.9'
      };
      const newEvent = {
        club_name: 'Chess Club',
        meeting_date: '2024-01-20',
        meeting_time: '3:30 PM',
        meeting_type: 'Club Meeting',
        location: 'Room B101',
        description: 'Weekly meeting',
        recurrence: null,
        confidence: '0.9'
      };
      expect(compareEventData(existing, newEvent)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle empty objects', () => {
      const existing = {};
      const newEvent = {};
      expect(compareEventData(existing, newEvent)).toBe(false);
    });

    it('should handle missing fields', () => {
      const existing = { club_name: 'Test' };
      const newEvent = { club_name: 'Test' };
      expect(compareEventData(existing, newEvent)).toBe(false);
    });

    it('should detect change when field is missing in one object', () => {
      const existing = { club_name: 'Test', meeting_time: '3:30 PM' };
      const newEvent = { club_name: 'Test' };
      expect(compareEventData(existing, newEvent)).toBe(true);
    });

    it('should handle numeric confidence values', () => {
      const existing = {
        club_name: 'Test',
        meeting_date: '',
        meeting_time: '',
        meeting_type: '',
        location: '',
        description: '',
        recurrence: '',
        confidence: 0.9
      };
      const newEvent = {
        club_name: 'Test',
        meeting_date: '',
        meeting_time: '',
        meeting_type: '',
        location: '',
        description: '',
        recurrence: '',
        confidence: 0.9
      };
      expect(compareEventData(existing, newEvent)).toBe(false);
    });

    it('should detect confidence change between numeric and string', () => {
      const existing = {
        club_name: 'Test',
        meeting_date: '',
        meeting_time: '',
        meeting_type: '',
        location: '',
        description: '',
        recurrence: '',
        confidence: 0.9
      };
      const newEvent = {
        club_name: 'Test',
        meeting_date: '',
        meeting_time: '',
        meeting_type: '',
        location: '',
        description: '',
        recurrence: '',
        confidence: 0.85
      };
      expect(compareEventData(existing, newEvent)).toBe(true);
    });
  });
});
