export interface TimeSyncResult {
  synced: boolean;
  offset: number; // in seconds
  message?: string;
}

// Check time synchronization with multiple sources
export async function checkTimeSync(): Promise<TimeSyncResult> {
  try {
    // Try worldtimeapi.org first
    const response = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC', {
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error('API request failed');
    }

    const data = await response.json();
    const serverTime = new Date(data.datetime).getTime();
    const localTime = Date.now();
    const offsetMs = Math.abs(serverTime - localTime);
    const offsetSeconds = Math.floor(offsetMs / 1000);

    // If difference is more than 30 seconds, there's a problem
    const synced = offsetMs < 30000;

    return {
      synced,
      offset: offsetSeconds,
      message: synced
        ? undefined
        : `Your device clock is off by ${offsetSeconds} seconds. This may cause incorrect codes.`
    };
  } catch (error) {
    // If API is unavailable, don't block - assume time is OK
    console.warn('Time sync check failed:', error);
    return {
      synced: true,
      offset: 0
    };
  }
}

// Format offset for display
export function formatTimeOffset(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds !== 1 ? 's' : ''}`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
}

// Get time sync status message
export async function getTimeSyncMessage(): Promise<string | null> {
  const result = await checkTimeSync();
  if (!result.synced && result.offset > 0) {
    return `⚠️ Clock is off by ${formatTimeOffset(result.offset)}. Codes may be incorrect. Please sync your device time.`;
  }
  return null;
}
