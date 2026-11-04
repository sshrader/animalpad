# HatchPad

Describe an animal. AI draws the logo and suggests a name, ticker and description. Accept it, or reject it and try again. Then launch it as a token on the pump.fun protocol (its bonding curve, then PumpSwap), trade it, and send out the creator fees.

**Status:** being moved from Meteora to pump.fun. Devnet by default; mainnet is refused in code until `MAINNET_ENABLED=yes`. The pump.fun transactions are built from pump.fun's published IDL and have been tested only against a simulated chain, so run `devnet/11-check-pump.mjs` and a devnet launch before real money.

## How it works

1. **Describe:** the page sends a short description to the server. The server asks an AI provider for the image and for the name, ticker and description, so the API key never reaches the browser. The provider is Cloudflare Workers AI (`IMAGE_PROVIDER=cloudflare`) or OpenAI (the default).
2. **Accept or reject:** you can edit the name and ticker. Reject draws a new animal from the same description.
3. **Add links (optional):** a creator can add their own website, X and Telegram. They are checked (websites must be https; X and Telegram take a handle or link), saved with the picture, and published in the token's metadata as `external_url`, `website`, `twitter`, `telegram` and `extensions`. They are locked once a launch is started for that picture, so a changed set is refused with a clear message and the public picture address can't be used to edit them.
4. **Launch:** Phantom signs the transactions the server prepares one at a time. With a lookup table: (1) `create_v2` plus the launcher's optional first buy in one transaction, (2) the coin's creator fees are split between the launcher and HatchPad (pump.fun creator fee sharing). Without one: create, then split, then the first buy. The token's metadata link points back at this site, so wallets and explorers show the picture. If a step is declined or the tab closes, pressing Launch again continues from what is on-chain.
5. **Trade and send out fees:** paste a coin address (CA) to see how full the curve is and buy. Anyone can press Send out fees on a coin page; the money goes to the wallets in the coin's fee split.

## Run it

```
npm install
IMAGE_PROVIDER=cloudflare CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node server.js
```

Without a valid key and settings the page says the studio is off. `/healthz` and the startup log name the missing setting (never its value). Pasted settings are trimmed of stray spaces and quotes. Without `PLATFORM_FEE_WALLET` launching is hidden.

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
| `LAUNCHES_FILE` | Optional. Overrides where the launch list is saved. Default: `<DATA_DIR>/launches.json` on devnet and `launches.<cluster>.json` otherwise, so devnet and mainnet lists never mix. Pointing it at a new file name is a safe way to start with an empty list. |
| `HIDE_POOLS` | Optional. Comma-separated pool addresses to hide from the public "Recently launched" list. |
| `LAUNCH_RPC_URL` | RPC address. Devnet defaults to the public one. Mainnet requires a dedicated paid RPC (keep it in Railway Variables). |
| `LAUNCH_CLUSTER` | `devnet` (default) or `mainnet-beta`. |
| `PLATFORM_FEE_WALLET` | Public address that receives HatchPad's share of each coin's creator fees. Required for launching. Use a fresh wallet or a Ledger. |
| `PLATFORM_SHARE_PCT` | HatchPad's share of the creator fees, a whole number from 1 to 50. Default 20 (the launcher keeps 80). It is written on-chain at launch and cannot be changed for that coin afterwards. |
| `LAUNCH_LOOKUP_TABLE` | Address of the frozen lookup table made by `devnet/12-make-lookup-table.mjs`. With it, creating the coin and the creator's first buy are one transaction, so nobody can buy first. Without it (or if the table is missing or not frozen) launches use separate steps. |
| `PRIORITY_FEE_MICROLAMPORTS` | Priority fee per compute unit added to transactions. Default 50000 on mainnet, 0 on devnet. |
| `MAINNET_ENABLED` | Must be `yes` for `LAUNCH_CLUSTER=mainnet-beta`. Without it the server refuses to start. |
| `FOUNDER_WALLET` | Public address of the wallet allowed to launch the founder coin (the HatchPad logo, `founder/logo.png`, no AI). Open `/?founder=1` to stage it. Nobody else can launch it. Optional `FOUNDER_NAME` (default HatchPad), `FOUNDER_SYMBOL` (HATCH), `FOUNDER_DESCRIPTION`. |
| `PUBLIC_URL` | This site's address, if it can't be worked out from the request. |

## Guardrails

- Prompts are cleaned of control characters, capped at 120 characters, and checked against a short list of well-known characters, brands and people. The list is basic, not complete.
- The image prompt asks for an original character, and the name step is told to avoid existing brands and tokens.
- Generation is rate limited per address and per day, and every failure gives a generic error.
- Pictures are saved on the volume at `/data/art` (`<id>.png` or `<id>.jpg`, plus `<id>.json`). Both PNG and JPEG are accepted and checked by their first bytes. A picture used by a launch is kept for good. Animals that were generated but never launched are deleted after a day. With no volume, pictures live in memory only and are lost on restart, and the server says so at startup.
- The home page lists recent launches (`GET /api/launches`). Each is checked on-chain before it shows, and entries that never got sent are dropped after a day. Moderation is basic: a blocked list of brand and person names at launch time, and `HIDE_POOLS` to remove anything else by hand. There is no profanity filter yet.
- On Railway, add a volume to the service and mount it at `/data`. If the startup log says the art folder is not usable, the volume is probably not writable by the app's user.
- This is fine for devnet. For mainnet, move pictures to content-addressed storage such as IPFS, so a token's picture does not depend on this server.

## Scripts

