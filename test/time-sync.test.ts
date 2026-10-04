// The clock check, exercised through the paths that actually broke.
//
// Every scenario below is a bug that shipped in 1.11.0: one dead time source
// took the whole feature down silently, a reading we could not take was cached
// as "clock is fine" for six hours, a clock rolled backwards made that cache
// immortal, and a correction measured once was reapplied forever — so a user
// who followed our own warning and fixed their clock got wrong codes with no
// way to notice or clear it.
//
// Reading the code found none of these. Only the failure paths do.

import { areas, check, resetState, scenario } from './harness';

/** A fetch that answers only the hosts named here, and records what was asked. */
function stubFetch(handlers: Record<string, () => Promise<Response>>) {
  const original = (globalThis as any).fetch;
  const calls: string[] = [];
  (globalThis as any).fetch = async (input: any) => {
    const url = String(input);
    calls.push(url);
    for (const [host, handler] of Object.entries(handlers)) {
      if (url.includes(host)) return handler();
    }
    throw new Error(`unreachable host: ${url}`);
  };
  return {
    calls,
    restore: () => {
      (globalThis as any).fetch = original;
    },
  };
}

// The three sources answer in three different shapes, and two of them stamp
// whole seconds — the truncation the parser compensates for.
const akamaiSays = (ms: number) => async () =>
  new Response(new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z'));

const cloudflareSays = (ms: number) => async () =>
  new Response(`fl=1a2b\nh=cloudflare.com\nts=${Math.floor(ms / 1000).toFixed(3)}\nvisit_scheme=https\n`);

const timeApiSays = (ms: number) => async () => {
  const d = new Date(ms);
  return new Response(
    JSON.stringify({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      seconds: d.getUTCSeconds(),
      milliSeconds: d.getUTCMilliseconds(),
    })
  );
};

const dead = async () => {
  throw new Error('ENOTFOUND');
};

/** All three sources telling the truth. */
const honest = (trueMs: number) => ({
  'time.akamai.com': akamaiSays(trueMs),
  'timeapi.io': timeApiSays(trueMs),
  'cloudflare.com': cloudflareSays(trueMs),
});

const TRUE_MS = Date.UTC(2026, 7, 18, 12, 0, 0);

export async function run(): Promise<void> {
  const timeSync = await import('@/utils/time-sync');
  const totp = await import('@/utils/totp');

  /** Run `fn` with the device clock pinned to `deviceMs`. */
  const at = async <T>(deviceMs: number, fn: () => Promise<T>): Promise<T> => {
    const real = Date.now;
    (Date as any).now = () => deviceMs;
    try {
      return await fn();
    } finally {
      (Date as any).now = real;
    }
  };

  const fresh = async () => {
    await resetState();
    totp.setTimeOffsetMs(0);
  };

  /**
   * The correction code generation would apply at device time `deviceMs`.
   *
   * Read under the pinned clock, never the real one: a correction checks its
   * own age on every read now, and the real clock is weeks away from these
   * fixtures — read there, every correction would look long expired.
   */
  const offsetAt = (deviceMs: number) => at(deviceMs, async () => totp.getTimeOffsetMs());

  /** Let a renewal that a read set off run to the end, under the same clock. */
  const settle = (deviceMs: number) =>
    at(deviceMs, () => new Promise<void>((resolve) => setTimeout(resolve, 30)));

  scenario('Agreeing sources on a skewed clock warn and correct');
  await fresh();
  {
    const stub = stubFetch(honest(TRUE_MS));
    const notice = await at(TRUE_MS - 300_000, () => timeSync.getTimeSyncNotice());
    stub.restore();
    check('a notice is raised', notice !== null, String(notice));
    check('and it reads as five minutes', Math.abs((notice ?? 0) - 300) <= 2, String(notice));
    const applied = await offsetAt(TRUE_MS - 300_000);
    check('code generation is corrected', Math.abs(applied - 300_000) < 2_000, String(applied));
  }

  // The outage that started all of this: worldtimeapi.org stopped answering,
  // the pair could never agree again, and the feature went silent for months.
  scenario('One dead source no longer takes the feature down');
  await fresh();
  {
    const stub = stubFetch({ ...honest(TRUE_MS), 'time.akamai.com': dead });
    const result = await at(TRUE_MS - 300_000, () => timeSync.checkTimeSync());
    stub.restore();
    check('the two survivors still make a verdict', result.confident === true);
    check('the drift is reported', result.synced === false, String(result.offsetSeconds));
    check('and the correction is applied', Math.abs((await offsetAt(TRUE_MS - 300_000)) - 300_000) < 2_000);
  }

  scenario('A lone source is not evidence');
  await fresh();
  {
    const stub = stubFetch({ ...honest(TRUE_MS), 'time.akamai.com': dead, 'cloudflare.com': dead });
    const result = await at(TRUE_MS - 300_000, () => timeSync.checkTimeSync());
    stub.restore();
    check('not confident', result.confident === false);
    check('no alarm is raised on a guess', result.synced === true);
    check('and code generation is left alone', (await offsetAt(TRUE_MS - 300_000)) === 0);
  }

  scenario('An unverifiable reading is retried in minutes, not hours');
  await fresh();
  {
    // The device is five minutes slow throughout; only the network changes.
    const offline = stubFetch({});
    await at(TRUE_MS - 300_000, () => timeSync.checkTimeSync());
    offline.restore();
    check('the failed reading was cached', areas.local.timeSyncCache !== undefined);

    // Six minutes later the network is back. Under the old TTL this returned
    // the cached "fine" for six hours without touching the network at all.
    const laterTrueMs = TRUE_MS + 6 * 60_000;
    const stub = stubFetch(honest(laterTrueMs));
    const result = await at(laterTrueMs - 300_000, () => timeSync.checkTimeSync());
    stub.restore();
    check('the sources were asked again', stub.calls.length > 0, `${stub.calls.length} calls`);
    check('and the drift is finally seen', result.confident === true && result.synced === false);
  }

  scenario('A clock rolled backwards does not freeze the check forever');
  await fresh();
  {
    const first = stubFetch(honest(TRUE_MS));
    const before = await at(TRUE_MS, () => timeSync.checkTimeSync());
    first.restore();
    check('a healthy clock is cached', before.confident === true && before.synced === true);

    // The battery dies and the clock falls an hour behind: `Date.now()` is now
    // BEFORE the cache was written, which used to read as infinitely fresh.
    const stub = stubFetch(honest(TRUE_MS));
    const notice = await at(TRUE_MS - 3_600_000, () => timeSync.getTimeSyncNotice());
    stub.restore();
    check('the stale cache is not trusted', stub.calls.length > 0, `${stub.calls.length} calls`);
    check('and the hour of drift is reported', Math.abs((notice ?? 0) - 3600) <= 2, String(notice));
  }

  scenario('A correction expires instead of being reapplied forever');
  await fresh();
  {
    await at(TRUE_MS, () => totp.persistTimeOffset(300_000));

    // It lives as long as the measurement behind it and no longer: this was
    // 48 hours, which is how a clock the OS had since fixed kept getting
    // "corrected" by five minutes for two days.
    totp.setTimeOffsetMs(0);
    await at(TRUE_MS + 3 * 60_000, () => totp.loadTimeOffset());
    check('minutes later it still applies', (await offsetAt(TRUE_MS + 3 * 60_000)) === 300_000);

    totp.setTimeOffsetMs(0);
    await at(TRUE_MS + 10 * 60_000, () => totp.loadTimeOffset());
    check('ten minutes later it does not', (await offsetAt(TRUE_MS + 10 * 60_000)) === 0);
    check('and it is off the disk, not just ignored', areas.local.timeOffsetMs === undefined);
  }

  scenario('A correction from an older version is not trusted');
  await fresh();
  {
    // 1.11.0 and earlier stored a bare number with no timestamp, so its age is
    // unknowable — and users who fixed their clock have been carrying a wrong
    // one ever since.
    areas.local.timeOffsetMs = 300_000;
    await at(TRUE_MS, () => totp.loadTimeOffset());
    check('the undated correction is dropped', (await offsetAt(TRUE_MS)) === 0);
    check('and removed so it cannot come back', areas.local.timeOffsetMs === undefined);
  }

  scenario('The three outcomes are told apart, and a dismissal expires');
  await fresh();
  {
    const stub = stubFetch(honest(TRUE_MS));
    const ok = await at(TRUE_MS, () => timeSync.getClockStatus());
    stub.restore();
    check('a measured healthy clock reads ok', ok.state === 'ok' && ok.corrected === false, ok.state);

    // A dismissal from an earlier warning must not outlive the problem: left
    // behind, it silently suppresses the next warning of a similar size.
    await timeSync.dismissTimeNotice(300);
    const again = stubFetch(honest(TRUE_MS));
    await at(TRUE_MS, () => timeSync.recheckClock());
    again.restore();
    check('and clears a stale dismissal', areas.local.timeNoticeDismissedOffset === undefined);

    await fresh();
    const drifted = stubFetch(honest(TRUE_MS));
    const off = await at(TRUE_MS - 300_000, () => timeSync.getClockStatus());
    drifted.restore();
    check('a drifting clock reads off, and says it was corrected', off.state === 'off' && off.corrected);

    await fresh();
    const blocked = stubFetch({});
    const unknown = await at(TRUE_MS, () => timeSync.getClockStatus());
    blocked.restore();
    check('an unreachable pool reads unknown, not ok', unknown.state === 'unknown', unknown.state);
    check('and claims no correction', unknown.corrected === false);

    // Past the 12h cap the offset is deliberately NOT applied, so the UI must
    // not tell the user their codes were fixed.
    await fresh();
    const wild = stubFetch(honest(TRUE_MS));
    const capped = await at(TRUE_MS - 20 * 60 * 60_000, () => timeSync.getClockStatus());
    wild.restore();
    check('a wildly wrong clock is off but uncorrected', capped.state === 'off' && !capped.corrected);
    check('and code generation is left alone', totp.getTimeOffsetMs() === 0);
  }

  scenario('Check now measures again, even mid-flight');
  await fresh();
  {
    const warm = stubFetch(honest(TRUE_MS));
    await at(TRUE_MS, () => timeSync.getClockStatus());
    warm.restore();

    // A measurement is already under way when the button is pressed: its answer
    // came from the cache we are about to clear, so it is not an answer.
    //
    // Both under one pinned clock: two overlapping `at` calls unpin each other
    // in the wrong order, and the recheck then finished on the real clock.
    const fresh1 = stubFetch(honest(TRUE_MS));
    const rechecked = await at(TRUE_MS - 300_000, async () => {
      const pending = timeSync.getClockStatus();
      const answer = await timeSync.recheckClock();
      await pending;
      return answer;
    });
    fresh1.restore();

    check('the sources were actually asked', fresh1.calls.length > 0, `${fresh1.calls.length} calls`);
    check('and the new drift is what comes back', rechecked.state === 'off', rechecked.state);
  }

  scenario('A source that lies alone cannot move the clock');
  await fresh();
  {
    // One source eight seconds out, two honest: the pair wins, and the liar is
    // not the estimate even though nothing about it looks broken.
    const stub = stubFetch({ ...honest(TRUE_MS), 'timeapi.io': timeApiSays(TRUE_MS + 8_000) });
    const result = await at(TRUE_MS, () => timeSync.checkTimeSync());
    stub.restore();
    check('the majority is believed', result.confident === true);
    check('a healthy clock stays healthy', result.synced === true, String(result.offsetSeconds));
    check('and nothing is applied to code generation', totp.getTimeOffsetMs() === 0);
  }
  // The rest are the correction outliving the clock it was measured against.
  // The user sees our warning, fixes their clock (or the OS does), and codes
  // go on being shifted by the drift that is no longer there — the same size
  // error as before, pointed the other way.
  const ACCOUNT: any = { id: 'x', name: 'n', issuer: 'i', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 };
  const SLOW = 300_000; // the device clock, five minutes behind

  scenario('A correction does not outlive the clock being fixed');
  await fresh();
  {
    const measured = stubFetch(honest(TRUE_MS));
    await at(TRUE_MS - SLOW, () => timeSync.checkTimeSync());
    measured.restore();
    check('the drift is corrected while it lasts', Math.abs((await offsetAt(TRUE_MS - SLOW)) - SLOW) < 2_000);

    // A minute later the OS syncs and the device reads true time. Quick fill
    // and every new popup start from the stored record alone.
    const fixedAt = TRUE_MS + 60_000;
    totp.setTimeOffsetMs(0);
    await at(fixedAt, () => totp.loadTimeOffset());
    const shown = await at(fixedAt, async () => totp.generateTOTP(ACCOUNT).code);
    check('the old correction is not applied', (await offsetAt(fixedAt)) === 0, String(await offsetAt(fixedAt)));
    check('so the code is the one for the real time', shown === totp.generateCodeAt(ACCOUNT, fixedAt), shown);

    // Offline, nothing can re-measure: what Settings says has to be what codes do.
    const offline = stubFetch({});
    const status = await at(fixedAt, () => timeSync.getClockStatus());
    offline.restore();
    check('offline, the clock reads unknown', status.state === 'unknown', status.state);
    check('and "corrected" matches what codes use', status.corrected === ((await offsetAt(fixedAt)) !== 0));
  }

  scenario('A correction read back from disk is cleared by a check that fails');
  await fresh();
  {
    // Another page measured the slow clock and wrote the correction down.
    const measured = stubFetch(honest(TRUE_MS));
    await at(TRUE_MS - SLOW, () => timeSync.checkTimeSync());
    measured.restore();

    // A minute on, a new page loads it and "check now" finds the network gone.
    // This page never watched the clock under that correction, so it cannot
    // tell whether the OS fixed the clock in between — the correction goes
    // rather than being vouched for by a reading nobody took.
    const later = TRUE_MS - SLOW + 60_000;
    totp.setTimeOffsetMs(0);
    await at(later, () => totp.loadTimeOffset());
    check('it is loaded at first', Math.abs((await offsetAt(later)) - SLOW) < 2_000, String(await offsetAt(later)));
    const offline = stubFetch({});
    const status = await at(later, () => timeSync.recheckClock());
    offline.restore();
    const left = await offsetAt(later);
    check('nothing is applied on a reading we could not take', left === 0, String(left));
    check('and Settings does not say otherwise', status.state === 'unknown' && status.corrected === (left !== 0));
    check('and it is off the disk', areas.local.timeOffsetMs === undefined);
  }

  scenario('A small correction is not revived from a six-hour cache');
  await fresh();
  {
    // 45 seconds fast: "synced" (below the warning), and still corrected. That
    // combination used to earn the six-hour cache, and every cache hit put the
    // correction back — long after the clock under it had been fixed.
    const measured = stubFetch(honest(TRUE_MS));
    await at(TRUE_MS + 45_000, () => timeSync.checkTimeSync());
    measured.restore();
    check('it is corrected at first', Math.abs((await offsetAt(TRUE_MS + 45_000)) + 45_000) < 2_000);

    const hourLater = TRUE_MS + 45_000 + 60 * 60_000;
    totp.setTimeOffsetMs(0);
    await at(hourLater, () => totp.loadTimeOffset());
    const offline = stubFetch({});
    const status = await at(hourLater, () => timeSync.getClockStatus());
    offline.restore();
    const applied = await offsetAt(hourLater);
    check('an hour later it is not applied', applied === 0, String(applied));
    check('and the check was actually retried', offline.calls.length > 0, `${offline.calls.length} calls`);
    check('and nothing claims it is', !status.corrected);
  }

  scenario('A page left open notices the clock being stepped under it');
  await fresh();
  {
    // Sixty seconds slow: small enough that the OS stepping it forward keeps
    // the measurement inside every age limit. Only the monotonic clock, which
    // did not step, can tell that the wall clock moved.
    const measured = stubFetch(honest(TRUE_MS));
    await at(TRUE_MS - 60_000, () => timeSync.checkTimeSync());
    measured.restore();
    check('the drift is corrected', Math.abs((await offsetAt(TRUE_MS - 60_000)) - 60_000) < 2_000);

    const renewed = stubFetch(honest(TRUE_MS));
    const afterJump = await offsetAt(TRUE_MS);
    await settle(TRUE_MS);
    renewed.restore();
    check('the step drops the correction at once', afterJump === 0, String(afterJump));
    check('and sets off a new measurement', renewed.calls.length > 0, `${renewed.calls.length} calls`);
    check('which finds nothing left to correct', (await offsetAt(TRUE_MS)) === 0);
  }

  scenario('A page left open renews its correction, and drops it when it cannot');
  await fresh();
  {
    const start = TRUE_MS - SLOW;
    const measured = stubFetch(honest(TRUE_MS));
    await at(start, () => timeSync.checkTimeSync());
    measured.restore();

    // The side panel is open for days. Near the end of a correction's life it
    // asks for a new measurement, so a healthy one never lapses. The clock is
    // simply read later here — no jump — while the monotonic clock stands
    // still, so the renewal is set off by age alone.
    const nearEnd = 4.5 * 60_000;
    const renewal = stubFetch(honest(TRUE_MS + nearEnd));
    const stillApplied = await at(start + nearEnd, async () => {
      totp.setTimeOffsetMs(SLOW, nearEnd);
      return totp.getTimeOffsetMs();
    });
    await settle(start + nearEnd);
    renewal.restore();
    check('it still applies near the end', stillApplied === SLOW, String(stillApplied));
    check('and a renewal was asked for', renewal.calls.length > 0, `${renewal.calls.length} calls`);
    check('and written down as new', (areas.local.timeOffsetMs as any)?.at === start + nearEnd);

    // Past its life with nothing to renew it — offline — it goes, rather than
    // being applied for as long as the page stays open.
    const offline = stubFetch({});
    const expired = await at(start + nearEnd, async () => {
      totp.setTimeOffsetMs(SLOW, 6 * 60_000);
      return totp.getTimeOffsetMs();
    });
    await settle(start + nearEnd);
    offline.restore();
    check('a correction past its life is dropped', expired === 0, String(expired));
    check('and the failed renewal leaves it dropped', (await offsetAt(start + nearEnd)) === 0);
  }
  // ---- Pages that stay open ------------------------------------------------
  //
  // `at` pins only the wall clock, which to a page that took a measurement
  // itself reads as the clock being stepped under it. The scenarios below are
  // about time simply passing, so both clocks move together.

  const steadyClocks = (wallMs: number) => {
    const realNow = Date.now;
    let wall = wallMs;
    let mono = 1_000_000;
    (Date as any).now = () => wall;
    (performance as any).now = () => mono;
    return {
      advance(ms: number) {
        wall += ms;
        mono += ms;
      },
      get wall() {
        return wall;
      },
      restore() {
        (Date as any).now = realNow;
        delete (performance as any).now;
      },
    };
  };

  /** setTimeout, with every timer of `minMs` or longer held back to be run by hand. */
  const holdTimers = (minMs: number) => {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const held: Array<{ delay: number; run: () => void }> = [];
    (globalThis as any).setTimeout = (fn: () => void, delay = 0, ...rest: unknown[]) => {
      if (delay < minMs) return realSet(fn, delay, ...rest);
      const entry = { delay, run: fn };
      held.push(entry);
      return entry;
    };
    (globalThis as any).clearTimeout = (handle: any) => {
      const at = held.indexOf(handle);
      if (at >= 0) held.splice(at, 1);
      else realClear(handle);
    };
    return {
      held,
      restore() {
        globalThis.setTimeout = realSet;
        globalThis.clearTimeout = realClear;
      },
    };
  };

  const turn = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  // The side panel measured, and four and a half minutes later asked for a
  // renewal while the Wi-Fi was down. The failure used to clear a correction
  // with a minute of life left — and 0 being the one value that asks for no
  // renewal, nothing measured again for as long as the panel stayed open.
  scenario('A renewal that fails keeps a correction this page is still watching');
  await fresh();
  {
    const clocks = steadyClocks(TRUE_MS - SLOW);
    try {
      const measured = stubFetch(honest(TRUE_MS));
      await timeSync.checkTimeSync();
      measured.restore();
      const measuredAt = (areas.local.timeOffsetMs as any)?.at;
      check('the drift is corrected', Math.abs(totp.getTimeOffsetMs() - SLOW) < 2_000);

      clocks.advance(4.5 * 60_000);
      const offline = stubFetch({});
      totp.getTimeOffsetMs();
      await turn();
      const renewalCalls = offline.calls.length;
      check('a renewal was attempted', renewalCalls > 0, `${renewalCalls} calls`);
      // The side panel reads the correction every second; the failed renewal
      // must not be asked for again on every one of them.
      for (let i = 0; i < 10; i++) {
        clocks.advance(1_000);
        totp.getTimeOffsetMs();
        await turn(0);
      }
      offline.restore();
      check('and not asked for again on every read', offline.calls.length === renewalCalls, `${offline.calls.length} calls`);
      const kept = totp.getTimeOffsetMs();
      check('the failed renewal leaves the correction in force', Math.abs(kept - SLOW) < 2_000, String(kept));
      check('without restamping it as new', (areas.local.timeOffsetMs as any)?.at === measuredAt);

      const status = await timeSync.getClockStatus();
      check(
        'and Settings says it is corrected, not "unknown, device clock as-is"',
        status.state === 'off' && status.corrected,
        JSON.stringify(status)
      );
      check('and the banner stays up', (await timeSync.getTimeSyncNotice()) !== null);

      clocks.advance(60_000);
      const stillOffline = stubFetch({});
      const lapsed = totp.getTimeOffsetMs();
      await turn();
      stillOffline.restore();
      check('past its own life it lapses all the same', lapsed === 0, String(lapsed));
    } finally {
      clocks.restore();
    }
  }

  scenario('A page left open measures again when the network comes back');
  await fresh();
  {
    const clocks = steadyClocks(TRUE_MS - SLOW);
    const timers = holdTimers(60_000);
    const events: Record<string, () => void> = {};
    (globalThis as any).addEventListener = (type: string, listener: () => void) => {
      events[type] = listener;
    };
    (globalThis as any).removeEventListener = (type: string) => {
      delete events[type];
    };
    const readings: Array<{ confident: boolean; synced: boolean }> = [];
    const stop = timeSync.watchClock((result) => readings.push(result));
    try {
      const offline = stubFetch({});
      await timeSync.checkTimeSync();
      check('the reading is handed to the page', readings.length === 1 && !readings[0].confident);
      check(
        'and a retry is lined up a minute out',
        timers.held.length === 1 && timers.held[0].delay === 60_000,
        timers.held.map((t) => t.delay).join()
      );

      // Still down: each retry waits longer, never more than five minutes.
      const delays: number[] = [];
      for (let i = 0; i < 4; i++) {
        timers.held.shift()!.run();
        await turn();
        delays.push(timers.held[0]?.delay ?? -1);
      }
      offline.restore();
      check('backing off to five minutes', delays.join() === '120000,240000,300000,300000', delays.join());

      // The network returns, and the page does not sit out the backoff.
      const back = stubFetch(honest(TRUE_MS));
      events.online?.();
      await turn();
      back.restore();
      check('the sources are asked at once', back.calls.length > 0, `${back.calls.length} calls`);
      const restored = totp.getTimeOffsetMs();
      check('the correction is back', Math.abs(restored - SLOW) < 2_000, String(restored));
      const last = readings[readings.length - 1];
      check('the page hears about it', last?.confident === true && last?.synced === false);
      check('and no retry is left behind', timers.held.length === 0, String(timers.held.length));
    } finally {
      stop();
      timers.restore();
      clocks.restore();
    }
    check('stopping the watch removes its listener', events.online === undefined);
    delete (globalThis as any).addEventListener;
    delete (globalThis as any).removeEventListener;
  }

  // A popup opened more than five minutes after the last one finds its stored
  // correction expired, and drew uncorrected codes for the second or three the
  // new measurement took — codes from the clock that needed correcting.
  scenario('A page opened after a correction lapsed shows the clock being checked');
  await fresh();
  {
    await at(TRUE_MS - SLOW, () => totp.persistTimeOffset(SLOW));
    let notified = 0;
    const unsubscribe = totp.subscribeTimeOffset(() => notified++);
    const opened = TRUE_MS - SLOW + 10 * 60_000;
    const timers = holdTimers(5_000);
    try {
      await at(opened, () => totp.loadTimeOffset());
      check('codes wait for the measurement', totp.isTimeOffsetPending());
      await turn(0);
      check('and whoever draws them is told', notified > 0, String(notified));

      const stub = stubFetch(honest(TRUE_MS + 10 * 60_000));
      await at(opened, () => timeSync.checkTimeSync());
      stub.restore();
      check('the measurement ends the wait', !totp.isTimeOffsetPending());
      check('with the correction back', Math.abs((await offsetAt(opened)) - SLOW) < 2_000);

      // Nothing ever measures: the wait is bounded, never permanent.
      const muchLater = opened + 20 * 60_000;
      await at(muchLater, () => totp.loadTimeOffset());
      check('pending again on the next stale open', totp.isTimeOffsetPending());
      const cap = timers.held.find((t) => t.delay <= 5_000);
      check('with a limit of five seconds', cap !== undefined, timers.held.map((t) => t.delay).join());
      cap?.run();
      check('after which codes are drawn regardless', !totp.isTimeOffsetPending());
    } finally {
      timers.restore();
      unsubscribe();
    }

    await fresh();
    areas.local.timeOffsetMs = 300_000;
    await at(TRUE_MS, () => totp.loadTimeOffset());
    check('an undated correction of unknown age does not make codes wait', !totp.isTimeOffsetPending());
  }

  // Three sources, and two was a majority: two answering the same wrong time
  // moved every code by up to the twelve-hour cap while the third, and the
  // device, both said otherwise.
  scenario('Two sources agreeing against the third do not move the clock');
  await fresh();
  {
    const stub = stubFetch({
      'time.akamai.com': akamaiSays(TRUE_MS + 600_000),
      'timeapi.io': timeApiSays(TRUE_MS + 600_000),
      'cloudflare.com': cloudflareSays(TRUE_MS),
    });
    const result = await at(TRUE_MS, () => timeSync.checkTimeSync());
    const notice = await at(TRUE_MS, () => timeSync.getTimeSyncNotice());
    stub.restore();
    check('the reading is not trusted', result.confident === false);
    check('no correction is applied', (await offsetAt(TRUE_MS)) === 0);
    check('and no alarm is raised', notice === null, String(notice));
  }

  scenario('A clock hours out is still corrected when the answers agree');
  for (const [label, handlers] of [
    ['all three answering', honest(TRUE_MS)],
    ['one of them down', { ...honest(TRUE_MS), 'timeapi.io': dead }],
  ] as const) {
    await fresh();
    // The time zone written to the hardware clock as UTC: five hours out.
    const device = TRUE_MS - 5 * 3_600_000;
    const stub = stubFetch(handlers);
    const status = await at(device, () => timeSync.getClockStatus());
    stub.restore();
    const applied = await offsetAt(device);
    check(
      `${label}: five hours slow is corrected`,
      status.state === 'off' && status.corrected && Math.abs(applied - 5 * 3_600_000) < 2_000,
      `${JSON.stringify(status)} ${applied}`
    );
  }

  // ---- The codes on screen ---------------------------------------------------

  scenario('A code is computed once per slot, not once per second');
  await fresh();
  {
    let reads = 0;
    const counted: any = { id: 'counted', name: 'n', issuer: 'i', algorithm: 'SHA1', digits: 6, period: 30 };
    Object.defineProperty(counted, 'secret', {
      get() {
        reads++;
        return ACCOUNT.secret;
      },
    });
    const slot = Math.floor(TRUE_MS / 30_000) * 30_000;
    let live = totp.advanceTOTP(counted, null, slot);
    let unchanged = 0;
    for (let ms = slot; ms < slot + 30_000; ms += 250) {
      const next = totp.advanceTOTP(counted, live, ms);
      if (next === live) unchanged++;
      live = next;
    }
    check('one HMAC for the whole slot', reads === 1, `${reads} secret reads`);
    check('while the countdown still moves', live.totp?.remaining === 1, String(live.totp?.remaining));
    // 120 reads, four a second; the second changes 29 times within the slot.
    check('and a tick within the same second changes nothing at all', unchanged === 120 - 29, String(unchanged));

    const turned = totp.advanceTOTP(counted, live, slot + 30_000 + 15);
    check(
      'a new slot is a new code, and the right one',
      turned.totp?.code === totp.generateCodeAt(ACCOUNT, slot + 30_000) && turned.totp?.remaining === 30,
      `${turned.totp?.code} ${turned.totp?.remaining}`
    );

    const steam = { ...ACCOUNT, id: 'steam', type: 'steam' };
    const steamLive = totp.advanceTOTP(steam, null, slot + 1_000);
    check(
      'Steam codes come through the same path',
      steamLive.totp?.code === totp.generateCodeAt(steam, slot + 1_000) && /^[2-9BCDFGHJKMNPQRTVWXY]{5}$/.test(steamLive.totp?.code ?? ''),
      steamLive.totp?.code
    );

    const broken = { ...ACCOUNT, id: 'broken', secret: '1' };
    const brokenLive = totp.advanceTOTP(broken, null, slot);
    check('a broken secret is a row without a code', brokenLive.totp === null);
    check('and is not retried every second', totp.advanceTOTP(broken, brokenLive, slot + 1_000) === brokenLive);
  }

  scenario('Every code on the page turns over together, on the second');
  await fresh();
  {
    const ticker = await import('@/utils/ticker');
    check('the tick lands just past the next second', ticker.msUntilNextSecond(1_700_000_000_400) === 615);

    const clocks = steadyClocks(1_700_000_000_500);
    const timers = holdTimers(1);
    try {
      totp.setTimeOffsetMs(1_250);
      let ticks = 0;
      const stop = ticker.onEverySecond(() => ticks++);
      const second = ticker.onEverySecond(() => ticks++);
      check('one timer for the whole page', timers.held.length === 1, String(timers.held.length));
      check(
        'aligned to the corrected second, not the device one',
        timers.held[0]?.delay === 265,
        String(timers.held[0]?.delay)
      );
      timers.held.shift()!.run();
      check('every listener hears the same tick', ticks === 2, String(ticks));
      check('and the next one is lined up', timers.held.length === 1);

      totp.setTimeOffsetMs(3_000);
      await turn(0);
      check('a new correction redraws at once', ticks === 4, String(ticks));

      second();
      stop();
      check('with nobody left listening, no timer is left', timers.held.length === 0, String(timers.held.length));
    } finally {
      totp.setTimeOffsetMs(0);
      timers.restore();
      clocks.restore();
    }
  }
}
