import { LoggingLevel } from "../types/index.js";

// Store original console methods before we do anything else
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

// Current log level - can be changed at runtime
// Initialize with default or from environment variable
let logLevel: LoggingLevel = (process.env.LOG_LEVEL as LoggingLevel) || 'info';

// Validate that the log level is valid, default to 'info' if not
if (!['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'].includes(logLevel)) {
  logLevel = 'info';
}

// Map of log levels and their priorities (higher number = higher priority)
const LOG_LEVEL_PRIORITY: Record<LoggingLevel, number> = {
  'debug': 0,
  'info': 1,
  'notice': 2,
  'warning': 3,
  'error': 4,
  'critical': 5,
  'alert': 6,
  'emergency': 7
};

// Check if message should be logged based on current level
const shouldLog = (level: LoggingLevel): boolean => {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[logLevel];
};

// Reference to the server for sending notifications
let serverInstance: any = null;

// Set the server instance for notifications
export const setServer = (server: any): void => {
  serverInstance = server;
};

// Flag to prevent recursion in logging
let isLogging = false;

// Core logging function
export const log = (level: LoggingLevel, ...args: any[]): void => {
  if (!shouldLog(level)) return;

  const message = args.map(arg =>
    typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
  ).join(' ');

  // Always write server logs to stderr so stdout remains MCP-only JSON-RPC.
  let consoleMethod = originalConsoleError;
  let consolePrefix = '';

  switch(level) {
    case 'debug':
      consolePrefix = '\x1b[90m[DEBUG]\x1b[0m'; // Gray
      consoleMethod = originalConsoleWarn || originalConsoleError;
      break;
    case 'info':
      consolePrefix = '\x1b[36m[INFO]\x1b[0m'; // Cyan
      break;
    case 'notice':
      consolePrefix = '\x1b[32m[NOTICE]\x1b[0m'; // Green
      break;
    case 'warning':
      consolePrefix = '\x1b[33m[WARNING]\x1b[0m'; // Yellow
      consoleMethod = originalConsoleWarn || originalConsoleError;
      break;
    case 'error':
      consolePrefix = '\x1b[31m[ERROR]\x1b[0m'; // Red
      consoleMethod = originalConsoleError;
      break;
    case 'critical':
      consolePrefix = '\x1b[41m\x1b[37m[CRITICAL]\x1b[0m'; // White on red
      consoleMethod = originalConsoleError;
      break;
    case 'alert':
      consolePrefix = '\x1b[45m\x1b[37m[ALERT]\x1b[0m'; // White on purple
      consoleMethod = originalConsoleError;
      break;
    case 'emergency':
      consolePrefix = '\x1b[41m\x1b[1m[EMERGENCY]\x1b[0m'; // Bold white on red
      consoleMethod = originalConsoleError;
      break;
  }

  consoleMethod(`${consolePrefix} ${message}`);

  // Emit MCP logging notifications only after initialize has completed.
  const clientInitialized =
    serverInstance &&
    typeof serverInstance.getClientCapabilities === 'function' &&
    !!serverInstance.getClientCapabilities();

  if (clientInitialized && typeof serverInstance.notification === 'function') {
    try {
      serverInstance.notification({
        method: "notifications/message",
        params: {
          level,
          logger: "lsp-mcp-server",
          data: message,
        },
      });
    } catch (error) {
      // Use original console methods to avoid recursion
      originalConsoleError("Error sending notification:", error);
    }
  }
};

// Create helper functions for each log level
export const debug = (...args: any[]): void => log('debug', ...args);
export const info = (...args: any[]): void => log('info', ...args);
export const notice = (...args: any[]): void => log('notice', ...args);
export const warning = (...args: any[]): void => log('warning', ...args);
export const logError = (...args: any[]): void => log('error', ...args);
export const critical = (...args: any[]): void => log('critical', ...args);
export const alert = (...args: any[]): void => log('alert', ...args);
export const emergency = (...args: any[]): void => log('emergency', ...args);

// Set log level function - defined after log function to avoid circular references
export const setLogLevel = (level: LoggingLevel): void => {
  const oldLevel = logLevel;
  logLevel = level;

  // Always log this message regardless of the new log level
  // Use notice level to ensure it's visible
  originalConsoleError(`\x1b[32m[NOTICE]\x1b[0m Log level changed from ${oldLevel} to ${level}`);

  // Also log through standard channels
  log('notice', `Log level set to: ${level}`);
};

// Override console methods to use our logging system
console.log = function(...args) {
  if (isLogging) {
    // Never write logger output to stdout.
    originalConsoleError(...args);
    return;
  }

  isLogging = true;
  info(...args);
  isLogging = false;
};

console.warn = function(...args) {
  if (isLogging) {
    // Use original method to prevent recursion
    originalConsoleWarn(...args);
    return;
  }

  isLogging = true;
  warning(...args);
  isLogging = false;
};

console.error = function(...args) {
  if (isLogging) {
    // Use original method to prevent recursion
    originalConsoleError(...args);
    return;
  }

  isLogging = true;
  logError(...args);
  isLogging = false;
};
