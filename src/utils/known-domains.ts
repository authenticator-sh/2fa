// Domains that are real services, so never a fake of another one.
//
// A one-letter difference is how most typosquats look, and also how some real
// brands sit next to each other: PayPay (paypay.ne.jp) and PayPal, Cloudflare
// Access (cloudflareaccess.com) and Cloudflare. Without this list someone
// holding a PayPal account and copying a PayPay code would be told the PayPay
// site is fake. Registrable domains only, from a list of popular services and the sites of
// our /2fa guides; a page under one of them is never
// warned about (lookalike.ts).
//
// How it was sized (2026-11-09): every domain here against ~270 popular
// issuers, as if the user held that one account and nothing else — 80 000
// pairs — gave 3 alarms without this list, all three between two real
// services (the pairs above).

export const KNOWN_REAL_DOMAINS: ReadonlySet<string> = new Set([
  '1password.com', 'activision.com', 'adobe.com', 'adp.com', 'airbnb.com', 'airtable.com',
  'alibaba.com', 'aliexpress.com', 'ally.com', 'amazon.co.uk', 'amazon.com', 'amazon.de',
  'amazonaws.com', 'americanexpress.com', 'anthropic.com', 'aol.com', 'apple.com', 'asana.com',
  'atlassian.com', 'atlassian.io', 'atlassian.net', 'audible.com', 'auth0.com', 'autodesk.com',
  'availity.com', 'awsapps.com', 'azure.com', 'baidu.com', 'bankofamerica.com', 'barclays.co.uk',
  'battle.net', 'bbva.com', 'bestbuy.com', 'bethesda.net', 'binance.com', 'bing.com',
  'bitbucket.org', 'bitfinex.com', 'bitget.com', 'bitmex.com', 'bitstamp.net', 'bitwarden.com',
  'blizzard.com', 'blockchain.com', 'bluehost.com', 'booking.com', 'box.com', 'bradesco.com.br',
  'bukalapak.com', 'bun.sh', 'bybit.com', 'calendly.com', 'canva.com', 'canva.site',
  'capitalone.com', 'cash.app', 'chase.com', 'chatgpt.com', 'citi.com', 'claude.ai', 'clickup.com',
  'cloudflare.com', 'cloudflareaccess.com', 'coinbase.com', 'coupang.com', 'coursera.org',
  'crypto.com', 'dashlane.com', 'datadoghq.com', 'deno.com', 'deribit.com', 'deutsche-bank.de',
  'digitalocean.com', 'discord.com', 'discordapp.com', 'discover.com', 'docker.com', 'docusign.com',
  'docusign.net', 'dropbox.com', 'duolingo.com', 'ea.com', 'ebay.com', 'ebay.de', 'edx.org',
  'elastic.co', 'elevenlabs.io', 'epicgames.com', 'etsy.com', 'evernote.com', 'exodus.com',
  'expedia.com', 'expressvpn.com', 'facebook.com', 'faceit.com', 'fastmail.com', 'fbcdn.net',
  'fidelity.com', 'figma.com', 'figma.site', 'fitbit.com', 'flipkart.com', 'fly.io', 'force.com',
  'garmin.com', 'gate.com', 'gate.io', 'gemini.com', 'github.com', 'gitlab.com', 'gmarket.co.kr',
  'godaddy.com', 'gojek.com', 'google.com', 'googleapis.com', 'grab.com', 'grafana.net',
  'grammarly.com', 'groww.in', 'gstatic.com', 'gusto.com', 'hellosign.com', 'heroku.com',
  'hetzner.com', 'hostinger.com', 'hotmail.com', 'hsbc.com', 'htx.com', 'huawei.com', 'hubspot.com',
  'huggingface.co', 'huobi.com', 'ibm.com', 'icloud.com', 'imdb.com', 'ing.com', 'instagram.com',
  'intuit.com', 'itau.com.br', 'jetbrains.com', 'kaggle.com', 'kakao.com', 'kalshi.com',
  'khanacademy.org', 'kick.com', 'kickstarter.com', 'kraken.com', 'kucoin.com', 'lastpass.com',
  'lazada.com', 'ledger.com', 'line.me', 'linkedin.com', 'linode.com', 'live.com', 'login.gov',
  'loom.com', 'lovable.dev', 'lyft.com', 'mail.ru', 'mailchimp.com', 'make.com', 'medium.com',
  'mercadolibre.com', 'mercadopago.com', 'mercari.com', 'messenger.com', 'meta.com', 'metamask.io',
  'mexc.com', 'microsoft.com', 'microsoftonline.com', 'miro.com', 'mistral.ai', 'monday.com',
  'mongodb.com', 'monzo.com', 'msn.com', 'mullvad.net', 'myworkday.com', 'n26.com', 'n8n.io',
  'namecheap.com', 'naver.com', 'navimedix.com', 'neon.tech', 'neteller.com', 'netflix.com',
  'netlify.com', 'newrelic.com', 'nexo.com', 'nexusmods.com', 'nintendo.com', 'nordpass.com',
  'nordvpn.com', 'norton.com', 'notion.com', 'notion.site', 'notion.so', 'npmjs.com', 'npmjs.org',
  'nubank.com.br', 'oculus.com', 'office.com', 'okta.com', 'okx.com', 'olacabs.com', 'onedrive.com',
  'onehealthcareid.com', 'onepeloton.com', 'onlyfans.com', 'openai.com', 'outlook.com', 'ovh.com',
  'patreon.com', 'payoneer.com', 'paypal.com', 'paypay.ne.jp', 'paytm.com', 'phantom.app',
  'phonepe.com', 'pinterest.com', 'planetscale.com', 'playstation.com', 'plex.tv', 'pnpm.io',
  'polymarket.com', 'porkbun.com', 'primevideo.com', 'proton.me', 'protonmail.com', 'pypi.org',
  'qq.com', 'quickbooks.com', 'railway.app', 'rakuten.co.jp', 'razorpay.com', 'reddit.com',
  'reddithelp.com', 'redis.com', 'render.com', 'revolut.com', 'riotgames.com', 'rippling.com',
  'robinhood.com', 'roblox.com', 'rockstargames.com', 'rubygems.org', 'salesforce.com',
  'samsung.com', 'santander.com', 'sberbank.ru', 'schwab.com', 'sendgrid.com', 'sentry.io',
  'sharepoint.com', 'shopee.com', 'shopify.com', 'signal.org', 'skrill.com', 'skype.com',
  'slack.com', 'snapchat.com', 'square-enix.com', 'squarespace.com', 'squareup.com',
  'stackoverflow.com', 'steamcommunity.com', 'steampowered.com', 'strava.com', 'stripe.com',
  'substack.com', 'supabase.com', 'swiggy.com', 'target.com', 'telegram.org', 'telnyx.com',
  'tencent.com', 'tesla.com', 'threads.net', 'tiktok.com', 'tinkoff.ru', 'todoist.com',
  'tokopedia.com', 'toss.im', 'tradingview.com', 'trello.com', 'trezor.io', 'tumblr.com',
  'turbotax.com', 'tutanota.com', 'twilio.com', 'twitch.tv', 'twitter.com', 'uber.com',
  'ubisoft.com', 'udemy.com', 'uphold.com', 'upstox.com', 'upwork.com', 'vanguard.com', 'venmo.com',
  'vercel.com', 'vimeo.com', 'visualstudio.com', 'vk.com', 'vultr.com', 'walmart.com',
  'wargaming.net', 'webflow.com', 'wellsfargo.com', 'whatsapp.com', 'whatsapp.net', 'wikimedia.org',
  'wikipedia.org', 'wise.com', 'wix.com', 'wordpress.com', 'wordpress.org', 'workday.com', 'x.com',
  'xbox.com', 'xero.com', 'xiaomi.com', 'yahoo.com', 'yandex.ru', 'yarnpkg.com', 'youtube.com',
  'zapier.com', 'zellepay.com', 'zendesk.com', 'zerodha.com', 'zoho.com', 'zomato.com', 'zoom.com',
  'zoom.us',
]);
