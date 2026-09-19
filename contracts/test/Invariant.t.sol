// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MusebookBountyEscrow} from "../src/MusebookBountyEscrow.sol";
import {MockERC20, ForceFeeder} from "./Helpers.sol";

/// @dev Drives the escrow through random sequences of every externally callable
/// action, from a fixed cast of actors, and records ghost state the invariants
/// check against. Reverts are expected and ignored: the point is that no reachable
/// sequence of legal calls can break the accounting.
contract Handler is Test {
    MusebookBountyEscrow public immutable escrow;
    MockERC20 public immutable token;

    uint256 public constant ACTORS = 5;
    uint256[] public actorPks;
    address[] public actors;

    uint256[] public bountyIds;

    // ---- ghosts ---------------------------------------------------------
    mapping(address token => uint256) public ghostFunded;
    mapping(address token => uint256) public ghostPaidOut;
    /// @dev every address that has ever legitimately received value, and the
    /// bounty that entitled it. Used to prove no stranger was ever paid.
    mapping(uint256 bountyId => mapping(address => bool)) public ghostEligible;
    uint256 public ghostSettlements;

    constructor(MusebookBountyEscrow escrow_, MockERC20 token_) {
        escrow = escrow_;
        token = token_;
        // `vm.prank` rewrites msg.sender but native value still leaves this
        // contract's balance, so the handler needs its own float to fund with.
        vm.deal(address(this), 1_000_000 ether);
        for (uint256 i; i < ACTORS; ++i) {
            uint256 pk = 0xA11CE + i;
            actorPks.push(pk);
            address a = vm.addr(pk);
            actors.push(a);
            vm.deal(a, 1_000 ether);
            token_.mint(a, 1_000_000e18);
            vm.prank(a);
            token_.approve(address(escrow_), type(uint256).max);
        }
    }

    function bountyCount() external view returns (uint256) {
        return bountyIds.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _bounty(uint256 seed) internal view returns (uint256) {
        if (bountyIds.length == 0) return 0;
        return bountyIds[seed % bountyIds.length];
    }

    // ---- actions --------------------------------------------------------

    function declare(uint256 funderSeed, uint256 arbiterSeed, uint256 amountSeed, bool useToken, bool withArbiter)
        external
    {
        address funder = _actor(funderSeed);
        address arbiter = withArbiter ? _actor(arbiterSeed) : address(0);
        if (arbiter == funder) arbiter = address(0);

        uint256 amount = bound(amountSeed, 1, 10 ether);
        uint64 fundBy = uint64(block.timestamp) + 1 days;
        uint64 submitBy = fundBy + 7 days;

        MusebookBountyEscrow.Terms memory t = MusebookBountyEscrow.Terms({
            funder: funder,
            token: useToken ? address(token) : address(0),
            amount: amount,
            arbiter: arbiter,
            fundBy: fundBy,
            submitBy: submitBy,
            reviewBy: submitBy + 3 days,
            termsHash: keccak256(abi.encode(amountSeed))
        });

        vm.prank(_actor(funderSeed + 1)); // any relayer
        uint256 id = escrow.declareBounty(t, "musebook:thread/1");
        bountyIds.push(id);
        ghostEligible[id][funder] = true;
    }

    function fund(uint256 bountySeed) external {
        uint256 id = _bounty(bountySeed);
        if (id == 0) return;
        MusebookBountyEscrow.Terms memory t = escrow.getTerms(id);
        if (escrow.getBounty(id).status != MusebookBountyEscrow.Status.Declared) return;
        if (block.timestamp > t.fundBy) return;

        vm.prank(t.funder);
        if (t.token == address(0)) {
            escrow.fund{value: t.amount}(id);
        } else {
            escrow.fund(id);
        }
        ghostFunded[t.token] += t.amount;
    }

    /// @dev Anyone may try to fund any bounty. Only the declared funder succeeds,
    /// and this action exists to keep proving that inside the random walk.
    function fundAsWrongActor(uint256 bountySeed, uint256 actorSeed) external {
        uint256 id = _bounty(bountySeed);
        if (id == 0) return;
        MusebookBountyEscrow.Terms memory t = escrow.getTerms(id);
        address who = _actor(actorSeed);
        if (who == t.funder) return;

        vm.prank(who);
        try escrow.fund{value: t.token == address(0) ? t.amount : 0}(id) {
            revert("a non-declared address funded a bounty");
        } catch {}
    }

    function submitSelf(uint256 bountySeed, uint256 actorSeed) external {
        uint256 id = _bounty(bountySeed);
        if (id == 0) return;
        address who = _actor(actorSeed);
        vm.prank(who);
        try escrow.submit(id, who, keccak256(abi.encode(id, who)), "ipfs://work", "") {
            ghostEligible[id][who] = true;
        } catch {}
    }

    function submitSigned(uint256 bountySeed, uint256 actorSeed, uint256 relayerSeed) external {
        uint256 id = _bounty(bountySeed);
        if (id == 0) return;
        uint256 idx = actorSeed % actors.length;
        address who = actors[idx];
        bytes32 hash_ = keccak256(abi.encode(id, who, "signed"));
        bytes32 digest = escrow.submissionStatementDigest(id, who, hash_, "ipfs://signed");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(actorPks[idx], digest);

        vm.prank(_actor(relayerSeed));
        try escrow.submit(id, who, hash_, "ipfs://signed", abi.encodePacked(r, s, v)) {
            ghostEligible[id][who] = true;
        } catch {}
    }

    function submitDeclaredOnly(uint256 bountySeed, uint256 actorSeed, uint256 relayerSeed) external {
        uint256 id = _bounty(bountySeed);
        if (id == 0) return;
        address who = _actor(actorSeed);
        address relayer = _actor(relayerSeed);
        if (relayer == who) return;

        vm.prank(relayer);
        try escrow.submit(id, who, keccak256(abi.encode(id, who, "declared")), "ipfs://declared", "") {
            ghostEligible[id][who] = true;
        } catch {}
    }

    function proveSubmission(uint256 bountySeed, uint256 subSeed) external {
        uint256 id = _bounty(bountySeed);
        if (id == 0) return;
        uint256 n = escrow.submissionCount(id);
        if (n == 0) return;
        uint256 sid = subSeed % n;
        address payee = escrow.getSubmission(id, sid).payee;

        vm.prank(payee);
        try escrow.proveSubmission(id, sid, "") {} catch {}
    }

    function withdrawSubmission(uint256 bountySeed, uint256 subSeed) external {
        uint256 id = _bounty(bountySeed);
        if (id == 0) return;
        uint256 n = escrow.submissionCount(id);
        if (n == 0) return;
        uint256 sid = subSeed % n;

        vm.prank(escrow.getSubmission(id, sid).payee);
        try escrow.withdrawSubmission(id, sid) {} catch {}
    }

    function release(uint256 bountySeed, uint256 subSeed, uint256 callerSeed) external {
        uint256 id = _bounty(bountySeed);
        if (id == 0) return;
        uint256 n = escrow.submissionCount(id);
        if (n == 0) return;

        // Deliberately not always the holder: the random walk should keep trying
        // to release as the wrong caller.
        address caller = callerSeed % 3 == 0 ? _actor(callerSeed) : escrow.getTerms(id).funder;
        vm.prank(caller);
        try escrow.release(id, subSeed % n, "") {
            _recordSettlement(id);
        } catch {}
    }

    function dispute(uint256 bountySeed, uint256 subSeed) external {
        uint256 id = _bounty(bountySeed);
        if (id == 0) return;
        uint256 n = escrow.submissionCount(id);
        if (n == 0) return;

        vm.prank(escrow.getTerms(id).funder);
        try escrow.dispute(id, subSeed % n) {} catch {}
    }

    function arbitrate(uint256 bountySeed, uint256 subSeed, bool pay) external {
        uint256 id = _bounty(bountySeed);
        if (id == 0) return;
        uint256 n = escrow.submissionCount(id);
        address arb = escrow.getTerms(id).arbiter;
        if (arb == address(0)) return;

        vm.prank(arb);
        try escrow.arbitrate(id, pay, n == 0 ? 0 : subSeed % n) {
            _recordSettlement(id);
        } catch {}
    }

    function releaseAfterReview(uint256 bountySeed, uint256 callerSeed) external {
        uint256 id = _bounty(bountySeed);
        if (id == 0) return;
        vm.prank(_actor(callerSeed));
        try escrow.releaseAfterReview(id) {
            _recordSettlement(id);
        } catch {}
    }

    function refundExpired(uint256 bountySeed, uint256 callerSeed) external {
        uint256 id = _bounty(bountySeed);
        if (id == 0) return;
        vm.prank(_actor(callerSeed));
        try escrow.refundExpired(id) {
            _recordSettlement(id);
        } catch {}
    }

    function withdrawCredit(uint256 actorSeed, bool useToken) external {
        address who = _actor(actorSeed);
        address t = useToken ? address(token) : address(0);
        vm.prank(who);
        try escrow.withdraw(t) returns (uint256 amount) {
            ghostPaidOut[t] += amount;
        } catch {}
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1 hours, 10 days));
    }

    /// @dev Anyone can force native currency in with `selfdestruct`. The invariants
    /// must hold anyway, and the donation must never become spendable.
    function forceFeed(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, 1 ether);
        vm.deal(address(this), address(this).balance + amount);
        new ForceFeeder{value: amount}(payable(address(escrow)));
    }

    function _recordSettlement(uint256 id) private {
        ghostSettlements += 1;
        MusebookBountyEscrow.Bounty memory b = escrow.getBounty(id);
        address who = _settlementBeneficiary(id, b);
        require(ghostEligible[id][who], "escrow paid an address with no claim on this bounty");
        // The push half of a settlement pays out immediately; a deferred one is
        // counted when the credit is collected.
        uint256 credit = escrow.credits(b.terms.token, who);
        if (credit == 0) ghostPaidOut[b.terms.token] += b.terms.amount;
    }

    function _settlementBeneficiary(uint256 id, MusebookBountyEscrow.Bounty memory b) private view returns (address) {
        if (
            b.settlement == MusebookBountyEscrow.Settlement.DeadlineRefund
                || b.settlement == MusebookBountyEscrow.Settlement.ArbiterRefund
        ) {
            return b.terms.funder;
        }
        // A release paid some proven submission; find the one that is now unpayable
        // only by virtue of the bounty being settled. Any of them is eligible.
        uint256 n = escrow.submissionCount(id);
        for (uint256 i; i < n; ++i) {
            MusebookBountyEscrow.Submission memory s = escrow.getSubmission(id, i);
            if (s.proof != MusebookBountyEscrow.Proof.Declared) return s.payee;
        }
        return b.terms.funder;
    }

    receive() external payable {}
}

