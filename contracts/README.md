# contracts — musebook bounty escrow

Foundry project for the spec Phase 4 on-chain escrow. Design and trust boundary live in [`docs/onchain-escrow.md`](../docs/onchain-escrow.md); deployment in [`docs/onchain-escrow-deployment.md`](../docs/onchain-escrow-deployment.md).

One contract: `src/MusebookBountyEscrow.sol`. No owner, no admin, no pause, no upgrade path, no sweep, and no constructor arguments — so the deployed bytecode is a pure function of the source and the deployer is granted nothing.

## Setup

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
git submodule update --init --recursive
forge build
```

If `lib/` is empty after clone (gitlinks without submodule checkout):

```bash
forge install foundry-rs/forge-std@v1.9.7 --no-commit
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-commit
```

## Test

```bash
forge test                         # 99 tests
forge test --match-path test/Adversarial.t.sol -vv
forge test --match-path test/Invariant.t.sol
forge coverage
```

| File | Tests | Covers |
|---|---|---|
| `test/Lifecycle.t.sol` | 28 | Every legitimate path end to end |
| `test/Adversarial.t.sol` | 67 | Every illegal way to move funds, plus pinned known hazards |
| `test/Invariant.t.sol` | 1 + 3 | 9 invariants over 24,576 calls, plus reachability |
| `test/Helpers.sol` | — | Hostile and cooperative fixtures |

`via_ir` is on, so a cold build takes a while. The invariant suite runs at depth 192 because the workflow is five steps deep and a shallower walk never reaches a settlement — `HandlerReachabilityTest` asserts that it does.

## Local end-to-end

```bash
anvil --port 8546 &
./script/local-e2e.sh
```

Deploys and drives all three settlement paths over real JSON-RPC. Uses anvil's published deterministic development keys, which hold no value anywhere.

## Deploy

```bash
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --account escrowDeployer --broadcast
ESCROW=<address> forge script script/Deploy.s.sol:VerifyDeployment --rpc-url "$RPC"
```

`VerifyDeployment` is read-only and needs no key: it confirms no admin surface responds, the proxy slots are empty, and the runtime bytecode has no `SELFDESTRUCT`, `DELEGATECALL`, `CALLCODE`, `CREATE`, or `CREATE2`.

**Never pass a raw private key on the command line.** Use `cast wallet import <name> --interactive` and `--account <name>`.

## The shape, in one table

| Call | Who | Effect |
|---|---|---|
| `declareBounty` | anyone | Records terms. Mints nothing, holds nothing. |
| `fund` | **only the declared funder** | Escrows the exact amount, mints the soulbound token. |
| `submit` | builder, or a relayer with a signature | Records a payout address with a proof state. |
| `proveSubmission` | anyone with the builder's signature | Makes a declared submission payable. |
| `withdrawSubmission` | the submission's payee | Concedes; reopens the refund path. |
| `release` | the token holder | Pays one named proven submission. |
| `dispute` | the token holder, once | Extends the review window by 7 days. |
| `arbitrate` | the optional per-bounty arbiter | Pay a proven submission, or refund the funder. |
| `releaseAfterReview` | **anyone** | After the window: pays the earliest proven submission. |
| `refundExpired` | **anyone** | After the deadline with no proven submission: pays the funder. |
| `withdraw` | a beneficiary with a deferred credit | Collects a failed push. Moves no escrow. |
