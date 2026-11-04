# AnimalPad

Describe an animal. AI draws the logo and suggests a name, ticker and description. Accept it, or reject it and try again. Then launch it as a token on a Meteora bonding curve, trade it, and claim the creator's fees.

**Status:** devnet test version. Test SOL only. Mainnet is refused in code.

## How it works

1. **Describe:** the page sends a short description to the server. The server asks an AI provider for the image and for the name, ticker and description, so the API key never reaches the browser. The provider is Cloudflare Workers AI (`IMAGE_PROVIDER=cloudflare`) or OpenAI (the default).
2. **Accept or reject:** you can edit the name and ticker. Reject draws a new animal from the same description.
3. **Add links (optional):** a creator can add their own website, X and Telegram. They are checked (websites must be https; X and Telegram take a handle or link), saved with the picture, and published in the token's metadata as `external_url`, `website`, `twitter`, `telegram` and `extensions`. They are locked once a launch is started for that picture, so a changed set is refused with a clear message and the public picture address can't be used to edit them.
4. **Launch:** Phantom (set to Devnet) signs a transaction the server prepares. The token's metadata link points back at this site, so wallets and explorers show the picture.
5. **Trade and claim:** paste a pool address to see how full the curve is, buy with devnet SOL, and claim creator fees with the launching wallet.

## Run it

```
npm install
IMAGE_PROVIDER=cloudflare CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node server.js
```

Without a valid key and settings the page says the studio is off. `/healthz` and the startup log name the missing setting (never its value). Pasted settings are trimmed of stray spaces and quotes. Without `devnet/presets.json` launching is hidden.

| Variable | Purpose |
| --- | --- |
| `IMAGE_PROVIDER` | `cloudflare` for Workers AI. Anything else (or unset) uses OpenAI. |
| `CLOUDFLARE_ACCOUNT_ID` | Your 32-character Cloudflare account id. |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token with Workers AI access. Set it in Railway, never in the repo or in chat. |
| `OPENAI_API_KEY` | Only for the OpenAI provider. |
| `IMAGE_MODEL` | Leave blank for the default: `@cf/black-forest-labs/flux-1-schnell` (Cloudflare, returns JPEG) or `gpt-image-1` (OpenAI, PNG). |
| `TEXT_MODEL` | Leave blank for the default: `@cf/meta/llama-3.1-8b-instruct` or `gpt-4o-mini`. Writes the name, ticker and description. |
| `ART_PER_IP_PER_HOUR` | Default 6 pictures per address per hour. |
| `ART_DAILY_CAP` | Default 300 pictures a day in total. This caps your spend. |
| `DATA_DIR` | Where the volume is mounted (for example `/data`). Pictures go in `<DATA_DIR>/art` and the launch list in `<DATA_DIR>/launches.json`. Defaults to `/data` when that folder exists, otherwise memory only. |
| `ART_DIR` | Optional. Overrides just the pictures folder. |
| `VERIFY_SECRET` | Optional. Secret behind the website-check codes. If unset and a volume exists, one is created in `<DATA_DIR>/verify-secret`. |
| `LAUNCHES_FILE` | Optional. Overrides where the launch list is saved. |
| `HIDE_POOLS` | Optional. Comma-separated pool addresses to hide from the public "Recently launched" list. |
| `LAUNCH_RPC_URL` | Devnet RPC. Default the public one. |
| `PUBLIC_URL` | This site's address, if it can't be worked out from the request. |

## Guardrails

- Prompts are cleaned of control characters, capped at 120 characters, and checked against a short list of well-known characters, brands and people. The list is basic, not complete.
- The image prompt asks for an original character, and the name step is told to avoid existing brands and tokens.
- Generation is rate limited per address and per day, and every failure gives a generic error.
- Pictures are saved on the volume at `/data/art` (`<id>.png` or `<id>.jpg`, plus `<id>.json`). Both PNG and JPEG are accepted and checked by their first bytes. A picture used by a launch is kept for good. Animals that were generated but never launched are deleted after a day. With no volume, pictures live in memory only and are lost on restart, and the server says so at startup.
- The home page lists recent launches (`GET /api/launches`). Each is checked on-chain before it shows, and entries that never got sent are dropped after a day. Moderation is basic: a blocked list of brand and person names at launch time, and `HIDE_POOLS` to remove anything else by hand. There is no profanity filter yet.
- On Railway, add a volume to the service and mount it at `/data`. If the startup log says the art folder is not usable, the volume is probably not writable by the app's user.
- This is fine for devnet. For mainnet, move pictures to content-addressed storage such as IPFS, so a token's picture does not depend on this server.

