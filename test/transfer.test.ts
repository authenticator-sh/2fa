// Moving accounts to another app by QR.
//
// Other authenticator apps may quietly ignore a non-standard period, digit
// count or algorithm and show wrong codes, so we have to name them first.

import { check, scenario } from './harness';
import type { Account } from '../src/types';

const base: Account = {
  id: 'x',
  name: 'me@example.com',
  issuer: 'Example',
  secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  createdAt: 1,
};

export async function run() {
  const { nonStandardParams } = await import('../src/utils/transfer');

  scenario('Non-standard settings are named, standard ones are not');
  check('standard settings', nonStandardParams(base).length === 0);
  check(
    'all three differ, in order',
    JSON.stringify(nonStandardParams({ ...base, period: 60, digits: 8, algorithm: 'SHA256' })) ===
      JSON.stringify([
        { kind: 'period', value: 60 },
        { kind: 'digits', value: 8 },
        { kind: 'algorithm', value: 'SHA256' },
      ]),
  );
  check(
    'only digits differ',
    JSON.stringify(nonStandardParams({ ...base, digits: 7 })) === JSON.stringify([{ kind: 'digits', value: 7 }]),
  );
  const old = { ...base } as Partial<Account>;
  delete old.period;
  delete old.digits;
  check('missing period/digits repair to standard', nonStandardParams(old as Account).length === 0);
  check('steam is never flagged', nonStandardParams({ ...base, type: 'steam', digits: 5 }).length === 0);
  const noAlgo = { ...base } as Partial<Account>;
  delete noAlgo.algorithm;
  check('missing algorithm is SHA1', nonStandardParams(noAlgo as Account).length === 0);
  check(
    'lowercase algorithm is normalized',
    JSON.stringify(nonStandardParams({ ...base, algorithm: 'sha256' as Account['algorithm'] })) ===
      JSON.stringify([{ kind: 'algorithm', value: 'SHA256' }]),
  );
  check(
    'only period differs',
    JSON.stringify(nonStandardParams({ ...base, period: 60 })) === JSON.stringify([{ kind: 'period', value: 60 }]),
  );
}
