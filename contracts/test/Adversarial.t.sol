// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {MusebookBountyEscrow} from "../src/MusebookBountyEscrow.sol";
import {
    MockERC20,
    FeeOnTransferERC20,
    ReentrantERC20,
    MaliciousPayee,
    ForceFeeder,
    ContractHolder,
    SmartAccount
} from "./Helpers.sol";

/// @notice The spec's acceptance criterion, taken literally: "funds cannot move
/// except via agree / council-pay / deadline-refund (write a test that tries)."
///
/// Every test in this file tries to move escrow some other way and asserts it
/// fails. Wrong caller, wrong address, wrong time, twice, re-entrant, forced in,
/// or simply asked nicely.
contract AdversarialTest is BaseTest {
    address internal attacker = makeAddr("attacker");

    function setUp() public override {
        super.setUp();
        vm.deal(attacker, 100 ether);
    }

    // ==================================================================
    // 1. Funding cannot be spoofed — the declaration is enforced
    // ==================================================================

    function test_revert_fundFromAnyAddressOtherThanTheDeclaredOne() public {
        uint256 id = _declare(_defaultTerms());

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.FunderMismatch.selector, funder, attacker));
        escrow.fund{value: AMOUNT}(id);

        assertEq(address(escrow).balance, 0, "a mismatched payment never becomes escrow");
        assertEq(attacker.balance, 100 ether, "and is never held pending a refund");
        assertEq(uint8(escrow.getBounty(id).status), uint8(MusebookBountyEscrow.Status.Declared));
    }

    /// @dev The property that makes our relay auditable instead of trusted: if the
    /// site transcribes the wrong funder address, the failure is a revert the real
    /// funder sees immediately, not a payment that silently lands somewhere else.
    function test_misrecordedFunderFailsClosed() public {
        // The site records the attacker's address instead of the muse's.
        MusebookBountyEscrow.Terms memory t = _defaultTerms();
        t.funder = attacker;
        uint256 id = _declare(t);

        // The real muse's funding transaction reverts. It learns at once.
        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.FunderMismatch.selector, attacker, funder));
        escrow.fund{value: AMOUNT}(id);

        // The attacker may fund its own misrecorded bounty, but it is spending its
        // own money and can only ever get its own money back.
        vm.prank(attacker);
        escrow.fund{value: AMOUNT}(id);
        assertEq(escrow.ownerOf(id), attacker);

        vm.warp(t.submitBy + 1);
        uint256 funderBefore = funder.balance;
        escrow.refundExpired(id);
        assertEq(attacker.balance, 100 ether, "the attacker is exactly where it started");
        assertEq(funder.balance, funderBefore, "the muse never lost anything");
    }

    function test_revert_fundWithWrongAmount() public {
        uint256 id = _declare(_defaultTerms());

        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.AmountMismatch.selector, AMOUNT, AMOUNT - 1));
        escrow.fund{value: AMOUNT - 1}(id);

        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.AmountMismatch.selector, AMOUNT, AMOUNT + 1));
        escrow.fund{value: AMOUNT + 1}(id);

        assertEq(address(escrow).balance, 0);
    }

    function test_revert_fundTwice() public {
        uint256 id = _defaultFunded();

        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(
                MusebookBountyEscrow.WrongStatus.selector,
                MusebookBountyEscrow.Status.Declared,
                MusebookBountyEscrow.Status.Funded
            )
        );
        escrow.fund{value: AMOUNT}(id);

        assertEq(address(escrow).balance, AMOUNT, "double funding cannot inflate escrow");
    }

    function test_revert_fundAfterFundingWindow() public {
        uint256 id = _declare(_defaultTerms());
        uint64 fundBy = escrow.getTerms(id).fundBy;
        vm.warp(fundBy + 1);

        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(MusebookBountyEscrow.FundingWindowClosed.selector, fundBy, block.timestamp)
        );
        escrow.fund{value: AMOUNT}(id);
    }

    function test_revert_fundNativeValueIntoAnErc20Bounty() public {
        uint256 id = _declare(_terms(funder, address(token), 1000e18, address(0)));
        token.mint(funder, 1000e18);
        vm.prank(funder);
        token.approve(address(escrow), 1000e18);

        vm.prank(funder);
        vm.expectRevert(MusebookBountyEscrow.NativeValueNotAccepted.selector);
        escrow.fund{value: 1 ether}(id);
    }

    function test_revert_feeOnTransferTokenIsRejectedNotSilentlyUnderfunded() public {
        FeeOnTransferERC20 lossy = new FeeOnTransferERC20();
        uint256 id = _declare(_terms(funder, address(lossy), 1000e18, address(0)));
        lossy.mint(funder, 1000e18);

        vm.startPrank(funder);
        lossy.approve(address(escrow), 1000e18);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.AmountMismatch.selector, 1000e18, 990e18));
        escrow.fund(id);
        vm.stopPrank();

        assertEq(lossy.balanceOf(address(escrow)), 0);
    }

    function test_revert_fundNonExistentBounty() public {
        vm.prank(funder);
        vm.expectRevert();
        escrow.fund{value: AMOUNT}(999);
    }

    // ==================================================================
    // 2. Value cannot arrive except through fund()
    // ==================================================================

    function test_revert_directNativeTransferToTheContract() public {
        vm.prank(attacker);
        (bool ok,) = address(escrow).call{value: 1 ether}("");
        assertFalse(ok, "no receive, no fallback, no accidental escrow");
        assertEq(address(escrow).balance, 0);
    }

    function test_revert_callingAnUnknownFunctionWithValue() public {
        vm.prank(attacker);
        (bool ok,) = address(escrow).call{value: 1 ether}(abi.encodeWithSignature("rescue(address)", attacker));
        assertFalse(ok);
        assertEq(address(escrow).balance, 0);
    }

    /// @dev `selfdestruct` can still force native currency into any address. There
    /// is deliberately no sweep, so the forced value is unreachable by everyone —
    /// including the deployer, the funder, and us — and the accounting ignores it.
    function test_forcedNativeValueIsStrandedAndChangesNothing() public {
        uint256 id = _defaultFunded();

        new ForceFeeder{value: 5 ether}(payable(address(escrow)));
        assertEq(address(escrow).balance, AMOUNT + 5 ether);
        assertEq(escrow.accounted(address(0)), AMOUNT, "forced value is not accounted");

        // Nobody can claim it.
        vm.prank(attacker);
        vm.expectRevert(MusebookBountyEscrow.NothingToWithdraw.selector);
        escrow.withdraw(address(0));

        // And the bounty still settles for exactly its own escrow, not a wei more.
        uint256 sid = _submitSelf(id, builder);
        vm.prank(funder);
        escrow.release(id, sid, "");

        assertEq(builder.balance, 10 ether + AMOUNT, "the payee gets the escrow, not the donation");
        assertEq(address(escrow).balance, 5 ether, "the stranded value stays stranded");
        assertEq(escrow.accounted(address(0)), 0);
    }

    function test_donatedErc20CannotBeClaimed() public {
        uint256 id = _declareAndFund(_terms(funder, address(token), 1000e18, address(0)));
        token.mint(address(escrow), 500e18);

        assertEq(escrow.accounted(address(token)), 1000e18);
        uint256 sid = _submitSelf(id, builder);
        vm.prank(funder);
        escrow.release(id, sid, "");

        assertEq(token.balanceOf(builder), 1000e18);
        assertEq(token.balanceOf(address(escrow)), 500e18, "the donation is unreachable");

        vm.prank(attacker);
        vm.expectRevert(MusebookBountyEscrow.NothingToWithdraw.selector);
        escrow.withdraw(address(token));
    }

    // ==================================================================
    // 3. Release: wrong caller, wrong submission, wrong time
    // ==================================================================

    function test_revert_releaseByNonHolder() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);

        address[4] memory impostors = [attacker, builder, relayer, deployer];
        for (uint256 i; i < impostors.length; ++i) {
            vm.prank(impostors[i]);
            vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.NotBountyOwner.selector, funder, impostors[i]));
            escrow.release(id, sid, "");
        }
        assertEq(address(escrow).balance, AMOUNT);
    }

    function test_revert_releaseByDeployer() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);

        // The deployer has no standing whatsoever. There is no owner to be.
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.NotBountyOwner.selector, funder, deployer));
        escrow.release(id, sid, "");
    }

    function test_revert_releaseTwice() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);

        vm.prank(funder);
        escrow.release(id, sid, "");

        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(
                MusebookBountyEscrow.WrongStatus.selector,
                MusebookBountyEscrow.Status.Funded,
                MusebookBountyEscrow.Status.Settled
            )
        );
        escrow.release(id, sid, "");

        assertEq(builder.balance, 10 ether + AMOUNT, "paid exactly once");
    }

    function test_revert_releaseOnUnfundedBounty() public {
        uint256 id = _declare(_defaultTerms());
        vm.prank(funder);
        vm.expectRevert();
        escrow.release(id, 0, "");
    }

    function test_revert_releaseNonExistentSubmission() public {
        uint256 id = _defaultFunded();
        _submitSelf(id, builder);

        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.NoSuchSubmission.selector, 7));
        escrow.release(id, 7, "");
    }

    function test_revert_releaseAWithdrawnSubmission() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);
        vm.prank(builder);
        escrow.withdrawSubmission(id, sid);

        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.SubmissionIsWithdrawn.selector, sid));
        escrow.release(id, sid, "");
    }

    function test_revert_releaseSubmissionFromAnotherBounty() public {
        uint256 idA = _defaultFunded();
        uint256 idB = _defaultFunded();
        _submitSelf(idB, builder);

        // Bounty A has no submissions; B's index does not leak across.
        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.NoSuchSubmission.selector, 0));
        escrow.release(idA, 0, "");
    }

    // ==================================================================
    // 4. An unproven payout address is never payable
    // ==================================================================

    function test_revert_releaseToDeclaredButUnprovenSubmission() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitDeclared(id, builder);

        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.PayoutAddressNotProven.selector, sid));
        escrow.release(id, sid, "");

        assertEq(address(escrow).balance, AMOUNT, "review is not a payable state on its own");
    }

    function test_revert_permissionlessReleaseWithOnlyUnprovenSubmissions() public {
        uint256 id = _defaultFunded();
        _submitDeclared(id, builder);
        _submitDeclared(id, builder2);

        vm.warp(escrow.getTerms(id).reviewBy + 1);
        vm.expectRevert(MusebookBountyEscrow.NoProvenSubmission.selector);
        escrow.releaseAfterReview(id);
    }

    function test_revert_arbiterCannotPayAnUnprovenSubmission() public {
        uint256 id = _declareAndFund(_terms(funder, address(0), AMOUNT, arbiter));
        uint256 sid = _submitDeclared(id, builder);
        vm.prank(funder);
        escrow.dispute(id, sid);

        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.PayoutAddressNotProven.selector, sid));
        escrow.arbitrate(id, true, sid);
    }

    /// @dev The phishing case a checksum cannot catch: a well-formed address the
    /// submitter does not control. Without a valid signature it stays unpayable.
    function test_revert_provingWithSomeoneElsesSignature() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitDeclared(id, attacker); // payee is an address the builder does not control

        // The builder signs the statement; it does not recover to the attacker.
        bytes memory wrongSig = _signStatement(id, attacker, _contentHash(attacker), WORK_URI, builderPk);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.BadSignature.selector, attacker, address(0)));
        escrow.proveSubmission(id, sid, wrongSig);
    }

    function test_revert_signatureFromADifferentBountyIsNotReplayable() public {
        uint256 idA = _defaultFunded();
        uint256 idB = _defaultFunded();
        uint256 sid = _submitDeclared(idB, builder);

        bytes memory sigForA = _signStatement(idA, builder, _contentHash(builder), WORK_URI, builderPk);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.BadSignature.selector, builder, address(0)));
        escrow.proveSubmission(idB, sid, sigForA);
    }

    function test_revert_signatureOverDifferentContentIsNotReusable() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitDeclared(id, builder);

        bytes memory sigOverOtherWork = _signStatement(id, builder, keccak256("some other work"), WORK_URI, builderPk);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.BadSignature.selector, builder, address(0)));
        escrow.proveSubmission(id, sid, sigOverOtherWork);
    }

    function test_revert_submitWithGarbageSignature() public {
        uint256 id = _defaultFunded();
        vm.prank(relayer);
        vm.expectRevert();
        escrow.submit(id, builder, _contentHash(builder), WORK_URI, hex"deadbeef");
    }

    function test_smartAccountPayeeCanProveViaErc1271() public {
        uint256 id = _defaultFunded();
        SmartAccount account = new SmartAccount(builder);

        bytes32 hash_ = keccak256("smart account work");
        vm.prank(relayer);
        uint256 sid = escrow.submit(id, address(account), hash_, WORK_URI, "");
        assertEq(uint8(escrow.getSubmission(id, sid).proof), uint8(MusebookBountyEscrow.Proof.Declared));

        bytes memory sig = _signStatement(id, address(account), hash_, WORK_URI, builderPk);
        escrow.proveSubmission(id, sid, sig);

        vm.prank(funder);
        escrow.release(id, sid, "");
        assertEq(address(account).balance, AMOUNT, "key recovery lives in the account, not the escrow");
    }

    function test_revert_proveAnAlreadyProvenSubmission() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);

        vm.prank(builder);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.SubmissionAlreadyProven.selector, sid));
        escrow.proveSubmission(id, sid, "");
    }

    // ==================================================================
    // 5. Submission rules
    // ==================================================================

    function test_revert_submitAfterTheDeadline() public {
        uint256 id = _defaultFunded();
        uint64 submitBy = escrow.getTerms(id).submitBy;
        vm.warp(submitBy + 1);

        vm.prank(builder);
        vm.expectRevert(
            abi.encodeWithSelector(MusebookBountyEscrow.SubmissionWindowClosed.selector, submitBy, block.timestamp)
        );
        escrow.submit(id, builder, _contentHash(builder), WORK_URI, "");
    }

    function test_revert_submitToAnUnfundedBounty() public {
        uint256 id = _declare(_defaultTerms());
        vm.prank(builder);
        vm.expectRevert();
        escrow.submit(id, builder, _contentHash(builder), WORK_URI, "");
    }

    function test_revert_submitToASettledBounty() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);
        vm.prank(funder);
        escrow.release(id, sid, "");

        vm.prank(builder2);
        vm.expectRevert();
        escrow.submit(id, builder2, _contentHash(builder2), WORK_URI, "");
    }

    function test_revert_submitWithZeroPayee() public {
        uint256 id = _defaultFunded();
        vm.prank(relayer);
        vm.expectRevert(MusebookBountyEscrow.ZeroPayee.selector);
        escrow.submit(id, address(0), _contentHash(builder), WORK_URI, "");
    }

    function test_revert_withdrawSomeoneElsesSubmission() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);

        vm.prank(funder); // even the bounty owner cannot retract a builder's submission
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.NotSubmissionPayee.selector, builder, funder));
        escrow.withdrawSubmission(id, sid);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.NotSubmissionPayee.selector, builder, attacker));
        escrow.withdrawSubmission(id, sid);
    }

    // ==================================================================
    // 6. Deadline refund cannot be forced early or redirected
    // ==================================================================

    function test_revert_refundBeforeTheDeadline() public {
        uint256 id = _defaultFunded();
        uint64 submitBy = escrow.getTerms(id).submitBy;

        vm.expectRevert(
            abi.encodeWithSelector(MusebookBountyEscrow.DeadlineNotReached.selector, submitBy, block.timestamp)
        );
        escrow.refundExpired(id);

        vm.warp(submitBy); // exactly at the deadline is still too early
        vm.expectRevert(
            abi.encodeWithSelector(MusebookBountyEscrow.DeadlineNotReached.selector, submitBy, block.timestamp)
        );
        escrow.refundExpired(id);
    }

    /// @dev The work-theft vector, closed: an owner cannot take delivery of proven
    /// work and then reclaim the escrow by waiting.
    function test_revert_ownerCannotRefundAroundAProvenSubmission() public {
        uint256 id = _defaultFunded();
        _submitSelf(id, builder);
        vm.warp(escrow.getTerms(id).reviewBy + 30 days);

        vm.prank(funder);
        vm.expectRevert(MusebookBountyEscrow.ProvenSubmissionExists.selector);
        escrow.refundExpired(id);

        // Waiting only makes the builder's permissionless release available.
        escrow.releaseAfterReview(id);
        assertEq(builder.balance, 10 ether + AMOUNT);
    }

    function test_revert_refundTwice() public {
        uint256 id = _defaultFunded();
        vm.warp(escrow.getTerms(id).submitBy + 1);
        escrow.refundExpired(id);

        vm.expectRevert();
        escrow.refundExpired(id);
        assertEq(address(escrow).balance, 0);
    }

    function test_refundCannotBeRedirectedByAnybody() public {
        uint256 id = _defaultFunded();
        vm.warp(escrow.getTerms(id).submitBy + 1);

        uint256 funderBefore = funder.balance;
        vm.prank(attacker);
        escrow.refundExpired(id);

        assertEq(funder.balance, funderBefore + AMOUNT, "the funder, and only the funder");
        assertEq(attacker.balance, 100 ether);
    }

    // ==================================================================
    // 7. Post-review release cannot be rushed or aimed
    // ==================================================================

    function test_revert_permissionlessReleaseBeforeTheWindowExpires() public {
        uint256 id = _defaultFunded();
        _submitSelf(id, builder);
        uint64 reviewBy = escrow.getTerms(id).reviewBy;

        vm.expectRevert(
            abi.encodeWithSelector(MusebookBountyEscrow.DeadlineNotReached.selector, reviewBy, block.timestamp)
        );
        escrow.releaseAfterReview(id);

        vm.warp(reviewBy);
        vm.expectRevert(
            abi.encodeWithSelector(MusebookBountyEscrow.DeadlineNotReached.selector, reviewBy, block.timestamp)
        );
        escrow.releaseAfterReview(id);
    }

    /// @dev The caller picks the timing and nothing else: the payee is fixed by the
    /// contract as the earliest proven submission, so a caller cannot aim the money.
    function test_permissionlessReleaseCallerCannotChooseThePayee() public {
        uint256 id = _defaultFunded();
        _submitSelf(id, builder); // index 0
        _submitSelf(id, attacker); // index 1

        vm.warp(escrow.getTerms(id).reviewBy + 1);
        vm.prank(attacker);
        escrow.releaseAfterReview(id);

        assertEq(builder.balance, 10 ether + AMOUNT);
        assertEq(attacker.balance, 100 ether, "calling it does not aim it");
    }

    function test_revert_permissionlessReleaseTwice() public {
        uint256 id = _defaultFunded();
        _submitSelf(id, builder);
        vm.warp(escrow.getTerms(id).reviewBy + 1);

        escrow.releaseAfterReview(id);
        vm.expectRevert();
        escrow.releaseAfterReview(id);
    }

    // ==================================================================
    // 8. Dispute bounds, it does not veto
    // ==================================================================

    function test_revert_disputeByNonHolder() public {
        uint256 id = _declareAndFund(_terms(funder, address(0), AMOUNT, arbiter));
        uint256 sid = _submitSelf(id, builder);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.NotBountyOwner.selector, funder, attacker));
        escrow.dispute(id, sid);
    }

    function test_revert_disputeTwiceToExtendForever() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);

        vm.prank(funder);
        escrow.dispute(id, sid);
        uint64 deadlineAfterFirst = escrow.reviewDeadline(id);

        vm.prank(funder);
        vm.expectRevert(MusebookBountyEscrow.AlreadyDisputed.selector);
        escrow.dispute(id, sid);

        assertEq(escrow.reviewDeadline(id), deadlineAfterFirst, "one extension, and only one");
    }

    function test_revert_disputeAfterTheReviewWindowClosed() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);
        uint64 reviewBy = escrow.getTerms(id).reviewBy;
        vm.warp(reviewBy + 1);

        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(MusebookBountyEscrow.ReviewWindowClosed.selector, reviewBy, block.timestamp)
        );
        escrow.dispute(id, sid);
    }

    function test_disputeMovesNoMoney() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);

        vm.prank(funder);
        escrow.dispute(id, sid);

        assertEq(address(escrow).balance, AMOUNT);
        assertEq(uint8(escrow.getBounty(id).status), uint8(MusebookBountyEscrow.Status.Funded));
    }

    // ==================================================================
    // 9. The arbiter is bounded, and is nobody by default
    // ==================================================================

    function test_revert_arbitrateWhenNoArbiterWasNamed() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);
        vm.prank(funder);
        escrow.dispute(id, sid);

        address[3] memory tryThese = [arbiter, deployer, attacker];
        for (uint256 i; i < tryThese.length; ++i) {
            vm.prank(tryThese[i]);
            vm.expectRevert(MusebookBountyEscrow.NoArbiter.selector);
            escrow.arbitrate(id, true, sid);
        }
    }

    function test_revert_arbitrateByNonArbiter() public {
        uint256 id = _declareAndFund(_terms(funder, address(0), AMOUNT, arbiter));
        uint256 sid = _submitSelf(id, builder);
        vm.prank(funder);
        escrow.dispute(id, sid);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.NotArbiter.selector, arbiter, attacker));
        escrow.arbitrate(id, true, sid);

        // Not even the bounty owner can act as its own arbiter.
        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(MusebookBountyEscrow.NotArbiter.selector, arbiter, funder));
        escrow.arbitrate(id, false, 0);
    }

    function test_revert_arbitrateWithoutAnOpenDispute() public {
        uint256 id = _declareAndFund(_terms(funder, address(0), AMOUNT, arbiter));
        uint256 sid = _submitSelf(id, builder);

        vm.prank(arbiter);
        vm.expectRevert(MusebookBountyEscrow.NotDisputed.selector);
        escrow.arbitrate(id, true, sid);
    }

    function test_revert_arbitrateAfterTheExtensionExpires() public {
        uint256 id = _declareAndFund(_terms(funder, address(0), AMOUNT, arbiter));
        uint256 sid = _submitSelf(id, builder);
        vm.prank(funder);
        escrow.dispute(id, sid);

        uint64 deadline = escrow.reviewDeadline(id);
        vm.warp(deadline + 1);
        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(MusebookBountyEscrow.ReviewWindowClosed.selector, deadline, block.timestamp)
        );
        escrow.arbitrate(id, true, sid);
    }

    /// @dev The arbiter has two choices, not a destination field. It cannot pay
    /// itself unless it is a publicly recorded, proven submitter on that bounty.
    function test_arbiterCannotNameItsOwnDestination() public {
        uint256 id = _declareAndFund(_terms(funder, address(0), AMOUNT, arbiter));
        uint256 sid = _submitSelf(id, builder);
        vm.prank(funder);
        escrow.dispute(id, sid);

        uint256 arbiterBefore = arbiter.balance;
        vm.prank(arbiter);
        escrow.arbitrate(id, true, sid);

        assertEq(builder.balance, 10 ether + AMOUNT);
        assertEq(arbiter.balance, arbiterBefore, "the arbiter routes, it never receives");
    }

    function test_arbiterOnOneBountyHasNoPowerOverAnother() public {
        uint256 idA = _declareAndFund(_terms(funder, address(0), AMOUNT, arbiter));
        uint256 idB = _defaultFunded();
        uint256 sidA = _submitSelf(idA, builder);
        uint256 sidB = _submitSelf(idB, builder);

        vm.prank(funder);
        escrow.dispute(idA, sidA);
        vm.prank(funder);
        escrow.dispute(idB, sidB);

        vm.prank(arbiter);
        vm.expectRevert(MusebookBountyEscrow.NoArbiter.selector);
        escrow.arbitrate(idB, true, sidB);
    }

    // ==================================================================
    // 10. Soulbound: the release right cannot be sold, taken, or phished
    // ==================================================================

    function test_revert_transferOwnershipToken() public {
        uint256 id = _defaultFunded();

        vm.prank(funder);
        vm.expectRevert(MusebookBountyEscrow.Soulbound.selector);
        escrow.transferFrom(funder, attacker, id);

        vm.prank(funder);
        vm.expectRevert(MusebookBountyEscrow.Soulbound.selector);
        escrow.safeTransferFrom(funder, attacker, id);

        assertEq(escrow.ownerOf(id), funder);
    }

    function test_revert_approvalsAreBlockedSoPhishingCannotTakeTheToken() public {
        uint256 id = _defaultFunded();

        vm.prank(funder);
        vm.expectRevert(MusebookBountyEscrow.Soulbound.selector);
        escrow.approve(attacker, id);

        vm.prank(funder);
        vm.expectRevert(MusebookBountyEscrow.Soulbound.selector);
        escrow.setApprovalForAll(attacker, true);

        assertEq(escrow.getApproved(id), address(0));
        assertFalse(escrow.isApprovedForAll(funder, attacker));
    }

    // ==================================================================
    // 11. Reentrancy
    // ==================================================================

    function test_reentrantPayeeCannotDoublePay() public {
        uint256 id = _defaultFunded();
        MaliciousPayee payee = new MaliciousPayee(escrow);
        vm.deal(address(payee), 1 ether);

        vm.prank(address(payee));
        uint256 sid = payee.doSubmit(id, keccak256("evil"), WORK_URI);

        // On being paid, re-enter release for the same bounty and swallow the revert.
        payee.setMode(
            MaliciousPayee.Mode.ReenterSwallow,
            abi.encodeWithSelector(MusebookBountyEscrow.release.selector, id, sid, bytes(""))
        );

        vm.prank(funder);
        escrow.release(id, sid, "");

        assertTrue(payee.reentryAttempted(), "the attack ran");
        assertFalse(payee.reentrySucceeded(), "and was rejected");
        assertEq(address(payee).balance, 1 ether + AMOUNT, "paid exactly once");
        assertEq(address(escrow).balance, 0);
    }

    function test_reentrantPayeeCannotDrainAnotherBounty() public {
        uint256 victim = _defaultFunded();
        uint256 target = _defaultFunded();
        vm.warp(escrow.getTerms(victim).submitBy + 1);

        MaliciousPayee payee = new MaliciousPayee(escrow);
        vm.deal(address(payee), 1 ether);

        // Re-enter the deadline refund of a different, ripe bounty mid-payout.
        payee.setMode(
            MaliciousPayee.Mode.ReenterSwallow,
            abi.encodeWithSelector(MusebookBountyEscrow.refundExpired.selector, target)
        );

        // The victim bounty's own refund pays the funder, not the attacker, so build
        // the scenario where the attacker is the payee of a settling bounty instead.
        uint256 live = _defaultFunded();
        vm.prank(address(payee));
        uint256 sid = payee.doSubmit(live, keccak256("evil"), WORK_URI);

        vm.prank(funder);
        escrow.release(live, sid, "");

        assertTrue(payee.reentryAttempted());
        assertEq(address(payee).balance, 1 ether + AMOUNT, "no extra bounty was drained");
        assertEq(escrow.getBounty(target).escrow, AMOUNT, "the target bounty is untouched");
    }

    function test_reentrantPayeeThatRevertsGetsADeferredCreditAndNoMore() public {
        uint256 id = _defaultFunded();
        MaliciousPayee payee = new MaliciousPayee(escrow);

        vm.prank(address(payee));
        uint256 sid = payee.doSubmit(id, keccak256("evil"), WORK_URI);

        payee.setMode(
            MaliciousPayee.Mode.Reenter,
            abi.encodeWithSelector(MusebookBountyEscrow.release.selector, id, sid, bytes(""))
        );

        vm.prank(funder);
        escrow.release(id, sid, "");

        // The push failed, so the escrow became a credit rather than stranding.
        assertEq(address(payee).balance, 0);
        assertEq(escrow.credits(address(0), address(payee)), AMOUNT);
        assertEq(escrow.accounted(address(0)), AMOUNT);

        // Collecting it is the only thing left, and it works exactly once.
        payee.setMode(MaliciousPayee.Mode.Accept, "");
        payee.doWithdraw(address(0));
        assertEq(address(payee).balance, AMOUNT);

        vm.expectRevert(MusebookBountyEscrow.NothingToWithdraw.selector);
        payee.doWithdraw(address(0));
    }

    function test_rejectingPayeeCannotStrandTheEscrow() public {
        uint256 id = _defaultFunded();
        MaliciousPayee payee = new MaliciousPayee(escrow);
        payee.setMode(MaliciousPayee.Mode.Reject, "");

        vm.prank(address(payee));
        uint256 sid = payee.doSubmit(id, keccak256("stubborn"), WORK_URI);

        vm.prank(funder);
        escrow.release(id, sid, ""); // settles regardless

        assertEq(uint8(escrow.getBounty(id).status), uint8(MusebookBountyEscrow.Status.Settled));
        assertEq(escrow.credits(address(0), address(payee)), AMOUNT);

        payee.setMode(MaliciousPayee.Mode.Accept, "");
        payee.doWithdraw(address(0));
        assertEq(address(payee).balance, AMOUNT);
    }

    function test_reentrantErc20CannotReenterFunding() public {
        ReentrantERC20 evil = new ReentrantERC20();
        uint256 id = _declareAndFund(_terms(funder, address(evil), 1000e18, address(0)));
        uint256 sid = _submitSelf(id, builder);

        evil.arm(escrow, abi.encodeWithSelector(MusebookBountyEscrow.release.selector, id, sid, bytes("")));

        vm.prank(funder);
        escrow.release(id, sid, ""); // the helper asserts the reentrant call failed

        assertEq(evil.balanceOf(builder), 1000e18, "paid exactly once");
        assertEq(evil.balanceOf(address(escrow)), 0);
    }

    // ==================================================================
    // 12. There is nobody to be, and nothing to call
    // ==================================================================

    /// @dev If any of these existed the whole design would be a lie. They do not,
    /// so every call lands on the fallback path and reverts.
    function test_noAdminSurfaceExists() public {
        string[12] memory forbidden = [
            "owner()",
            "transferOwnership(address)",
            "renounceOwnership()",
            "pause()",
            "unpause()",
            "upgradeTo(address)",
            "upgradeToAndCall(address,bytes)",
            "sweep(address)",
            "rescue(address,uint256)",
            "setBaseURI(string)",
            "kill()",
            "emergencyWithdraw()"
        ];

        for (uint256 i; i < forbidden.length; ++i) {
            vm.prank(deployer);
            (bool ok,) = address(escrow).call(abi.encodeWithSignature(forbidden[i]));
            assertFalse(ok, forbidden[i]);
        }
    }

    function test_deployerIsJustAnotherAddress() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);

        vm.startPrank(deployer);
        vm.expectRevert();
        escrow.release(id, sid, "");
        vm.expectRevert();
        escrow.refundExpired(id);
        vm.expectRevert();
        escrow.releaseAfterReview(id);
        vm.expectRevert();
        escrow.arbitrate(id, true, sid);
        vm.expectRevert();
        escrow.dispute(id, sid);
        vm.expectRevert(MusebookBountyEscrow.NothingToWithdraw.selector);
        escrow.withdraw(address(0));
        vm.stopPrank();

        assertEq(address(escrow).balance, AMOUNT, "the deployer cannot touch a wei");
    }

    /// @dev Walks the deployed runtime code skipping PUSH immediates, so the scan
    /// reports real opcodes rather than constants that happen to contain the byte.
    /// The contract is immutable only if it cannot destroy itself and cannot run
    /// someone else's code in its own storage context.
    function test_runtimeCodeContainsNoSelfdestructOrDelegatecall() public view {
        bytes memory code = address(escrow).code;
        assertGt(code.length, 0);

        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            assertTrue(op != 0xff, "SELFDESTRUCT");
            assertTrue(op != 0xf4, "DELEGATECALL");
            assertTrue(op != 0xf2, "CALLCODE");
            if (op >= 0x60 && op <= 0x7f) {
                i += uint256(op) - 0x5f; // skip the PUSH immediate
            }
            i += 1;
        }
    }

    /// @dev CREATE/CREATE2 would let the contract spawn a helper that could itself
    /// selfdestruct value away. It has neither.
    function test_runtimeCodeContainsNoCreateOpcodes() public view {
        bytes memory code = address(escrow).code;
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            assertTrue(op != 0xf0, "CREATE");
            assertTrue(op != 0xf5, "CREATE2");
            if (op >= 0x60 && op <= 0x7f) {
                i += uint256(op) - 0x5f;
            }
            i += 1;
        }
    }

    // ==================================================================
    // 13. Withdraw moves no escrow
    // ==================================================================

    function test_revert_withdrawWithoutACredit() public {
        _defaultFunded();

        address[3] memory nobodies = [attacker, funder, deployer];
        for (uint256 i; i < nobodies.length; ++i) {
            vm.prank(nobodies[i]);
            vm.expectRevert(MusebookBountyEscrow.NothingToWithdraw.selector);
            escrow.withdraw(address(0));
        }
        assertEq(address(escrow).balance, AMOUNT);
    }

    function test_creditsAreNotTransferableBetweenAddresses() public {
        uint256 id = _defaultFunded();
        MaliciousPayee payee = new MaliciousPayee(escrow);
        payee.setMode(MaliciousPayee.Mode.Reject, "");

        vm.prank(address(payee));
        uint256 sid = payee.doSubmit(id, keccak256("x"), WORK_URI);
        vm.prank(funder);
        escrow.release(id, sid, "");

        // The credit belongs to the payee; nobody else can reach it.
        vm.prank(attacker);
        vm.expectRevert(MusebookBountyEscrow.NothingToWithdraw.selector);
        escrow.withdraw(address(0));
        assertEq(escrow.credits(address(0), address(payee)), AMOUNT);
    }
}

