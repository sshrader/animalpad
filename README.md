# AnimalPad

Describe an animal. AI draws the logo and suggests a name, ticker and description. Accept it, or reject it and try again. Then launch it as a token on a Meteora bonding curve, trade it, and claim the creator's fees.

**Status:** devnet test version. Test SOL only. Mainnet is refused in code.

## How it works

1. **Describe:** the page sends a short description to the server. The server calls OpenAI for the image (`/v1/images/generations`) and for the name, ticker and description, so the API key never reaches the browser.
2. **Accept or reject:** you can edit the name and ticker. Reject draws a new animal from the same description.
3. **Launch:** Phantom (set to Devnet) signs a transaction the server prepares. The token's metadata link points back at this site, so wallets and explorers show the picture.
4. **Trade and claim:** paste a pool address to see how full the curve is, buy with devnet SOL, and claim creator fees with the launching wallet.

## Run it

```
npm install
OPENAI_API_KEY=sk-... node server.js
```

Without a key the animal studio is hidden. Without `devnet/presets.json` launching is hidden.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Required for the studio. Set it in Railway, never in the repo. |
| `OPENAI_IMAGE_MODEL` | Default `gpt-image-1`. |
| `OPENAI_TEXT_MODEL` | Default `gpt-4o-mini`. |
| `ART_PER_IP_PER_HOUR` | Default 6 pictures per address per hour. |
| `ART_DAILY_CAP` | Default 300 pictures a day in total. This caps your spend. |
| `LAUNCH_RPC_URL` | Devnet RPC. Default the public one. |
| `PUBLIC_URL` | This site's address, if it can't be worked out from the request. |

## Guardrails

- Prompts are cleaned of control characters, capped at 120 characters, and checked against a short list of well-known characters, brands and people. The list is basic, not complete.
- The image prompt asks for an original character, and the name step is told to avoid existing brands and tokens.
- Generation is rate limited per address and per day, and every failure gives a generic error.
- Pictures are kept in memory (the newest 60) and served at `/art/<id>.png`. **They are lost when the server restarts.** Before mainnet they must move to permanent storage such as IPFS.

## Devnet scripts

`devnet/` holds the command-line scripts used to prove the Meteora lifecycle: keys, config, pool, buy, migrate, claim, and a read-only `npm run inspect`. See `devnet/README.md`. `devnet/presets.json` lists the on-chain fee configs the launches use. Migrating a full curve is still a script: `npm run migrate -- --pool <address>`.

## Not built yet

- Permanent picture storage (IPFS).
- Migrating a full curve from the page.
- Anything needed for mainnet: a security review, real curve numbers, self-hosting the wallet library, and removing the devnet-only no-minimum buy for the buy that fills the curve.
