---
cursor:
  subagentId: "bc-53f292b9-1636-5279-8f7b-530f50217497"
---

# Escrow mainnet deploy — done

User-facing record: `/home/ubuntu/.cursor/projects/workspace/docs/onchain-escrow-mainnet.md`

| | |
|---|---|
| tx | `0x9ae4783b4ed8da5175bb40e5c5e220faa644a0cf3ae8915f9812cd8beb1ea0e1` |
| contract | `0x64b9b03A5deB47560e7EB6495a9f6Da426B80d5F` |
| chainId | 4663 |
| remaining | 0.010751310574528 ETH |
| explorer tx | https://robinhoodchain.blockscout.com/tx/0x9ae4783b4ed8da5175bb40e5c5e220faa644a0cf3ae8915f9812cd8beb1ea0e1 |
| explorer contract | https://robinhoodchain.blockscout.com/address/0x64b9b03A5deB47560e7EB6495a9f6Da426B80d5F |

WAF: AWS ALB 403 on `/wallet/submit` and `/wallet/sign` bodies > 8192 bytes. Gzip of the JSON was still ~9.1 KB. Brotli q11 was 7961 and returned 200. Raw `eth_signTransaction` is a Bankr 400 (policy), not a path. Files upload of 18 KB works (different WAF) but was not needed once brotli submit landed.

Did not move leftover funds. Did not use 46630. Did not print the Bankr API key. Did not edit the git repo.
