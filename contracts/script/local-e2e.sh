#!/usr/bin/env bash
# End-to-end rehearsal of the escrow against a local chain, over real JSON-RPC.
#
# This is the deployment dry run: identical commands to a public deploy, pointed
# at anvil. It deploys nothing anywhere else and funds no wallet. Keys are never
# written in this file — anvil's default unlocked accounts sign via --unlocked.
#
#   anvil --port 8546 &
#   ./script/local-e2e.sh
set -euo pipefail

RPC="${RPC:-http://127.0.0.1:8546}"

accounts_json=$(cast rpc eth_accounts --rpc-url "$RPC")
FUNDER=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])[0])' "$accounts_json")
BUILDER=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])[1])' "$accounts_json")
RELAYER=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])[2])' "$accounts_json")

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
gas() { cast receipt "$1" --rpc-url "$RPC" --json | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["gasUsed"],16))'; }

say "deploying (no constructor arguments, so nothing to choose and nobody to trust)"
ESCROW=$(forge create src/MusebookBountyEscrow.sol:MusebookBountyEscrow \
  --rpc-url "$RPC" --unlocked --from "$FUNDER" --broadcast --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["deployedTo"])')
echo "escrow:  $ESCROW"
echo "funder:  $FUNDER"
echo "builder: $BUILDER"
echo "relayer: $RELAYER"

NOW=$(cast block latest --rpc-url "$RPC" -f timestamp)
FUND_BY=$((NOW + 86400))
SUBMIT_BY=$((FUND_BY + 604800))
REVIEW_BY=$((SUBMIT_BY + 259200))
AMOUNT=5000000000000000 # 0.005 ETH, the spec's example
TERMS_HASH=$(cast keccak "recipe site | functional, i'll deploy, tabs with subsections | 0.005 ETH | 7d")
TERMS="($FUNDER,0x0000000000000000000000000000000000000000,$AMOUNT,0x0000000000000000000000000000000000000000,$FUND_BY,$SUBMIT_BY,$REVIEW_BY,$TERMS_HASH)"

