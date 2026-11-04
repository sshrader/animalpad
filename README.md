# AnimalPad

Describe an animal. AI draws the logo and suggests a name, ticker and description. Accept it, or reject it and try again. Then launch it as a token on a Meteora bonding curve, trade it, and claim the creator's fees.

**Status:** devnet test version. Test SOL only. Mainnet is refused in code.

## How it works

1. **Describe:** the page sends a short description to the server. The server asks an AI provider for the image and for the name, ticker and description, so the API key never reaches the browser. The provider is Cloudflare Workers AI (`IMAGE_PROVIDER=cloudflare`) or OpenAI (the default).
2. **Accept or reject:** you can edit the name and ticker. Reject draws a new animal from the same description.
3. **Launch:** Phantom (set to Devnet) signs a transaction the server prepares. The token's metadata link points back at this site, so wallets and explorers show the picture.
4. **Trade and claim:** paste a pool address to see how full the curve is, buy with devnet SOL, and claim creator fees with the launching wallet.

## Run it

```
npm install
IMAGE_PROVIDER=cloudflare CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node server.js
```

Without a key (or with an invalid account id) the animal studio is hidden. Without `devnet/presets.json` launching is hidden.

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
| `ART_DIR` | Where pictures are saved. Defaults to `/data/art` when a `/data` volume exists, otherwise memory only. |
| `LAUNCH_RPC_URL` | Devnet RPC. Default the public one. |
| `PUBLIC_URL` | This site's address, if it can't be worked out from the request. |

## Guardrails

- Prompts are cleaned of control characters, capped at 120 characters, and checked against a short list of well-known characters, brands and people. The list is basic, not complete.
- The image prompt asks for an original character, and the name step is told to avoid existing brands and tokens.
- Generation is rate limited per address and per day, and every failure gives a generic error.
- Pictures are saved on the volume at `/data/art` (`<id>.png` or `<id>.jpg`, plus `<id>.json`). Both PNG and JPEG are accepted and checked by their first bytes. A picture used by a launch is kept for good. Animals that were generated but never launched are deleted after a day. With no volume, pictures live in memory only and are lost on restart, and the server says so at startup.
- On Railway, add a volume to the service and mount it at `/data`. If the startup log says the art folder is not usable, the volume is probably not writable by the app's user.
- This is fine for devnet. For mainnet, move pictures to content-addressed storage such as IPFS, so a token's picture does not depend on this server.

## Devnet scripts

`devnet/` holds the command-line scripts used to prove the Meteora lifecycle: keys, config, pool, buy, migrate, claim, and a read-only `npm run inspect`. See `devnet/README.md`. `devnet/presets.json` lists the on-chain fee configs the launches use. Migrating a full curve is still a script: `npm run migrate -- --pool <address>`.

## Not built yet

- IPFS storage for pictures (they are on the volume for now).
- Migrating a full curve from the page.
- Anything needed for mainnet: a security review, real curve numbers, self-hosting the wallet library, and removing the devnet-only no-minimum buy for the buy that fills the curve.
