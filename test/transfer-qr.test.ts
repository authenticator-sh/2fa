// Moving accounts to a phone by QR code (utils/transfer-qr.ts).
//
// The failure that matters is silent: a code that scans fine and adds an
// account generating the wrong digits. So every account built into a code is
// read back by the same parser the scanner uses, and compared field by field
// and by the code it generates.

import { check, scenario } from './harness';

let n = 0;
function account(over: Record<string, unknown> = {}): any {
  n++;
  return {
    id: `t${n}`,
    name: `user${n}@example.com`,
    issuer: `Service ${n}`,
    secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    createdAt: 1700000000000 + n,
    ...over,
  };
}

// Distinct secrets, so a code that mixed accounts up would be caught.
const SECRETS = [
  'JBSWY3DPEHPK3PXP', 'KRSXG5CTMVRXEZLU', 'MFRGGZDFMZTWQ2LK', 'GEZDGNBVGY3TQOJQ', 'ONSWG4TFOQ======',
  'NBSWY3DPO5XXE3DE', 'IFBEGRCFIZDUQSKK', 'OVZWK4TOMFWWK2LM', 'MZXW6YTBOI======', 'KNXW2ZJAONSWG4TF',
];

export async function run(): Promise<void> {
  const { buildTransferCodes, MAX_ACCOUNTS_PER_CODE, MAX_CODE_TEXT } = await import('@/utils/transfer-qr');
  const { parseQRCode } = await import('@/utils/qr-parser');
  const { generateCodeAt, cleanSecret } = await import('@/utils/totp');
  const { drawQR } = await import('@/utils/qr-encode');

  const sameCode = (a: any, b: any) => {
    const at = 1_731_000_000_000;
    return generateCodeAt(a, at) === generateCodeAt(b, at) && generateCodeAt(a, at + 30_000) === generateCodeAt(b, at + 30_000);
  };

  /** Everything the codes carry, read back the way the scanner reads them. */
  const readBack = (codes: { text: string }[]) =>
    codes.flatMap(code => {
      const parsed = parseQRCode(code.text);
      return parsed ? parsed.accounts : [];
    });

  scenario('Three ordinary accounts: one code, every field and every code survives');
  {
    const accounts = [
      account({ secret: SECRETS[0] }),
      account({ secret: SECRETS[1], algorithm: 'SHA256', digits: 8 }),
      account({ secret: SECRETS[2], algorithm: 'SHA512' }),
    ];
    const plan = buildTransferCodes(accounts, 12345);
    check('one code', plan.codes.length === 1, `got ${plan.codes.length}`);
    check('it is a migration code', plan.codes[0]?.kind === 'migration');
    check('in Google Authenticator\'s format', plan.codes[0]?.text.startsWith('otpauth-migration://offline?data=') === true);
    const parsed = parseQRCode(plan.codes[0]!.text);
    check('the scanner reads it as a migration', parsed?.type === 'migration');
    check('nothing skipped on the far side', (parsed?.skipped ?? -1) === 0);
    check('a single code is not called "1 of 1"', parsed?.batch === undefined);
    const back = parsed?.accounts ?? [];
    check('three accounts come back', back.length === 3, `got ${back.length}`);
    accounts.forEach((original, i) => {
      const got = back[i] as any;
      check(`#${i + 1}: secret`, got && cleanSecret(got.secret).replace(/=+$/, '') === original.secret.replace(/=+$/, ''), got?.secret);
      check(`#${i + 1}: name`, got?.name === original.name, got?.name);
      check(`#${i + 1}: issuer`, got?.issuer === original.issuer, got?.issuer);
      check(`#${i + 1}: algorithm`, got?.algorithm === original.algorithm, got?.algorithm);
      check(`#${i + 1}: digits`, got?.digits === original.digits, String(got?.digits));
      check(`#${i + 1}: the same codes`, got && sameCode(original, { ...got, period: got.period }));
    });
  }

  scenario('Twenty-five accounts: split into numbered codes of at most ten');
  {
    const accounts = Array.from({ length: 25 }, (_, i) => account({ secret: SECRETS[i % SECRETS.length] }));
    const plan = buildTransferCodes(accounts, 777);
    check('three codes', plan.codes.length === 3, `got ${plan.codes.length}`);
    check('none holds more than ten', plan.codes.every(c => c.accounts.length <= MAX_ACCOUNTS_PER_CODE));
    plan.codes.forEach((code, i) => {
      const parsed = parseQRCode(code.text);
      check(`code ${i + 1} says it is ${i + 1} of 3`, parsed?.batch?.index === i + 1 && parsed?.batch?.total === 3, JSON.stringify(parsed?.batch));
    });
    const back = readBack(plan.codes);
    check('all twenty-five come back, in order', back.length === 25 && back.every((a, i) => a.name === accounts[i].name));
  }

  scenario('Long names: a code closes before it gets too dense to scan off a screen');
  {
    const long = 'x'.repeat(60);
    const accounts = Array.from({ length: 10 }, (_, i) =>
      account({ secret: SECRETS[i], name: `${long}${i}@example.com`, issuer: `Issuer with a long name ${i}` })
    );
    const plan = buildTransferCodes(accounts);
    check('split into more than one code', plan.codes.length > 1, `got ${plan.codes.length}`);
    check(
      `every code within ${MAX_CODE_TEXT} characters`,
      plan.codes.every(c => c.text.length <= MAX_CODE_TEXT),
      plan.codes.map(c => c.text.length).join(', ')
    );
    check('still all ten', readBack(plan.codes).length === 10);
  }

  scenario('What the batch format cannot say gets a code of its own');
  {
    const odd = [
      account({ secret: SECRETS[3], period: 60 }),
      account({ secret: SECRETS[4], digits: 7 }),
      account({ secret: SECRETS[5], type: 'steam', digits: 5, issuer: 'Steam' }),
    ];
    const plain = account({ secret: SECRETS[6] });
    const plan = buildTransferCodes([odd[0], plain, odd[1], odd[2]]);
    check('one batch first, then three single codes', plan.codes.length === 4 && plan.codes[0].kind === 'migration' && plan.codes.slice(1).every(c => c.kind === 'single'));
    check('the batch holds only the plain one', plan.codes[0].accounts.length === 1 && plan.codes[0].accounts[0] === plain);
    for (const code of plan.codes.slice(1)) {
      const original = code.accounts[0];
      const parsed = parseQRCode(code.text);
      const got = parsed?.accounts[0] as any;
      check(`${original.issuer}: read as a single account`, parsed?.type === 'single');
      check(`${original.issuer}: period ${original.period}`, got?.period === original.period, String(got?.period));
      check(`${original.issuer}: same codes`, got && sameCode(original, got));
    }
    const steam = parseQRCode(plan.codes[3].text)?.accounts[0];
    check('Steam stays Steam', steam?.type === 'steam');
  }

  scenario('Names that are easy to get wrong');
  {
    const accounts = [
      account({ secret: SECRETS[7], issuer: '', name: 'a:b@example.com' }),
      account({ secret: SECRETS[8], issuer: 'Яндекс', name: 'пользователь@пример.рф' }),
      account({ secret: SECRETS[9], issuer: 'Acme & Co', name: 'Ops team 日本' }),
      account({ secret: 'ONSWG4TFOQ======' }),
    ];
    const back = readBack(buildTransferCodes(accounts).codes);
    check('no issuer and a colon in the name: the name stays whole', back[0]?.issuer === '' && back[0]?.name === 'a:b@example.com', `${back[0]?.issuer} / ${back[0]?.name}`);
    check('Cyrillic', back[1]?.issuer === 'Яндекс' && back[1]?.name === 'пользователь@пример.рф');
    check('symbols and CJK', back[2]?.issuer === 'Acme & Co' && back[2]?.name === 'Ops team 日本');
    check('a padded secret gives the same codes', back[3] && sameCode(accounts[3], back[3]));
  }

  scenario('A secret that cannot be read is left out and reported, not encoded');
  {
    const bad = account({ secret: '!!' });
    const plan = buildTransferCodes([account({ secret: SECRETS[0] }), bad]);
    check('reported as skipped', plan.skipped.length === 1 && plan.skipped[0] === bad);
    check('the other one still goes', readBack(plan.codes).length === 1);
  }

  scenario('Every code can be drawn');
  {
    const big = buildTransferCodes(Array.from({ length: 10 }, (_, i) => account({ secret: SECRETS[i] })));
    const drawing = await drawQR(big.codes[0].text, 'L');
    check('a full code of ten draws', drawing.size > 0 && drawing.size <= 101, `size ${drawing.size}`);
  }
}
