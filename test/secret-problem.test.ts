// What the manual form says about a refused secret.

import { check } from './harness';

export async function run(): Promise<void> {
  const { secretProblem, validateSecret } = await import('@/utils/totp');

  check('a 6-digit code is named as a code', secretProblem('123456') === 'code');
  check('a spaced 6-digit code too', secretProblem('123 456') === 'code');
  check('0, 1, 8, 9 are the wrong characters', secretProblem('JBSWY3DPEHPK3PX0') === 'chars');
  check('symbols are the wrong characters', secretProblem('JBSWY3DP@HPK3PXP') === 'chars');
  check('a half key is short', secretProblem('JBSWY3DP') === 'short');
  check('a good key has no problem', secretProblem('JBSWY3DPEHPK3PXP') === null);
  check('grouped, lower-case keys are not a problem', secretProblem('jbsw y3dp-ehpk-3pxp') === null);
  check('every problem is also a refusal', !validateSecret('123456') && !validateSecret('JBSWY3DP') && !validateSecret('JBSWY3DPEHPK3PX0'));
}
