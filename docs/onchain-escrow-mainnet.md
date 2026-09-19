# On-chain escrow, Robinhood Chain mainnet

User-facing record of the deployed bounty escrow. No keys in this file.

| | |
|---|---|
| tx | `0x9ae4783b4ed8da5175bb40e5c5e220faa644a0cf3ae8915f9812cd8beb1ea0e1` |
| contract | `0x64b9b03A5deB47560e7EB6495a9f6Da426B80d5F` |
| chainId | 4663 (Robinhood Chain mainnet; not 46630) |
| explorer tx | https://robinhoodchain.blockscout.com/tx/0x9ae4783b4ed8da5175bb40e5c5e220faa644a0cf3ae8915f9812cd8beb1ea0e1 |
| explorer contract | https://robinhoodchain.blockscout.com/address/0x64b9b03A5deB47560e7EB6495a9f6Da426B80d5F |

Deploy path: Bankr `/wallet/submit` CREATE (brotli for ALB body limits), not
`cast wallet import`. Leftover deploy ETH was not moved. Design:
[`onchain-escrow.md`](./onchain-escrow.md). Wallet helper:
[`bankr-wallet.md`](./bankr-wallet.md).
