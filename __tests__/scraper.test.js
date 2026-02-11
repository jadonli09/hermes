import { jest } from '@jest/globals';
import { parseInstagramDate, isIntroPost } from '../scraper.js';

describe('parseInstagramDate', () => {
  describe('ISO datetime format', () => {
    it('should parse ISO datetime with timezone', () => {
      const result = parseInstagramDate('2024-11-15T10:30:00.000Z');
      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2024-11-15T10:30:00.000Z');
    });

    it('should parse ISO date without time', () => {
      const result = parseInstagramDate('2024-11-15');
      expect(result).toBeInstanceOf(Date);
      expect(result.getFullYear()).toBe(2024);
      expect(result.getMonth()).toBe(10); // November (0-indexed)
      // Note: getDate() may vary by timezone, so check year/month only
    });

    it('should parse ISO datetime without milliseconds', () => {
      const result = parseInstagramDate('2024-01-20T14:00:00Z');
      expect(result).toBeInstanceOf(Date);
      expect(result.getFullYear()).toBe(2024);
    });
  });

  describe('relative formats', () => {
    let originalDate;

    beforeEach(() => {
      originalDate = Date;
      const mockDate = new Date('2024-06-15T12:00:00Z');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should parse hours ago (2h)', () => {
      const result = parseInstagramDate('2h');
      expect(result).toBeInstanceOf(Date);
      // 2 hours before mock time
      expect(result.getUTCHours()).toBe(10);
    });

    it('should parse days ago (3d)', () => {
      const result = parseInstagramDate('3d');
      expect(result).toBeInstanceOf(Date);
      // 3 days before June 15 = June 12
      expect(result.getUTCDate()).toBe(12);
      expect(result.getUTCMonth()).toBe(5); // June
    });

    it('should parse weeks ago (5w)', () => {
      const result = parseInstagramDate('5w');
      expect(result).toBeInstanceOf(Date);
      // 5 weeks = 35 days before June 15 = May 11
      expect(result.getUTCMonth()).toBe(4); // May
      expect(result.getUTCDate()).toBe(11);
    });

    it('should parse months ago (1m)', () => {
      const result = parseInstagramDate('1m');
      expect(result).toBeInstanceOf(Date);
      // 1 month (30 days) before June 15 = May 16
      expect(result.getUTCMonth()).toBe(4); // May
    });

    it('should handle uppercase units (2D)', () => {
      const result = parseInstagramDate('2D');
      expect(result).toBeInstanceOf(Date);
      expect(result.getUTCDate()).toBe(13);
    });
  });

  describe('partial dates (Month Day)', () => {
    beforeEach(() => {
      const mockDate = new Date('2024-06-15T12:00:00Z');
      jest.useFakeTimers();
      jest.setSystemTime(mockDate);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should parse abbreviated month (Nov 16)', () => {
      const result = parseInstagramDate('Nov 16');
      expect(result).toBeInstanceOf(Date);
      expect(result.getMonth()).toBe(10); // November
      expect(result.getDate()).toBe(16);
    });

    it('should parse full month name (January 20)', () => {
      const result = parseInstagramDate('January 20');
      expect(result).toBeInstanceOf(Date);
      expect(result.getMonth()).toBe(0); // January
      expect(result.getDate()).toBe(20);
    });

    it('should assume previous year if date is more than 6 months in future', () => {
      // Current date is June 15, 2024
      // December 20 is more than 6 months ahead, so should be 2023
      const result = parseInstagramDate('Dec 20');
      expect(result).toBeInstanceOf(Date);
      expect(result.getFullYear()).toBe(2023);
      expect(result.getMonth()).toBe(11); // December
    });

    it('should use current year if date is within 6 months', () => {
      // Current date is June 15, 2024
      // August 20 is within 6 months
      const result = parseInstagramDate('Aug 20');
      expect(result).toBeInstanceOf(Date);
      expect(result.getFullYear()).toBe(2024);
      expect(result.getMonth()).toBe(7); // August
    });

    it('should handle case-insensitive month names', () => {
      const result = parseInstagramDate('MARCH 5');
      expect(result).toBeInstanceOf(Date);
      expect(result.getMonth()).toBe(2); // March
      expect(result.getDate()).toBe(5);
    });
  });

  describe('full dates (Month Day, Year)', () => {
    it('should parse full date with abbreviated month (Jan 15, 2024)', () => {
      const result = parseInstagramDate('Jan 15, 2024');
      expect(result).toBeInstanceOf(Date);
      expect(result.getFullYear()).toBe(2024);
      expect(result.getMonth()).toBe(0); // January
      expect(result.getDate()).toBe(15);
    });

    it('should parse full date with full month name (January 15, 2024)', () => {
      const result = parseInstagramDate('January 15, 2024');
      expect(result).toBeInstanceOf(Date);
      expect(result.getFullYear()).toBe(2024);
      expect(result.getMonth()).toBe(0);
      expect(result.getDate()).toBe(15);
    });

    it('should handle various years', () => {
      const result = parseInstagramDate('December 25, 2023');
      expect(result).toBeInstanceOf(Date);
      expect(result.getFullYear()).toBe(2023);
      expect(result.getMonth()).toBe(11);
      expect(result.getDate()).toBe(25);
    });
  });

  describe('edge cases', () => {
    it('should return null for null input', () => {
      expect(parseInstagramDate(null)).toBeNull();
    });

    it('should return null for undefined input', () => {
      expect(parseInstagramDate(undefined)).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(parseInstagramDate('')).toBeNull();
    });

    it('should return null for non-string input', () => {
      expect(parseInstagramDate(123)).toBeNull();
      expect(parseInstagramDate({})).toBeNull();
      expect(parseInstagramDate([])).toBeNull();
    });

    it('should handle whitespace-padded strings', () => {
      const result = parseInstagramDate('  Nov 16  ');
      expect(result).toBeInstanceOf(Date);
      expect(result.getMonth()).toBe(10);
    });

    it('should return null for completely invalid date strings', () => {
      expect(parseInstagramDate('not a date')).toBeNull();
    });

    it('should handle single digit days', () => {
      const result = parseInstagramDate('Jan 5, 2024');
      expect(result).toBeInstanceOf(Date);
      expect(result.getDate()).toBe(5);
    });
  });
});