/// @notice The spec's money invariant, stated as properties that must hold after
/// any reachable sequence of calls by anyone.
contract InvariantTest is Test {
    MusebookBountyEscrow internal escrow;
    MockERC20 internal token;
    Handler internal handler;

    function setUp() public {
        vm.warp(1_756_000_000);
        escrow = new MusebookBountyEscrow();
        token = new MockERC20();
        handler = new Handler(escrow, token);

        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = Handler.declare.selector;
        selectors[1] = Handler.fund.selector;
        selectors[2] = Handler.fundAsWrongActor.selector;
        selectors[3] = Handler.submitSelf.selector;
        selectors[4] = Handler.submitSigned.selector;
        selectors[5] = Handler.submitDeclaredOnly.selector;
        selectors[6] = Handler.proveSubmission.selector;
        selectors[7] = Handler.withdrawSubmission.selector;
        selectors[8] = Handler.release.selector;
        selectors[9] = Handler.dispute.selector;
        selectors[10] = Handler.arbitrate.selector;
        selectors[11] = Handler.releaseAfterReview.selector;
        selectors[12] = Handler.refundExpired.selector;
        selectors[13] = Handler.warp.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice The contract is always solvent: it holds at least what it owes.
    function invariant_solventInNativeCurrency() public view {
        assertGe(address(escrow).balance, escrow.accounted(address(0)));
    }

    function invariant_solventInErc20() public view {
        assertGe(token.balanceOf(address(escrow)), escrow.accounted(address(token)));
    }

    /// @notice What the contract believes it owes equals live escrow plus
    /// uncollected credits — never more, never less.
    function invariant_accountingMatchesEscrowPlusCredits() public view {
        _checkAccounting(address(0));
        _checkAccounting(address(token));
    }

    /// @notice A settled bounty holds nothing and names the reason it settled.
    function invariant_settledBountiesHoldNothing() public view {
        uint256 n = handler.bountyCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.bountyIds(i);
            MusebookBountyEscrow.Bounty memory b = escrow.getBounty(id);
            if (b.status == MusebookBountyEscrow.Status.Settled) {
                assertEq(b.escrow, 0);
                assertTrue(b.settlement != MusebookBountyEscrow.Settlement.None);
            }
        }
    }

    /// @notice A declared-but-unfunded bounty holds nothing and has no token.
    function invariant_declaredBountiesOwnNothing() public view {
        uint256 n = handler.bountyCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.bountyIds(i);
            MusebookBountyEscrow.Bounty memory b = escrow.getBounty(id);
            if (b.status == MusebookBountyEscrow.Status.Declared) {
                assertEq(b.escrow, 0);
                (bool minted,) = address(escrow).staticcall(abi.encodeCall(escrow.ownerOf, (id)));
                assertFalse(minted, "nothing is owned before funding");
            }
        }
    }

    /// @notice The ownership token, once minted, is held by the declared funder
    /// forever. Soulbound means the holder set never changes.
    function invariant_tokenAlwaysHeldByTheDeclaredFunder() public view {
        uint256 n = handler.bountyCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.bountyIds(i);
            MusebookBountyEscrow.Bounty memory b = escrow.getBounty(id);
            if (b.status != MusebookBountyEscrow.Status.Declared && b.status != MusebookBountyEscrow.Status.None) {
                assertEq(escrow.ownerOf(id), b.terms.funder);
            }
        }
    }

    /// @notice A funded bounty holds exactly the amount its terms declared.
    function invariant_fundedBountyHoldsItsDeclaredAmount() public view {
        uint256 n = handler.bountyCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.bountyIds(i);
            MusebookBountyEscrow.Bounty memory b = escrow.getBounty(id);
            if (b.status == MusebookBountyEscrow.Status.Funded) {
                assertEq(b.escrow, b.terms.amount);
            }
        }
    }

    /// @notice Nothing ever leaves without having entered: total ever escrowed is
    /// an upper bound on total ever paid out.
    function invariant_payoutsNeverExceedDeposits() public view {
        assertLe(handler.ghostPaidOut(address(0)), handler.ghostFunded(address(0)));
        assertLe(handler.ghostPaidOut(address(token)), handler.ghostFunded(address(token)));
    }

    /// @notice A submission whose payout address was never proven is never the
    /// beneficiary of a settlement, and the bounty's proven counter tracks reality.
    function invariant_provenCountMatchesSubmissions() public view {
        uint256 n = handler.bountyCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.bountyIds(i);
            MusebookBountyEscrow.Bounty memory b = escrow.getBounty(id);
            uint256 subs = escrow.submissionCount(id);
            uint256 counted;
            uint256 firstSeen = type(uint256).max;
            for (uint256 j; j < subs; ++j) {
                MusebookBountyEscrow.Submission memory s = escrow.getSubmission(id, j);
                if (s.proof != MusebookBountyEscrow.Proof.Declared && !s.withdrawn) {
                    counted += 1;
                    if (firstSeen == type(uint256).max) firstSeen = j;
                }
            }
            assertEq(uint256(b.provenActive), counted, "provenActive drifted");
            if (counted > 0) assertEq(uint256(b.firstProven), firstSeen, "firstProven drifted");
        }
    }

    function _checkAccounting(address t) private view {
        uint256 liveEscrow;
        uint256 n = handler.bountyCount();
        for (uint256 i; i < n; ++i) {
            MusebookBountyEscrow.Bounty memory b = escrow.getBounty(handler.bountyIds(i));
            if (b.terms.token == t) liveEscrow += b.escrow;
        }

        uint256 outstandingCredits;
        uint256 a = handler.actorCount();
        for (uint256 i; i < a; ++i) {
            outstandingCredits += escrow.credits(t, handler.actors(i));
        }

        assertEq(escrow.accounted(t), liveEscrow + outstandingCredits);
    }
}