/// @notice Known hazards: behaviour that is deliberate under the agreed design but
/// is a real economic risk, asserted here so it is documented and monitored rather
/// than discovered. These tests pass because the contract does what it was asked
/// to do — they exist to pin the consequence, not to claim it is harmless.
contract KnownHazardTest is BaseTest {
    address internal griefer = makeAddr("griefer");

    function setUp() public override {
        super.setUp();
        vm.deal(griefer, 10 ether);
    }

    /// @dev A junk submission captures an unattended bounty that named no arbiter.
    /// Once any proven submission exists the deadline refund is closed, and the
    /// owner's only remedies are to release to a better submission or to have named
    /// an arbiter at creation. An owner who does neither loses the escrow to
    /// whoever registered first. This is the cost of making owner silence pay the
    /// builder, and it is why the board must push arbiters above a threshold.
    function test_hazard_junkSubmissionCapturesAnUnattendedBountyWithNoArbiter() public {
        uint256 id = _defaultFunded();
        _submitSelf(id, griefer);

        // The refund is already unreachable, and no dispute reopens it.
        vm.warp(escrow.getTerms(id).submitBy + 1);
        vm.prank(funder);
        vm.expectRevert(MusebookBountyEscrow.ProvenSubmissionExists.selector);
        escrow.refundExpired(id);

        vm.warp(escrow.getTerms(id).reviewBy + escrow.DISPUTE_EXTENSION() + 1);
        escrow.releaseAfterReview(id);
        assertEq(griefer.balance, 10 ether + AMOUNT, "the hazard is real and this is its shape");
    }

    /// @dev The mitigation inside the contract: an owner who named an arbiter can
    /// dispute and have the escrow returned, so the exposure is opt-out at creation.
    function test_hazard_isMitigatedByNamingAnArbiterAtCreation() public {
        uint256 id = _declareAndFund(_terms(funder, address(0), AMOUNT, arbiter));
        uint256 sid = _submitSelf(id, griefer);

        vm.prank(funder);
        escrow.dispute(id, sid);

        uint256 before = funder.balance;
        vm.prank(arbiter);
        escrow.arbitrate(id, false, 0);

        assertEq(funder.balance, before + AMOUNT, "a named arbiter can refuse junk");
        assertEq(griefer.balance, 10 ether);
    }

    /// @dev An attentive owner is never exposed: the junk submission is simply not
    /// the one released. Attention inside the review window is the primary defence.
    function test_hazard_attentiveOwnerIsUnaffected() public {
        uint256 id = _defaultFunded();
        _submitSelf(id, griefer); // index 0, would win by default
        uint256 good = _submitSelf(id, builder); // index 1, the real work

        vm.prank(funder);
        escrow.release(id, good, "");

        assertEq(builder.balance, 10 ether + AMOUNT);
        assertEq(griefer.balance, 10 ether, "registering first buys nothing against an owner who looks");
    }

    /// @dev The funder can always recover its own escrow early by submitting from a
    /// second address it controls and releasing to it. No contract can prevent this,
    /// because the chain cannot tell two addresses apart by who is behind them. What
    /// it costs is a permanent public receipt naming a submission and its content
    /// hash, which is the only deterrent available.
    function test_hazard_funderCanSelfReleaseThroughASecondAddress() public {
        uint256 id = _defaultFunded();
        address funderSecondWallet = makeAddr("funderSecondWallet");
        vm.deal(funderSecondWallet, 1 ether);

        uint256 sid = _submitSelf(id, funderSecondWallet);
        vm.prank(funder);
        escrow.release(id, sid, "");

        assertEq(funderSecondWallet.balance, 1 ether + AMOUNT);
        // The receipt exists and is immutable: a settlement naming a submission.
        assertEq(uint8(escrow.getBounty(id).settlement), uint8(MusebookBountyEscrow.Settlement.OwnerRelease));
        assertEq(escrow.getSubmission(id, sid).payee, funderSecondWallet);
    }
}
