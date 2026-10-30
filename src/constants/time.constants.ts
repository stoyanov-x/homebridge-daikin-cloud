/**
 * Time Constants
 *
 * All time-related constants for consistency across the application.
 */

export const ONE_SECOND_MS = 1000;
export const ONE_MINUTE_MS = ONE_SECOND_MS * 60;
export const ONE_HOUR_MS = ONE_MINUTE_MS * 60;
export const ONE_DAY_MS = ONE_HOUR_MS * 24;

/** Milliseconds per second for timestamp conversions */
export const MS_PER_SECOND = 1000;

/** Default polling interval in minutes */
export const DEFAULT_UPDATE_INTERVAL_MINUTES = 15;

/** Default delay before force update in milliseconds */
export const DEFAULT_FORCE_UPDATE_DELAY_MS = ONE_SECOND_MS * 60;

/**
 * Fallback polling interval (ms) used when WebSocket is disconnected.
 * Shorter than the normal interval so the plugin catches state changes
 * quickly when real-time updates aren't available.
 */
export const WEBSOCKET_FALLBACK_POLL_INTERVAL_MS = ONE_MINUTE_MS * 2;

/**
 * Delay before the first retry when device discovery fails at startup.
 * Discovery is what binds accessories to live devices, so the plugin keeps
 * retrying until it succeeds instead of staying inert until the next restart.
 */
export const DISCOVERY_RETRY_INITIAL_DELAY_MS = ONE_MINUTE_MS;

/** Cap for the exponential backoff between discovery attempts */
export const DISCOVERY_RETRY_MAX_DELAY_MS = ONE_MINUTE_MS * 15;