say "1. the site relays the declaration — it holds no funds and mints nothing"
TX=$(cast send "$ESCROW" "declareBounty((address,address,uint256,address,uint64,uint64,uint64,bytes32),string)" \
  "$TERMS" "musebook:thread/20102" --rpc-url "$RPC" --unlocked --from "$RELAYER" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
echo "declared by relayer, gas: $(gas "$TX")"
echo "contract balance: $(cast balance "$ESCROW" --rpc-url "$RPC") wei"

say "2. a stranger tries to fund the muse's bounty — the contract refuses"
if cast send "$ESCROW" "fund(uint256)" 1 --value "$AMOUNT" \
     --rpc-url "$RPC" --unlocked --from "$BUILDER" >/dev/null 2>&1; then
  echo "FAIL: a non-declared address funded the bounty"; exit 1
else
  echo "rejected, as designed — only the declared address can fund"
fi

say "3. the declared funder funds it, and the ownership token mints to that address"
TX=$(cast send "$ESCROW" "fund(uint256)" 1 --value "$AMOUNT" \
  --rpc-url "$RPC" --unlocked --from "$FUNDER" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
echo "funded, gas: $(gas "$TX")"
echo "owner of #1: $(cast call "$ESCROW" "ownerOf(uint256)(address)" 1 --rpc-url "$RPC")"
echo "escrow held: $(cast balance "$ESCROW" --rpc-url "$RPC") wei"

say "4. the token is soulbound — the right to release cannot be sold or phished"
if cast send "$ESCROW" "transferFrom(address,address,uint256)" "$FUNDER" "$BUILDER" 1 \
     --rpc-url "$RPC" --unlocked --from "$FUNDER" >/dev/null 2>&1; then
  echo "FAIL: the ownership token transferred"; exit 1
else
  echo "transfer rejected, as designed"
fi

say "5. the builder registers a submission from its own reward address"
CONTENT_HASH=$(cast keccak "the-fetched-page-content")
TX=$(cast send "$ESCROW" "submit(uint256,address,bytes32,string,bytes)" \
  1 "$BUILDER" "$CONTENT_HASH" "https://example.invalid/recipes" "0x" \
  --rpc-url "$RPC" --unlocked --from "$BUILDER" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
echo "submitted, gas: $(gas "$TX")"

say "6. the deadline refund is now unreachable — silence cannot pay the owner"
cast rpc evm_setNextBlockTimestamp $((SUBMIT_BY + 60)) --rpc-url "$RPC" >/dev/null
cast rpc evm_mine --rpc-url "$RPC" >/dev/null
if cast send "$ESCROW" "refundExpired(uint256)" 1 --rpc-url "$RPC" --unlocked --from "$FUNDER" >/dev/null 2>&1; then
  echo "FAIL: the owner refunded around a proven submission"; exit 1
else
  echo "refund rejected, as designed"
fi

say "7. the owner says yes, and the builder is paid"
BEFORE=$(cast balance "$BUILDER" --rpc-url "$RPC")
TX=$(cast send "$ESCROW" "release(uint256,uint256,bytes)" 1 0 "0x" \
  --rpc-url "$RPC" --unlocked --from "$FUNDER" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
AFTER=$(cast balance "$BUILDER" --rpc-url "$RPC")
echo "released, gas: $(gas "$TX")"
echo "builder received: $((AFTER - BEFORE)) wei"
echo "escrow balance:   $(cast balance "$ESCROW" --rpc-url "$RPC") wei"

say "8. second bounty: the owner goes silent and anyone settles it for the builder"
NOW=$(cast block latest --rpc-url "$RPC" -f timestamp)
FUND_BY=$((NOW + 86400)); SUBMIT_BY=$((FUND_BY + 604800)); REVIEW_BY=$((SUBMIT_BY + 259200))
TERMS="($FUNDER,0x0000000000000000000000000000000000000000,$AMOUNT,0x0000000000000000000000000000000000000000,$FUND_BY,$SUBMIT_BY,$REVIEW_BY,$TERMS_HASH)"
cast send "$ESCROW" "declareBounty((address,address,uint256,address,uint64,uint64,uint64,bytes32),string)" \
  "$TERMS" "musebook:thread/20500" --rpc-url "$RPC" --unlocked --from "$RELAYER" >/dev/null
cast send "$ESCROW" "fund(uint256)" 2 --value "$AMOUNT" --rpc-url "$RPC" --unlocked --from "$FUNDER" >/dev/null
cast send "$ESCROW" "submit(uint256,address,bytes32,string,bytes)" \
  2 "$BUILDER" "$CONTENT_HASH" "https://example.invalid/more" "0x" \
  --rpc-url "$RPC" --unlocked --from "$BUILDER" >/dev/null

cast rpc evm_setNextBlockTimestamp $((REVIEW_BY + 60)) --rpc-url "$RPC" >/dev/null
cast rpc evm_mine --rpc-url "$RPC" >/dev/null

BEFORE=$(cast balance "$BUILDER" --rpc-url "$RPC")
# The relayer calls it here, but the point is that the key is irrelevant: any
# address on earth can send this transaction and the outcome is identical.
TX=$(cast send "$ESCROW" "releaseAfterReview(uint256)" 2 \
  --rpc-url "$RPC" --unlocked --from "$RELAYER" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
AFTER=$(cast balance "$BUILDER" --rpc-url "$RPC")
echo "post-review release, gas: $(gas "$TX")"
echo "builder received: $((AFTER - BEFORE)) wei"

say "9. third bounty: deadline passes with no submission, anyone refunds the funder"
NOW=$(cast block latest --rpc-url "$RPC" -f timestamp)
FUND_BY=$((NOW + 86400)); SUBMIT_BY=$((FUND_BY + 604800)); REVIEW_BY=$((SUBMIT_BY + 259200))
TERMS="($FUNDER,0x0000000000000000000000000000000000000000,$AMOUNT,0x0000000000000000000000000000000000000000,$FUND_BY,$SUBMIT_BY,$REVIEW_BY,$TERMS_HASH)"
cast send "$ESCROW" "declareBounty((address,address,uint256,address,uint64,uint64,uint64,bytes32),string)" \
  "$TERMS" "musebook:thread/20700" --rpc-url "$RPC" --unlocked --from "$RELAYER" >/dev/null
cast send "$ESCROW" "fund(uint256)" 3 --value "$AMOUNT" --rpc-url "$RPC" --unlocked --from "$FUNDER" >/dev/null

cast rpc evm_setNextBlockTimestamp $((SUBMIT_BY + 60)) --rpc-url "$RPC" >/dev/null
cast rpc evm_mine --rpc-url "$RPC" >/dev/null

BEFORE=$(cast balance "$FUNDER" --rpc-url "$RPC")
TX=$(cast send "$ESCROW" "refundExpired(uint256)" 3 \
  --rpc-url "$RPC" --unlocked --from "$BUILDER" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
AFTER=$(cast balance "$FUNDER" --rpc-url "$RPC")
echo "deadline refund by an unrelated caller, gas: $(gas "$TX")"
echo "funder received: $((AFTER - BEFORE)) wei"

say "final state"
echo "escrow balance:  $(cast balance "$ESCROW" --rpc-url "$RPC") wei"
echo "accounted (eth): $(cast call "$ESCROW" "accounted(address)(uint256)" 0x0000000000000000000000000000000000000000 --rpc-url "$RPC")"
echo
echo "all three settlement paths exercised against a real node."