`devnet/` holds command-line helpers: throwaway keys, a payer wallet, a sweep script, and `11-check-pump.mjs`, which asks the network to simulate HatchPad's pump.fun transactions without spending anything. See `devnet/README.md`.

## How pump.fun is used

`pump.js` builds instructions straight from pump.fun's published IDL (`idl/pump.json`, `idl/pump_fees.json`, copied from github.com/pump-fun/pump-public-docs): `create_v2`, `create_fee_sharing_config`, `update_fee_shares_v2`, `buy_exact_quote_in_v3`, `sell_v3`, `sweep_creator_fee` and `distribute_creator_fees_v2`. There is no SDK dependency beyond `@solana/web3.js`. The buy minimum is computed from the curve with a deliberately generous fee guess, because the exact fee tier is read on-chain.

Creator fees are kept on the curve by the v3 trades, so a payout is two instructions in one transaction: sweep, then distribute. It works while the coin is on the bonding curve. After pump.fun moves it to PumpSwap, payouts need the PumpSwap sweep as well; that is not built yet, and the coin page says so.

The platform split is only enforced for coins launched through this site's three steps. Someone who builds their own transactions can launch without the split, so the coin page and `/admin` count only coins whose fee split is in place (`splitOk`).

## Not built yet

- IPFS storage for pictures (they are on the volume for now).
- Selling from the page, and payouts after a coin moves to PumpSwap.
- Anything needed for mainnet: a security review, self-hosting the wallet library.

## Coin pages

Each launch has a page at `/coin/<pool address>` with its details, a mood badge that follows how full the curve is (sleepy, awake, excited, ready, graduated) and a chat with the mascot. Chat uses the same text model as naming. It is limited to 20 messages per visitor per hour and 1000 a day in total (`chatPerIpPerHour` and `chatDailyCap` in `art.js`). The mascot is told not to give financial advice, replies are stripped of links, and the character is always read from the coin, never from the request.

## Share links (Solana Actions / Blinks)

`GET /actions.json` and `/api/actions/trade/<pool>` follow the Solana Actions spec. A wallet or Blink viewer reads the coin, shows buttons for 0.05, 0.1 and 0.5 SOL plus a custom amount, and POSTs the buyer's wallet to get an unsigned buy that the wallet signs. The coin page has a "Copy buy link" button that wraps the action in a dial.to link on devnet. Responses carry the devnet chain id and open CORS headers. Showing a coin page link as an interactive card inside X needs the domain registered with a Blinks client, which is not done.

## Buy at launch

The launch panel has an optional first buy (0.01 to 5 SOL). Create plus buy is too big for one normal transaction, so with `LAUNCH_LOOKUP_TABLE` set they go in one version 0 transaction that uses a shared, frozen address lookup table, and nobody can buy first (the approach Sparkpad uses, with one shared table instead of one per wallet). Without it the buy is the last step, a separate transaction a very fast bot could beat. The coin page shows how much the creator bought.

## Website verification

A coin whose creator added a website shows a "Verify it" box with a code that belongs to that coin. The creator saves the code in `/.well-known/hatchpad-verify.txt` on their site, or anywhere on the page they linked. `POST /api/coin/verify` then fetches those two addresses and, if it finds the code, saves that the site is verified. The fetch is locked down: https on port 443 only, names only (no IP addresses), public addresses only (checked at connect time), no redirects, 6 second timeout, 16 KB limit. Checks are limited to 10 per visitor per hour and one per coin every 20 seconds. This proves control of the website only. It does not verify X or Telegram.

## Platform fees (/admin)

`/admin` lists every HatchPad coin whose fee split is in place with the platform's share of its waiting creator fees, and a button to send them out. Connect the platform fee wallet in Phantom. The server builds an unsigned sweep-and-distribute transaction (`/api/admin/claim`); the wallet signs and pays the network fee. The money goes to the coin's two shareholders (the launcher and HatchPad), whoever sends it, so the page and server hold no keys.

## Going live on mainnet

Real money. Read the go-live list with your lawyer and security reviewer first. The code defaults to devnet and refuses mainnet unless every switch below is set.

1. Make a NEW platform fee wallet in Phantom (a fresh account) or on a Ledger / Squads multisig. Copy only its public address. Its private key must never be on a server or in this repo.
2. Check the transactions without spending anything (from `devnet/`, after `npm install`):
   ```
   CLUSTER=mainnet-beta MAINNET_OK=yes RPC_URL=<mainnet rpc> node 11-check-pump.mjs <your wallet> <mint of any live pump.fun coin>
   ```
   Both lines should say PASS. The fee-split step can only be proven by a real launch, so do one on devnet first if pump.fun's program is there, or a first mainnet launch with a small first buy.
3. Make the shared lookup table once (about 0.01 SOL of rent, from the payer file):
   ```
   cd devnet
   $env:CLUSTER="mainnet-beta"; $env:MAINNET_OK="yes"; $env:RPC_URL="<mainnet rpc>"; $env:PAYER_KEYPAIR="<path>"
   node 12-make-lookup-table.mjs <platform fee wallet>
   ```
   It prints an address and freezes the table so nobody can change it. Use it as `LAUNCH_LOOKUP_TABLE`.
4. In Railway set `LAUNCH_CLUSTER=mainnet-beta`, `MAINNET_ENABLED=yes`, `LAUNCH_RPC_URL=<mainnet rpc>` `PLATFORM_FEE_WALLET=<public address>` and `LAUNCH_LOOKUP_TABLE=<address>`.
5. Open `/admin` with the platform fee wallet to send out fees.

On mainnet a buy whose quote comes out as zero is refused, and the pages show real-money wording and mainnet explorer links.