describe('isIntroPost', () => {
  describe('meeting indicators - should NOT be intro posts', () => {
    it('should return false for posts with month names', () => {
      const post = { caption: 'Join us in November for our next event!' };
      expect(isIntroPost(post)).toBe(false);
    });

    it('should return false for posts with time patterns', () => {
      const post = { caption: 'See you at 3:30 in the library!' };
      expect(isIntroPost(post)).toBe(false);
    });

    it('should return false for posts with location patterns', () => {
      const post = { caption: 'Come to room B123 for snacks!' };
      expect(isIntroPost(post)).toBe(false);
    });

    it('should return false for posts with date patterns', () => {
      const post = { caption: 'Mark your calendars for Nov 15!' };
      expect(isIntroPost(post)).toBe(false);
    });

    it('should return false for posts with meeting keywords', () => {
      const post = { caption: 'Next meeting will be announced soon!' };
      expect(isIntroPost(post)).toBe(false);
    });

    it('should return false for event announcements', () => {
      const post = { caption: 'Fundraiser event this Friday at the cafeteria!' };
      expect(isIntroPost(post)).toBe(false);
    });

    it('should return false for workshop announcements', () => {
      const post = { caption: 'Come to our workshop session next week!' };
      expect(isIntroPost(post)).toBe(false);
    });
  });

  describe('intro keywords - should be intro posts', () => {
    it('should return true for welcome posts', () => {
      const post = { caption: 'Welcome to our club page! We are happy to have you here.' };
      expect(isIntroPost(post)).toBe(true);
    });

    it('should return true for intro posts', () => {
      const post = { caption: 'This is our intro post with all the info you need.' };
      expect(isIntroPost(post)).toBe(true);
    });

    it('should return true for about us posts', () => {
      const post = { caption: 'Learn more about us and what we do here.' };
      expect(isIntroPost(post)).toBe(true);
    });

    it('should return true for "who we are" posts', () => {
      const post = { caption: 'Here is who we are and our mission statement.' };
      expect(isIntroPost(post)).toBe(true);
    });

    it('should return true for pinned posts', () => {
      const post = { caption: 'This is our pinned post with important info.' };
      expect(isIntroPost(post)).toBe(true);
    });

    it('should return true for "new members" posts', () => {
      const post = { caption: 'Information for new members - read this first!' };
      expect(isIntroPost(post)).toBe(true);
    });

    it('should return true for "welcome to" posts', () => {
      const post = { caption: 'Welcome to the official page of our organization!' };
      expect(isIntroPost(post)).toBe(true);
    });
  });

  describe('word boundary matching', () => {
    it('should NOT match "invites" as intro', () => {
      const post = { caption: 'She invites everyone to the party this Saturday!' };
      expect(isIntroPost(post)).toBe(false);
    });

    it('should NOT match "joining" as "join us"', () => {
      const post = { caption: 'Thanks for joining our stream yesterday!' };
      expect(isIntroPost(post)).toBe(false);
    });

    it('should match exact "intro" word', () => {
      const post = { caption: 'Quick intro to our organization.' };
      expect(isIntroPost(post)).toBe(true);
    });
  });

  describe('length heuristics', () => {
    it('should return true for very short captions (< 30 chars)', () => {
      const post = { caption: 'Hi there!' }; // Less than 30 chars
      expect(isIntroPost(post)).toBe(true);
    });

    it('should NOT return true for short captions with time', () => {
      const post = { caption: 'See you at 3:30!' }; // Has time pattern
      expect(isIntroPost(post)).toBe(false);
    });

    it('should return true for very long posts with intro keywords', () => {
      const longIntro = 'Welcome to our club! '.repeat(30); // > 500 chars
      const post = { caption: longIntro };
      expect(isIntroPost(post)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should return false for null post', () => {
      expect(isIntroPost(null)).toBe(false);
    });

    it('should return false for undefined post', () => {
      expect(isIntroPost(undefined)).toBe(false);
    });

    it('should return false for post without caption', () => {
      expect(isIntroPost({})).toBe(false);
      expect(isIntroPost({ caption: null })).toBe(false);
    });

    it('should return false for empty caption', () => {
      expect(isIntroPost({ caption: '' })).toBe(false);
    });

    it('should handle case insensitivity', () => {
      const post = { caption: 'WELCOME TO OUR CLUB! WE ARE EXCITED!' };
      expect(isIntroPost(post)).toBe(true);
    });
  });
});
