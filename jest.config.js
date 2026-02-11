export default {
  // Use ES modules
  transform: {},

  // Test environment
  testEnvironment: 'node',

  // Test file patterns
  testMatch: [
    '**/__tests__/**/*.test.js',
    '**/*.test.js'
  ],

  // Module file extensions
  moduleFileExtensions: ['js', 'json', 'node'],

  // Coverage configuration
  collectCoverageFrom: [
    '*.js',
    'utils/**/*.js',
    'schemas/**/*.js',
    '!jest.config.js',
    '!node_modules/**'
  ],

  // Coverage thresholds
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 50,
      statements: 50
    }
  },

  // Verbose output
  verbose: true,

  // Clear mocks between tests
  clearMocks: true,

  // Use fake timers for date-related tests
  fakeTimers: {
    enableGlobally: false
  }
};