## Devnet scripts

`devnet/` holds the command-line scripts used to prove the Meteora lifecycle: keys, config, pool, buy, migrate, claim, and a read-only `npm run inspect`. See `devnet/README.md`. `devnet/presets.json` lists the on-chain fee configs the launches use. Migrating a full curve is still a script: `npm run migrate -- --pool <address>`.

## Not built yet

- IPFS storage for pictures (they are on the volume for now).
- Migrating a full curve from the page.
- Anything needed for mainnet: a security review, real curve numbers, self-hosting the wallet library, and removing the devnet-only no-minimum buy for the buy that fills the curve.

## Coin pages

Each launch has a page at `/coin/<pool address>` with its details, a mood badge that follows how full the curve is (sleepy, awake, excited, ready, graduated) and a chat with the mascot. Chat uses the same text model as naming. It is limited to 20 messages per visitor per hour and 1000 a day in total (`chatPerIpPerHour` and `chatDailyCap` in `art.js`). The mascot is told not to give financial advice, replies are stripped of links, and the character is always read from the coin, never from the request.

## Share links (Solana Actions / Blinks)

`GET /actions.json` and `/api/actions/trade/<pool>` follow the Solana Actions spec. A wallet or Blink viewer reads the coin, shows buttons for 0.05, 0.1 and 0.5 SOL plus a custom amount, and POSTs the buyer's wallet to get an unsigned buy that the wallet signs. The coin page has a "Copy buy link" button that wraps the action in a dial.to link on devnet. Responses carry the devnet chain id and open CORS headers. Showing a coin page link as an interactive card inside X needs the domain registered with a Blinks client, which is not done.

## Buy at launch

The launch panel has an optional first buy (0.01 to 5 SOL). It is put in the same transaction as the launch (the SDK's `createPoolWithFirstBuy`), so nobody can buy before the creator, and the creator approves once. The coin page shows how much the creator bought. The call returns one transaction in the SDK version Pawpad uses (1.5.13); this repo pins 2.0.0, where it is handled for both a bare transaction and a `{ createPoolTx, swapBuyTx }` result, but it has only been tested against a fake SDK, so try it on devnet before relying on it. The buyer needs enough test SOL for the buy plus fees. The pool does not exist yet, so the buy is sent with no minimum output.

## Website verification

A coin whose creator added a website shows a "Verify it" box with a code that belongs to that coin. The creator saves the code in `/.well-known/animalpad-verify.txt` on their site, or anywhere on the page they linked. `POST /api/coin/verify` then fetches those two addresses and, if it finds the code, saves that the site is verified. The fetch is locked down: https on port 443 only, names only (no IP addresses), public addresses only (checked at connect time), no redirects, 6 second timeout, 16 KB limit. Checks are limited to 10 per visitor per hour and one per coin every 20 seconds. This proves control of the website only. It does not verify X or Telegram.

## Platform fee claiming (/admin)

`/admin` lists every coin under the preset configs with the platform fees it has earned and not yet claimed (the SDK's `getPoolsFeesByConfig`), with a Claim button per coin and Claim all. Connect the fee claimer wallet in Phantom. The server builds an unsigned claim for the pool (`/api/admin/claim`) and the wallet signs and sends it, so the page and server hold no keys, and the fee claimer can be any wallet Phantom supports, a Ledger included. The page is public but only useful to the fee claimer: the claim is refused for any other wallet by the server and would fail on-chain anyway. It covers fees earned on the curve only. Fees after a coin moves to its trading pool are a separate step. This mirrors the `/#/admin` fee page in the Pawpad repo, with the transactions built on the server because this site's pages do not load the Meteora SDK in the browser.
