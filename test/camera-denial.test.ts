// Why a camera was refused decides what the scan page tells the person to do.

import { check } from './harness';

export async function run(): Promise<void> {
  const { classifyDenial } = await import('@/utils/camera-denial');

  check('a site setting of Block is blocked', classifyDenial('NotAllowedError', 'Permission denied', 'denied') === 'blocked');
  check('a closed question is dismissed, by the message', classifyDenial('NotAllowedError', 'Permission dismissed', 'prompt') === 'dismissed');
  check('a closed question is dismissed, by the state alone', classifyDenial('NotAllowedError', '', 'prompt') === 'dismissed');
  check('the system refusing is the system', classifyDenial('NotAllowedError', 'Permission denied by system', 'granted') === 'system');
  check('allowed for the site yet refused is the system', classifyDenial('NotAllowedError', 'Permission denied', 'granted') === 'system');
  check('a security error is blocked', classifyDenial('SecurityError', '', null) === 'blocked');
  check('unknown state defaults to blocked, the one with a way out', classifyDenial('NotAllowedError', 'Permission denied', null) === 'blocked');
}
