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
  const { buildMigrationURLs, parseMigrationURL, migrationSkipReason, MIGRATION_MAX_URL_LENGTH } = await import(
    '../src/utils/migration-parser'
  );
  const { cleanSecret } = await import('../src/utils/totp');
  const sameSecret = (a: string, b: string) => cleanSecret(a).replace(/=+$/, '') === cleanSecret(b).replace(/=+$/, '');
  const many = (n: number, extra: Partial<Account> = {}): Account[] =>
    Array.from({ length: n }, (_, i) => ({ ...base, id: `a${i}`, name: `user${i}@example.com`, ...extra }));

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

  scenario('Every exported account reads back as itself');
  const trio: Account[] = [
    { ...base, id: 'p', issuer: 'Acme: Inc', name: 'ops@acme.test', secret: 'jbsw y3dp ehpk 3pxp' },
    { ...base, id: 'q', issuer: 'Bank', name: 'Банк 🙂', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' },
    { ...base, id: 'r', issuer: '', name: 'plain@example.com', secret: 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U' },
  ];
  const trioOut = buildMigrationURLs(trio);
  check('one batch, nothing skipped', trioOut.batches.length === 1 && trioOut.skipped.length === 0);
  const trioBack = parseMigrationURL(trioOut.batches[0].url);
  check('it parses', trioBack !== null && trioBack.accounts.length === 3);
  if (trioBack) {
    trio.forEach((a, i) => {
      const b = trioBack.accounts[i];
      check(`account ${i}: secret`, sameSecret(a.secret, b.secret));
      check(`account ${i}: name`, b.name === a.name);
      check(`account ${i}: issuer`, b.issuer === a.issuer);
      check(
        `account ${i}: standard TOTP`,
        b.algorithm === 'SHA1' && b.digits === 6 && b.type === 'totp',
      );
    });
    check('nothing unreadable', trioBack.unreadable === 0);
    check('code 1 of 1', trioBack.batchIndex === 0 && trioBack.batchSize === 1);
  }
  check('the batch lists its accounts', trioOut.batches[0].accounts.map((a) => a.id).join() === 'p,q,r');

  scenario('Ten fit in one code, eleven take two');
  check('ten → one', buildMigrationURLs(many(10)).batches.length === 1);
  const eleven = buildMigrationURLs(many(11)).batches;
  check('eleven → two', eleven.length === 2);
  check('the second holds one', eleven[1]?.accounts.length === 1);
  const first = parseMigrationURL(eleven[0].url);
  const second = parseMigrationURL(eleven[1].url);
  check('both say there are two', first?.batchSize === 2 && second?.batchSize === 2);
  check('and which one each is', first?.batchIndex === 0 && second?.batchIndex === 1);
  check('ten then one read back', first?.accounts.length === 10 && second?.accounts.length === 1);

  scenario('Long labels close a batch early');
  const long = many(10).map((a, i) => ({ ...a, name: `${i}`.padEnd(200, 'x') }));
  const longOut = buildMigrationURLs(long).batches;
  check('more than one code', longOut.length > 1);
  check(
    `every code within ${MIGRATION_MAX_URL_LENGTH} characters`,
    longOut.every((b) => b.url.length <= MIGRATION_MAX_URL_LENGTH || b.accounts.length === 1),
  );
  check(
    'all ten, in order',
    longOut.flatMap((b) => b.accounts.map((a) => a.id)).join() === long.map((a) => a.id).join(),
  );
  check(
    'and each code reads back what it lists',
    longOut.every((b) => parseMigrationURL(b.url)?.accounts.map((a) => a.name).join() === b.accounts.map((a) => a.name).join()),
  );
  const huge = buildMigrationURLs([{ ...base, name: 'y'.repeat(2000) }]).batches;
  check('one account too long for the limit still gets its code', huge.length === 1 && huge[0].accounts.length === 1);

  scenario('What cannot go is named, not dropped');
  const odd: Account[] = [
    { ...base, id: 'steam', type: 'steam' },
    { ...base, id: 'secret', secret: '!!!' },
    { ...base, id: 'period', period: 60 },
    { ...base, id: 'digits', digits: 8 },
    { ...base, id: 'algo', algorithm: 'SHA256' },
  ];
  const oddOut = buildMigrationURLs([...odd, { ...base, id: 'ok' }]);
  const reasons = Object.fromEntries(oddOut.skipped.map((s) => [s.account.id, s.reason]));
  check('steam', reasons.steam === 'steam');
  check('bad secret', reasons.secret === 'secret');
  check('period', reasons.period === 'period');
  check('digits', reasons.digits === 'params');
  check('algorithm', reasons.algo === 'params');
  check('every one of them counted', oddOut.skipped.length === odd.length);
  check(
    'none of them in a code',
    oddOut.batches.flatMap((b) => b.accounts.map((a) => a.id)).join() === 'ok',
  );
  check('a standard one has no reason', migrationSkipReason(base) === null);
  check('period is named before params', migrationSkipReason({ ...base, period: 60, digits: 8 }) === 'period');
  check('steam is named before a bad secret', migrationSkipReason({ ...base, type: 'steam', secret: '!!!' }) === 'steam');
  check('nothing exportable, no codes', buildMigrationURLs(odd).batches.length === 0);

  scenario('URLs are ASCII');
  const all = [...trioOut.batches, ...eleven, ...longOut];
  check('printable ASCII only', all.every((b) => /^[\x21-\x7e]+$/.test(b.url)));
  check('the migration scheme', all.every((b) => b.url.startsWith('otpauth-migration://offline?data=')));
  check(
    'a given batch id writes the same codes',
    buildMigrationURLs(trio, 12345).batches[0].url === buildMigrationURLs(trio, 12345).batches[0].url,
  );
}
