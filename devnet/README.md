# devnet/ helpers

Command-line helpers. Nothing here is used by the website.

| Script | What it does |
| --- | --- |
| `00-keys.mjs` | Makes two throwaway devnet wallets and tries a small airdrop. |
| `08-export-key.mjs` | Prints a throwaway devnet key in the form Phantom's import box accepts. Devnet keys only. |
| `09-new-payer.mjs <path>` | Makes a wallet file outside the repo and prints its public address to fund. |
| `10-sweep-payer.mjs <address> [--yes]` | Sends everything left in a payer wallet file to another address. |
| `11-check-pump.mjs <wallet> [<live mint>]` | Simulates HatchPad's create-coin transaction (and a 0.01 SOL buy of a live pump.fun coin if you pass its mint). Spends nothing. |

Run `npm install` in this folder first. For mainnet, set `CLUSTER=mainnet-beta MAINNET_OK=yes RPC_URL=<mainnet rpc>`.
