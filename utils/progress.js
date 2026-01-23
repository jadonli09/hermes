// Progress persistence utility for resuming interrupted runs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current directory for ES6 modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get progress file path from environment or use default
const getProgressFilePath = () => {
  const progressFile = process.env.PROGRESS_FILE || 'progress.json';
  // If relative path, make it relative to project root
  if (!path.isAbsolute(progressFile)) {
    return path.join(__dirname, '..', progressFile);
  }
  return progressFile;
};

/**
 * Loads progress from the progress file
 * @returns {Object|null} - Progress object or null if file doesn't exist
 */
export function loadProgress() {
  try {
    const progressPath = getProgressFilePath();
    
    if (!fs.existsSync(progressPath)) {
      return null;
    }
    
    const progressData = fs.readFileSync(progressPath, 'utf-8');
    const progress = JSON.parse(progressData);
    
    // Ensure newer properties exist even if old progress files lack them
    if (!progress.processedClubs) {
      progress.processedClubs = [];
    }
    if (!progress.processedPosts) {
      progress.processedPosts = [];
    }
    if (!progress.failedClubs) {
      progress.failedClubs = [];
    }
    
    console.log(`Loaded progress: ${progress.totalClubsProcessed || 0} clubs, ${progress.totalPostsProcessed || 0} posts processed`);
    
    return progress;
  } catch (error) {
    console.warn(`Error loading progress file: ${error.message}`);
    return null;
  }
}

/**
 * Saves progress to the progress file
 * @param {Object} progress - Progress object to save
 * @returns {void}
 */
export function saveProgress(progress) {
  try {
    const progressPath = getProgressFilePath();
    
    // Ensure directory exists
    const progressDir = path.dirname(progressPath);
    if (!fs.existsSync(progressDir)) {
      fs.mkdirSync(progressDir, { recursive: true });
    }
    
    // Add timestamp
    progress.lastUpdated = new Date().toISOString();
    
    // Write to file
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), 'utf-8');
  } catch (error) {
    console.warn(`Error saving progress file: ${error.message}`);
    // Don't throw - progress saving is not critical
  }
}

/**
 * Clears the progress file
 * @returns {void}
 */
export function clearProgress() {
  try {
    const progressPath = getProgressFilePath();
    
    if (fs.existsSync(progressPath)) {
      fs.unlinkSync(progressPath);
      console.log('Progress file cleared');
    }
  } catch (error) {
    console.warn(`Error clearing progress file: ${error.message}`);
    // Don't throw - progress clearing is not critical
  }
}

/**
 * Creates a new progress object
 * @returns {Object} - New progress object
 */
export function createProgress() {
  return {
    lastProcessedClub: null,
    processedClubs: [],
    processedPosts: [],
    failedClubs: [],
    lastRunTimestamp: new Date().toISOString(),
    totalClubsProcessed: 0,
    totalPostsProcessed: 0,
    lastUpdated: null
  };
}



