// Where a registrable domain ends: a hand-sized cut of the Public Suffix List.
//
// Taken from https://publicsuffix.org/list/public_suffix_list.dat, version
// 2026-09-24_13-26-36_UTC (commit a179a48c), on 2026-09-29. Regenerate from
// that file rather than editing by hand, and keep the same cut:
//
// - ICANN section: every two-label rule under a country-code TLD whose first
//   label is at most four letters (go.kr, ne.jp, co.uk, gob.mx, gc.ca), plus a
//   few longer institutional ones (gouv.fr, govt.nz, police.uk, parliament.nz).
//   What is left out is almost entirely place names — tokyo.jp, seoul.kr, the
//   Norwegian and Italian municipalities — where two neighbours sharing a
//   history is a small cost against shipping the whole list to every popup.
// - The seven country codes that are wildcards in the list (`*.ck` and so on),
//   and the one exception among them.
// - From the PRIVATE section, only hosting platforms people actually sign in
//   through or get phished from: one tenant per subdomain, and a tenant is not
//   its neighbour.
//
// The whole list is about 10,000 rules and 330 KB; this is the part that
// decides something for the sites a 2FA code is typed into.

/** Second-level labels that are public suffixes, keyed by their TLD. */
const ICANN_SECOND_LEVEL: Record<string, string> = {
  ac: 'com edu gov mil net org',
  ae: 'ac co gov mil net org sch',
  af: 'com edu gov net org',
  ag: 'co com net nom org',
  ai: 'com net off org',
  al: 'com edu gov mil net org',
  am: 'co com net org',
  ao: 'co ed edu gov gv it og org pb',
  ar: 'bet com coop edu gob gov int mil net org seg tur',
  as: 'gov',
  at: 'ac co gv or',
  au: 'asn com edu gov id net org conf oz act nsw nt qld sa tas vic wa',
  aw: 'com',
  az: 'biz co com edu gov info int mil name net org pp pro',
  ba: 'com edu gov mil net org',
  bb: 'biz co com edu gov info net org tv',
  bd: 'ac ai co com edu gov id info it mil net org sch tv',
  be: 'ac',
  bf: 'gov',
  bg: '0 1 2 3 4 5 6 7 8 9 a b c d e f g h i j k l m n o p q r s t u v w x y z',
  bh: 'com edu gov net org',
  bi: 'co com edu or org',
  bj: 'agro co com eco edu info net org ote univ',
  bm: 'com edu gov net org',
  bn: 'com edu gov net org',
  bo: 'com edu gob int mil net org tv web agro arte blog ia info wiki',
  br: 'abc adm adv agr aju am api app arq art ato b bet bhz bib bio blog bmd bsb cim cng cnt com coop coz cri def des det dev ecn eco edu emp enf eng esp etc eti far flog fm fnd fot foz fst g12 geo ggf gov gru ia imb ind inf jab jdf jor jus leg lel log mat med mil mp mus net not ntr odo ong org poa ppg pro psc psi pvh qsl rec rep rio seg sjc slg slz srv taxi tc tec teo the tmp trd tur tv udi vet vix vlog wiki xyz zlg',
  bs: 'com edu gov net org',
  bt: 'com edu gov net org',
  bw: 'ac co gov net org',
  by: 'gov mil com of',
  bz: 'co com edu gov net org',
  ca: 'ab bc mb nb nf nl ns nt nu on pe qc sk yk gc',
  cd: 'gov',
  ci: 'ac asso co com ed edu go gouv int net or org',
  cl: 'co gob gov mil',
  cm: 'co com gov net',
  cn: 'ac com edu gov mil net org ah bj cq fj gd gs gx gz ha hb he hi hk hl hn jl js jx ln mo nm nx qh sc sd sh sn sx tj tw xj xz yn zj',
  co: 'com edu gov mil net nom org',
  cr: 'ac co ed fi go or sa',
  cu: 'com edu gob inf nat net org',
  cv: 'com edu id int net nome org publ',
  cw: 'com edu net org',
  cx: 'gov',
  cy: 'ac biz com gov ltd mil net org pro tm',
  cz: 'gov',
  dm: 'co com edu gov net org',
  do: 'art com edu gob gov mil net org sld web',
  dz: 'art asso com edu gov net org pol soc tm',
  ec: 'abg adm arqt art bar chef com cont cpa cue dent dgn doc edu eng esm fin fot gal gob gov gye ibr info k12 lat loj med mil mktg mon net ntr org pro prof psic psiq pub rio rrpp sal tech tul tur uio vet xxx',
  ee: 'aip com edu fie gov lib med org pri riik',
  eg: 'ac com edu eun gov info me mil name net org sci tv',
  es: 'com edu gob nom org',
  et: 'biz com edu gov info name net org',
  fj: 'ac biz com edu gov id info mil name net org pro',
  fm: 'com edu net org',
  fr: 'asso com gouv nom prd tm cci',
  gd: 'edu gov',
  ge: 'com cyb edu gov llc net org pvt school tnx',
  gg: 'co net org',
  gh: 'biz com edu gov mil net org',
  gi: 'com edu gov ltd mod org',
  gl: 'co com edu net org',
  gn: 'ac com edu gov net org',
  gp: 'asso com edu mobi net org',
  gr: 'com edu gov net org',
  gt: 'com edu gob ind mil net org',
  gu: 'com edu gov guam info net org web',
  gy: 'co com edu gov net org',
  hk: 'com edu gov idv net org',
  hn: 'com edu gob mil net org',
  hr: 'com from iz name',
  ht: 'art asso com coop edu firm gouv info med net org pol pro rel shop',
  hu: '2000 bolt city co film info news org priv sex shop suli szex tm',
  id: 'ac ai biz co desa go kop mil my net or sch web',
  ie: 'gov',
  il: 'ac co gov idf k12 muni net org',
  im: 'ac co com net org tt tv',
  in: '5g 6g ac aero ai am bank biz ca cn co com coop cs dr edu er fin firm gen gov ind info int io me mil net nic org pg post pro res school tv ub uk up us',
  io: 'co com edu gov mil net nom org',
  iq: 'com edu gov mil net org',
  ir: 'ac co gov id net org sch',
  it: 'edu gov abr bas cal cam emr fvg laz lig lom mar mol pmn pug sar sic taa tos umb vao vda ven ag al an ao ap aq ar asti at av ba bari bg bi bl bn bo br bs bt bz ca cb ce ch ci cl cn co como cr cs ct cz en enna fc fe fg fi fm fr ge go gr im is kr lc le li lo lodi lt lu mb mc me mi mn mo ms mt na no nu og or ot pa pc pd pe pg pi pisa pn po pr pt pu pv pz ra rc re rg ri rm rn ro roma rome sa si so sp sr ss su sv ta te tn to tp tr ts tv ud va vb vc ve vi vr vs vt vv',
  je: 'co net org',
  jo: 'agri ai com edu eng fm gov mil net org per phd sch tv',
  jp: 'ac ad co ed go gr lg ne or gifu mie nara oita saga',
  ke: 'ac co go info me mobi ne or sc',
  kg: 'com edu gov mil net org',
  kh: 'com edu gov net org',
  ki: 'biz com edu gov info net org',
  km: 'ass com edu gov mil nom org prd tm asso coop gouv',
  kn: 'edu gov net org',
  kp: 'com edu gov org rep tra',
  kr: 'ac ai co es go hs io it kg me mil ms ne or pe re sc jeju',
  kw: 'com edu emb gov ind net org',
  ky: 'com edu net org',
  kz: 'com edu gov mil net org',
  la: 'com edu gov info int net org per',
  lb: 'com edu gov net org',
  lc: 'co com edu gov net org',
  lk: 'ac assn com edu gov grp int ltd net ngo org sch soc web',
  lr: 'com edu gov net org',
  ls: 'ac biz co edu gov info net org sc',
  lt: 'gov',
  lv: 'asn com conf edu gov id mil net org',
  ly: 'com edu gov id med net org plc sch',
  ma: 'ac co gov net org',
  mc: 'asso tm',
  me: 'ac co edu gov its net org priv',
  mg: 'co com edu gov mil nom org prd',
  mk: 'com edu gov inf name net org',
  ml: 'ac art asso com edu gouv gov info inst net org pr',
  mn: 'edu gov org',
  mo: 'com edu gov net org',
  mr: 'gov',
  ms: 'com edu gov net org',
  mt: 'com edu net org',
  mu: 'ac co com gov net or org',
  mv: 'aero biz com coop edu gov info int mil name net org pro',
  mw: 'ac biz co com coop edu gov int net org',
  mx: 'com edu gob net org',
  my: 'biz com edu gov mil name net org',
  mz: 'ac adv co edu gov mil net org',
  na: 'alt co com gov net org',
  nc: 'asso nom',
  nf: 'arts com firm info net per rec web',
  ng: 'com edu gov i mil mobi name net org sch',
  ni: 'ac biz co com edu gob in info int mil net nom org web',
  no: 'fhs priv vgs dep mil stat aa ah bu fm hl hm mr nl nt of ol oslo rl sf st tm tr va vf arna al alta amli amot aure berg bodo bokn eid etne fet fla fusa gol gran grue ha hof hol hole ivgu kvam leka lier lom lund moss odda osen oyer rade rana re roan rost sel ski sola sula sund tana time tinn vaga vang vega vik voss',
  nr: 'biz com edu gov info net org',
  nz: 'ac co cri geek gen govt health iwi kiwi maori mil net org parliament school',
  om: 'co com edu gov med net org pro',
  pa: 'abo ac com edu gob ing med net nom org sld',
  pe: 'com edu gob mil net nom org',
  pf: 'com edu org',
  ph: 'com edu gov i mil net ngo org',
  pk: 'ac biz com edu fam gkp gob gog gok gop gos gov net org web',
  pl: 'com net org agro aid atm auto biz edu gsm info mail mil nom pc priv rel sex shop sos tm gov elk lapy nysa pila pisz waw',
  pn: 'co edu gov net org',
  pr: 'ac biz com edu est gov info isla name net org pro prof',
  ps: 'com edu gov net org plo sec',
  pt: 'com edu gov int net nome org publ',
  pw: 'gov',
  py: 'com coop edu gov mil net org',
  qa: 'com edu gov mil name net org sch',
  re: 'asso com',
  ro: 'arts com firm info nom nt org rec tm www',
  rs: 'ac co edu gov in org',
  rw: 'ac co coop gov mil net org',
  sa: 'com edu gov med net org pub sch',
  sb: 'com edu gov net org',
  sc: 'com edu gov net org',
  sd: 'com edu gov info med net org tv',
  se: 'a ac b bd c d e f fh fhsk fhv g h i k l m n o org p pp r s t tm u w x y z',
  sg: 'com edu gov net org',
  sh: 'com gov mil net org',
  sk: 'org',
  sl: 'com edu gov net org',
  sn: 'art com edu gouv org univ',
  so: 'com edu gov me net org',
  ss: 'biz co com edu gov me net org sch',
  st: 'co com edu mil net org',
  sv: 'com edu gob org red',
  sx: 'gov',
  sy: 'com edu gov mil net org',
  sz: 'ac co org',
  th: 'ac co go in mi net or',
  tj: 'biz co com edu go gov int mil name net nic org test web',
  tl: 'gov',
  tm: 'co com edu gov mil net nom org',
  tn: 'com ens fin gov ind info intl nat net org',
  to: 'com edu gov mil net org',
  tr: 'av bbs bel biz com dr edu gen gov info k12 kep mil name net org pol tel tsk tv web nc',
  tt: 'biz co com edu gov info mil name net org pro',
  tw: 'club com ebiz edu game gov idv mil net org',
  tz: 'ac co go info me mil mobi ne or sc tv',
  ua: 'com edu gov in net org ck cn cr cv dn dp if kh kiev km kr krym ks kv kyiv lg lt lv lviv mk od pl rv sb sm sumy te uz vn zp zt',
  ug: 'ac co com edu go gov mil ne or org sc us',
  uk: 'ac co gov ltd me net nhs org plc police',
  us: 'dni isa nsn ak al ar as az ca co ct dc de fl ga gu hi ia id il in ks ky la ma md me mi mn mo ms mt nc nd ne nh nj nm nv ny oh ok or pa pr ri sc sd tn tx ut va vi vt wa wi wv wy',
  uy: 'com edu gub mil net org',
  uz: 'co com net org',
  vc: 'com edu gov mil net org',
  ve: 'arts bib co com e12 edu firm gob gov ia info int mil net nom org rar rec tec web',
  vg: 'edu',
  vi: 'co com k12 net org',
  vn: 'ac ai biz com edu gov health id info int io name net org pro hue',
  vu: 'com edu net org',
  ws: 'com edu gov net org',
  ye: 'com edu gov mil net org',
  za: 'ac alt co edu gov law mil net ngo nic nis nom org school tm web',
  zm: 'ac biz co com edu gov info mil net org sch',
  zw: 'ac co gov mil org',
};