/// @notice An invariant suite whose handler cannot reach the interesting states
/// proves nothing. This drives the same handler through a scripted sequence and
/// asserts each action really does what the random walk relies on it doing.
contract HandlerReachabilityTest is Test {
    MusebookBountyEscrow internal escrow;
    MockERC20 internal token;
    Handler internal handler;

    function setUp() public {
        vm.warp(1_756_000_000);
        escrow = new MusebookBountyEscrow();
        token = new MockERC20();
        handler = new Handler(escrow, token);
    }

    function test_handlerCanReachEveryTerminalState() public {
        // Native bounty settled by owner release.
        handler.declare(0, 0, 1 ether, false, false);
        handler.fund(0);
        assertGt(handler.ghostFunded(address(0)), 0, "native funding is reachable");
        handler.submitSelf(0, 1);
        handler.release(0, 0, 1);

        // ERC-20 bounty settled by the deadline refund.
        handler.declare(2, 0, 500e18, true, false);
        handler.fund(1);
        assertGt(handler.ghostFunded(address(token)), 0, "erc20 funding is reachable");
        handler.warp(9 days);
        handler.refundExpired(1, 0);

        // Native bounty settled by permissionless post-review release, after a
        // signature-proven submission relayed by someone else.
        handler.declare(3, 0, 2 ether, false, false);
        handler.fund(2);
        handler.submitSigned(2, 4, 1);
        handler.warp(10 days);
        handler.warp(5 days);
        handler.releaseAfterReview(2, 1);

        assertGe(handler.ghostSettlements(), 3, "all three settlement shapes are reachable");
        assertGt(handler.ghostPaidOut(address(0)), 0);
        assertGt(handler.ghostPaidOut(address(token)), 0);
    }

    function test_handlerWrongFunderActionNeverSucceeds() public {
        handler.declare(0, 0, 1 ether, false, false);
        // Reverts internally if a non-declared address ever manages to fund.
        for (uint256 i = 1; i < 5; ++i) {
            handler.fundAsWrongActor(0, i);
        }
        assertEq(handler.ghostFunded(address(0)), 0, "no wrong-sender funding got through");
    }

    function test_handlerForceFeedDoesNotDisturbAccounting() public {
        handler.declare(0, 0, 1 ether, false, false);
        handler.fund(0);
        handler.forceFeed(3 ether);

        assertEq(escrow.accounted(address(0)), 1 ether);
        assertGt(address(escrow).balance, escrow.accounted(address(0)));
    }
}
