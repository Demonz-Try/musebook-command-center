// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {MusebookBountyEscrow} from "../src/MusebookBountyEscrow.sol";
import {MockERC20} from "./Helpers.sol";

/// @notice Every legitimate way escrow can move, end to end, plus the declaration
/// and submission rules that make those paths meaningful.
contract LifecycleTest is BaseTest {
    // ------------------------------------------------------------------
    // Declaration — relayable, mints nothing, holds nothing
    // ------------------------------------------------------------------

    function test_declare_isRelayable_andHoldsNothing() public {
        uint256 id = _declare(_defaultTerms());

        MusebookBountyEscrow.Bounty memory b = escrow.getBounty(id);
        assertEq(uint8(b.status), uint8(MusebookBountyEscrow.Status.Declared));
        assertEq(b.escrow, 0);
        assertEq(address(escrow).balance, 0, "declaration must hold no value");
        assertEq(escrow.accounted(address(0)), 0);

        // Before funding there is nothing to own.
        vm.expectRevert();
        escrow.ownerOf(id);
    }

    function test_declare_recordsTermsVerbatim() public {
        MusebookBountyEscrow.Terms memory t = _terms(funder, address(0), AMOUNT, arbiter);
        MusebookBountyEscrow.Terms memory stored = escrow.getTerms(_declare(t));

        assertEq(stored.funder, t.funder);
        assertEq(stored.token, t.token);
        assertEq(stored.amount, t.amount);
        assertEq(stored.arbiter, t.arbiter);
        assertEq(stored.fundBy, t.fundBy);
        assertEq(stored.submitBy, t.submitBy);
        assertEq(stored.reviewBy, t.reviewBy);
        assertEq(stored.termsHash, TERMS_HASH);
    }

    function test_declare_idsAreSequential() public {
        assertEq(escrow.nextBountyId(), 1);
        assertEq(_declare(_defaultTerms()), 1);
        assertEq(_declare(_defaultTerms()), 2);
        assertEq(escrow.nextBountyId(), 3);
    }

    // ------------------------------------------------------------------
    // Funding — the declared address is proven, not trusted
    // ------------------------------------------------------------------

    function test_fund_byDeclaredAddress_mintsOwnershipToken() public {
        uint256 id = _declare(_defaultTerms());

        vm.expectEmit(true, true, false, true, address(escrow));
        emit MusebookBountyEscrow.BountyFunded(id, funder, address(0), AMOUNT);
        vm.prank(funder);
        escrow.fund{value: AMOUNT}(id);

        assertEq(escrow.ownerOf(id), funder, "the token goes to the address that actually paid");
        assertEq(escrow.balanceOf(funder), 1);
        assertEq(address(escrow).balance, AMOUNT);
        assertEq(escrow.accounted(address(0)), AMOUNT);
        assertEq(escrow.getBounty(id).escrow, AMOUNT);
        assertEq(uint8(escrow.getBounty(id).status), uint8(MusebookBountyEscrow.Status.Funded));
    }

    function test_fund_erc20_pullsExactAmount() public {
        uint256 id = _declareAndFund(_terms(funder, address(token), 1000e18, address(0)));

        assertEq(token.balanceOf(address(escrow)), 1000e18);
        assertEq(escrow.accounted(address(token)), 1000e18);
        assertEq(escrow.ownerOf(id), funder);
        assertEq(address(escrow).balance, 0, "an erc20 bounty holds no native value");
    }

    function test_tokenURI_isFullyOnChain() public {
        string memory uri = escrow.tokenURI(_defaultFunded());
        assertGt(bytes(uri).length, 100);
        assertTrue(_startsWith(uri, "data:application/json"), "no off-chain host to trust or lose");
    }

    // ------------------------------------------------------------------
    // Submission — three proof states, only two of them payable
    // ------------------------------------------------------------------

    function test_submit_selfRegistered_isProvenByControl() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);

        MusebookBountyEscrow.Submission memory s = escrow.getSubmission(id, sid);
        assertEq(s.payee, builder);
        assertEq(uint8(s.proof), uint8(MusebookBountyEscrow.Proof.SelfRegistered));
        assertEq(escrow.getBounty(id).provenActive, 1);
        assertEq(escrow.getBounty(id).firstProven, 0);
    }

    function test_submit_signed_isProvenAndCostsTheBuilderNothing() public {
        uint256 id = _defaultFunded();
        uint256 builderBalanceBefore = builder.balance;

        uint256 sid = _submitSigned(id, builder, builderPk);

        MusebookBountyEscrow.Submission memory s = escrow.getSubmission(id, sid);
        assertEq(s.payee, builder);
        assertEq(uint8(s.proof), uint8(MusebookBountyEscrow.Proof.Signed));
        assertEq(escrow.getBounty(id).provenActive, 1);
        assertEq(builder.balance, builderBalanceBefore, "the builder spent no gas");
    }

    function test_submit_declared_isRecordedButNotProven() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitDeclared(id, builder);

        MusebookBountyEscrow.Submission memory s = escrow.getSubmission(id, sid);
        assertEq(s.payee, builder, "the evidence trail is intact");
        assertEq(s.contentHash, _contentHash(builder));
        assertEq(s.uri, WORK_URI);
        assertEq(uint8(s.proof), uint8(MusebookBountyEscrow.Proof.Declared));
        assertEq(escrow.getBounty(id).provenActive, 0, "an unproven submission arms nothing");
    }

    function test_proveSubmission_upgradesDeclaredToProven_byAnyone() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitDeclared(id, builder);

        bytes memory sig = _signStatement(id, builder, _contentHash(builder), WORK_URI, builderPk);
        vm.prank(stranger); // permissionless: anyone may carry the builder's signature
        escrow.proveSubmission(id, sid, sig);

        assertEq(uint8(escrow.getSubmission(id, sid).proof), uint8(MusebookBountyEscrow.Proof.Signed));
        assertEq(escrow.getBounty(id).provenActive, 1);
    }

    function test_proveSubmission_byPayeeWithEmptySignature() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitDeclared(id, builder);

        vm.prank(builder);
        escrow.proveSubmission(id, sid, "");

        assertEq(uint8(escrow.getSubmission(id, sid).proof), uint8(MusebookBountyEscrow.Proof.SelfRegistered));
    }

    function test_submissions_areAppendOnly() public {
        uint256 id = _defaultFunded();
        assertEq(_submitSelf(id, builder), 0);
        assertEq(_submitSelf(id, builder2), 1);
        assertEq(_submitDeclared(id, stranger), 2);

        assertEq(escrow.getSubmission(id, 0).payee, builder);
        assertEq(escrow.getSubmission(id, 1).payee, builder2);
        assertEq(escrow.getSubmissions(id).length, 3);
        assertEq(escrow.getBounty(id).firstProven, 0);
    }

    // ------------------------------------------------------------------
    // (a) Owner agree
    // ------------------------------------------------------------------

    function test_release_paysTheSelectedSubmission() public {
        uint256 id = _defaultFunded();
        _submitSelf(id, builder);
        uint256 sid2 = _submitSelf(id, builder2);

        uint256 before1 = builder.balance;
        uint256 before2 = builder2.balance;

        vm.prank(funder);
        escrow.release(id, sid2, "");

        assertEq(builder2.balance, before2 + AMOUNT, "the approved submission is paid");
        assertEq(builder.balance, before1, "the other one is not");
        assertEq(address(escrow).balance, 0);
        assertEq(escrow.accounted(address(0)), 0);

        MusebookBountyEscrow.Bounty memory b = escrow.getBounty(id);
        assertEq(uint8(b.status), uint8(MusebookBountyEscrow.Status.Settled));
        assertEq(uint8(b.settlement), uint8(MusebookBountyEscrow.Settlement.OwnerRelease));
        assertEq(b.escrow, 0);
    }

    function test_release_bindsToSubmissionIdNotLatest() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);
        _submitSelf(id, builder2); // a late submission arrives after the owner decided

        vm.prank(funder);
        escrow.release(id, sid, "");

        assertEq(builder.balance, 10 ether + AMOUNT);
        assertEq(builder2.balance, 10 ether, "a later submission cannot hijack the release");
    }

    function test_release_canProveAndPayInOneTransaction() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitDeclared(id, builder);
        bytes memory sig = _signStatement(id, builder, _contentHash(builder), WORK_URI, builderPk);

        vm.prank(funder);
        escrow.release(id, sid, sig);

        assertEq(builder.balance, 10 ether + AMOUNT);
    }

    function test_release_erc20() public {
        uint256 id = _declareAndFund(_terms(funder, address(token), 1000e18, address(0)));
        uint256 sid = _submitSelf(id, builder);

        vm.prank(funder);
        escrow.release(id, sid, "");

        assertEq(token.balanceOf(builder), 1000e18);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.accounted(address(token)), 0);
    }

    function test_release_stillWorksAfterTheSubmissionDeadline() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);

        vm.warp(escrow.getTerms(id).reviewBy);
        vm.prank(funder);
        escrow.release(id, sid, "");

        assertEq(builder.balance, 10 ether + AMOUNT);
    }

    // ------------------------------------------------------------------
    // (b) Permissionless post-review release
    // ------------------------------------------------------------------

    function test_releaseAfterReview_isPermissionless_andPaysTheBuilder() public {
        uint256 id = _defaultFunded();
        _submitSelf(id, builder);

        vm.warp(escrow.getTerms(id).reviewBy + 1);
        uint256 funderBefore = funder.balance;

        // A complete stranger triggers it. That is the point: nothing runs on a
        // timer, so anyone may push the button, and the button has one outcome.
        vm.prank(stranger);
        escrow.releaseAfterReview(id);

        assertEq(builder.balance, 10 ether + AMOUNT, "owner silence pays the builder");
        assertEq(funder.balance, funderBefore, "silence is not profitable for the owner");
        assertEq(stranger.balance, 10 ether, "the caller gets nothing for calling");
        assertEq(uint8(escrow.getBounty(id).settlement), uint8(MusebookBountyEscrow.Settlement.PostReviewRelease));
    }

    function test_releaseAfterReview_paysEarliestProvenSubmission() public {
        uint256 id = _defaultFunded();
        _submitDeclared(id, stranger); // index 0, never proven, never payable
        _submitSelf(id, builder); // index 1, the earliest proven
        _submitSelf(id, builder2); // index 2

        vm.warp(escrow.getTerms(id).reviewBy + 1);
        escrow.releaseAfterReview(id);

        assertEq(builder.balance, 10 ether + AMOUNT);
        assertEq(builder2.balance, 10 ether);
        assertEq(stranger.balance, 10 ether);
    }

    function test_releaseAfterReview_waitsOutTheDisputeExtension() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);

        vm.prank(funder);
        escrow.dispute(id, sid);

        uint64 reviewBy = escrow.getTerms(id).reviewBy;
        assertEq(escrow.reviewDeadline(id), reviewBy + escrow.DISPUTE_EXTENSION());

        vm.warp(reviewBy + 1);
        vm.expectRevert();
        escrow.releaseAfterReview(id);

        // The council votes inside the extension; the contract settles when it ends.
        vm.warp(reviewBy + escrow.DISPUTE_EXTENSION() + 1);
        escrow.releaseAfterReview(id);
        assertEq(builder.balance, 10 ether + AMOUNT, "a dispute bounds the delay, it does not veto");
    }

    function test_withdrawSubmission_returnsBountyToTheRefundPath() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);

        vm.warp(escrow.getTerms(id).submitBy + 1);
        vm.expectRevert(MusebookBountyEscrow.ProvenSubmissionExists.selector);
        escrow.refundExpired(id);

        vm.prank(builder);
        escrow.withdrawSubmission(id, sid);
        assertEq(escrow.getBounty(id).provenActive, 0);

        uint256 before = funder.balance;
        escrow.refundExpired(id);
        assertEq(funder.balance, before + AMOUNT, "a conceding builder unlocks the refund");
    }

    function test_withdrawSubmission_advancesFirstProvenPointer() public {
        uint256 id = _defaultFunded();
        uint256 sid = _submitSelf(id, builder);
        _submitSelf(id, builder2);

        vm.prank(builder);
        escrow.withdrawSubmission(id, sid);
        assertEq(escrow.getBounty(id).firstProven, 1);

        vm.warp(escrow.getTerms(id).reviewBy + 1);
        escrow.releaseAfterReview(id);
        assertEq(builder2.balance, 10 ether + AMOUNT);
        assertEq(builder.balance, 10 ether);
    }

    // ------------------------------------------------------------------
    // (c) Deadline refund
    // ------------------------------------------------------------------

    function test_refundExpired_isPermissionless_andPaysOnlyTheFunder() public {
        uint256 id = _defaultFunded();
        vm.warp(escrow.getTerms(id).submitBy + 1);

        uint256 before = funder.balance;
        vm.prank(stranger);
        escrow.refundExpired(id);

        assertEq(funder.balance, before + AMOUNT);
        assertEq(stranger.balance, 10 ether, "the caller gets nothing");
        assertEq(address(escrow).balance, 0);
        assertEq(uint8(escrow.getBounty(id).settlement), uint8(MusebookBountyEscrow.Settlement.DeadlineRefund));
    }

    function test_refundExpired_unaffectedByUnprovenSubmissions() public {
        uint256 id = _defaultFunded();
        _submitDeclared(id, builder);

        vm.warp(escrow.getTerms(id).submitBy + 1);
        uint256 before = funder.balance;
        escrow.refundExpired(id);

        assertEq(funder.balance, before + AMOUNT, "only a proven submission blocks the refund");
    }

    function test_unfundedBountyPastFundingWindowIsAPermanentNoOp() public {
        uint256 id = _declare(_defaultTerms());
        vm.warp(escrow.getTerms(id).fundBy + 1);

        vm.prank(funder);
        vm.expectRevert();
        escrow.fund{value: AMOUNT}(id);

        // Nothing to refund, nothing to clean up, nobody to trust. The remedy for a
        // mistyped funder address is to declare a new bounty.
        assertEq(address(escrow).balance, 0);
        assertEq(uint8(escrow.getBounty(id).status), uint8(MusebookBountyEscrow.Status.Declared));
        assertEq(escrow.getBounty(id).escrow, 0);
    }

    // ------------------------------------------------------------------
    // (d) Optional per-bounty arbiter
    // ------------------------------------------------------------------

    function test_arbitrate_payBuilder() public {
        uint256 id = _declareAndFund(_terms(funder, address(0), AMOUNT, arbiter));
        uint256 sid = _submitSelf(id, builder);
        vm.prank(funder);
        escrow.dispute(id, sid);

        vm.prank(arbiter);
        escrow.arbitrate(id, true, sid);

        assertEq(builder.balance, 10 ether + AMOUNT);
        assertEq(uint8(escrow.getBounty(id).settlement), uint8(MusebookBountyEscrow.Settlement.ArbiterPay));
    }

    function test_arbitrate_refundFunder() public {
        uint256 id = _declareAndFund(_terms(funder, address(0), AMOUNT, arbiter));
        uint256 sid = _submitSelf(id, builder);
        vm.prank(funder);
        escrow.dispute(id, sid);

        uint256 before = funder.balance;
        vm.prank(arbiter);
        escrow.arbitrate(id, false, 0);

        assertEq(funder.balance, before + AMOUNT);
        assertEq(builder.balance, 10 ether);
        assertEq(uint8(escrow.getBounty(id).settlement), uint8(MusebookBountyEscrow.Settlement.ArbiterRefund));
    }

    function test_arbitrate_silentArbiterYieldsToPermissionlessRelease() public {
        uint256 id = _declareAndFund(_terms(funder, address(0), AMOUNT, arbiter));
        uint256 sid = _submitSelf(id, builder);
        vm.prank(funder);
        escrow.dispute(id, sid);

        vm.warp(escrow.reviewDeadline(id) + 1);
        vm.prank(arbiter);
        vm.expectRevert(); // the arbiter's window has closed
        escrow.arbitrate(id, false, 0);

        escrow.releaseAfterReview(id);
        assertEq(builder.balance, 10 ether + AMOUNT, "an absent arbiter cannot strand the escrow");
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _startsWith(string memory haystack, string memory needle) private pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (h.length < n.length) return false;
        for (uint256 i; i < n.length; ++i) {
            if (h[i] != n[i]) return false;
        }
        return true;
    }
}