/** Country codes where every second-level name is itself a public suffix. */
const WILDCARD_TLDS = ['ck', 'er', 'fk', 'jm', 'mm', 'np', 'pg'];

/** Registrable despite the wildcard above. */
const WILDCARD_EXCEPTIONS = ['www.ck'];

/** Hosting platforms: every name under these belongs to a different customer. */
const PRIVATE_SUFFIXES = `
  github.io githubusercontent.com gitlab.io codeberg.page bitbucket.io
  vercel.app vusercontent.net now.sh netlify.app pages.dev workers.dev r2.dev
  trycloudflare.com herokuapp.com onrender.com fly.dev up.railway.app
  ondigitalocean.app web.app firebaseapp.com appspot.com cloudfunctions.net
  amplifyapp.com elasticbeanstalk.com s3.amazonaws.com cloudfront.net
  azurewebsites.net azurestaticapps.net azureedge.net azurefd.net cloudapp.net
  blob.core.windows.net blogspot.com wixsite.com webflow.io framer.app
  framer.website carrd.co myshopify.com readthedocs.io pythonanywhere.com
  repl.co replit.dev deno.dev surge.sh ngrok.io ngrok.app ngrok-free.app
  hf.space streamlit.app lovable.app csb.app supabase.co translate.goog
  duckdns.org dyndns.org no-ip.org ddns.net
`;

let suffixes: Set<string> | null = null;

/** Built on first use rather than at import: the service worker may never ask. */
function suffixSet(): Set<string> {
  if (suffixes) return suffixes;
  suffixes = new Set(PRIVATE_SUFFIXES.split(/\s+/).filter(Boolean));
  for (const [tld, labels] of Object.entries(ICANN_SECOND_LEVEL)) {
    for (const label of labels.split(' ')) suffixes.add(`${label}.${tld}`);
  }
  return suffixes;
}

/**
 * How many trailing labels of `labels` form its public suffix: 1 for a plain
 * TLD, more for the rules above.
 */
export function publicSuffixLength(labels: readonly string[]): number {
  const set = suffixSet();
  // Longest match wins, as in the list's own algorithm.
  for (let length = Math.min(labels.length, 4); length >= 2; length -= 1) {
    const candidate = labels.slice(-length).join('.');
    if (set.has(candidate)) return length;
  }
  const tld = labels[labels.length - 1];
  if (labels.length >= 2 && WILDCARD_TLDS.includes(tld)) {
    return WILDCARD_EXCEPTIONS.includes(labels.slice(-2).join('.')) ? 1 : 2;
  }
  return 1;
}
