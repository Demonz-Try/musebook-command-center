// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MusebookBountyEscrow} from "../src/MusebookBountyEscrow.sol";
import {MockERC20} from "./Helpers.sol";

/// @dev Shared fixture. Every test starts from a realistic clock so deadline
/// arithmetic is never accidentally satisfied by `block.timestamp == 1`.
abstract contract BaseTest is Test {
    MusebookBountyEscrow internal escrow;
    MockERC20 internal token;

    address internal deployer = makeAddr("deployer");
    address internal relayer = makeAddr("relayer"); // the site, relaying declarations
    address internal arbiter = makeAddr("arbiter"); // the optional per-bounty escape
    address internal stranger = makeAddr("stranger");

    // The funder and builders need known private keys so tests can sign statements
    // the way a real builder would. These are Foundry test keys and exist only in
    // this process; nothing is ever deployed or funded with them.
    uint256 internal funderPk = 0xF00D;
    uint256 internal builderPk = 0xB01;
    uint256 internal builder2Pk = 0xB02;
    address internal funder;
    address internal builder;
    address internal builder2;

    uint256 internal constant AMOUNT = 0.005 ether;
    uint64 internal constant FUND_WINDOW = 1 days;
    uint64 internal constant SUBMIT_WINDOW = 7 days;
    uint64 internal constant REVIEW_WINDOW = 3 days;

    bytes32 internal constant TERMS_HASH = keccak256("recipe site | functional, tabs with subsections");
    string internal constant WORK_URI = "https://example.invalid/work";

    function setUp() public virtual {
        funder = vm.addr(funderPk);
        builder = vm.addr(builderPk);
        builder2 = vm.addr(builder2Pk);

        vm.warp(1_756_000_000);
        vm.prank(deployer);
        escrow = new MusebookBountyEscrow();
        token = new MockERC20();

        vm.deal(funder, 100 ether);
        vm.deal(builder, 10 ether);
        vm.deal(builder2, 10 ether);
        vm.deal(stranger, 10 ether);
        vm.deal(arbiter, 10 ether);
        vm.deal(relayer, 10 ether);
    }

    // ---- terms builders -------------------------------------------------

    function _terms(address funder_, address token_, uint256 amount_, address arbiter_)
        internal
        view
        returns (MusebookBountyEscrow.Terms memory t)
    {
        uint64 fundBy = uint64(block.timestamp) + FUND_WINDOW;
        uint64 submitBy = fundBy + SUBMIT_WINDOW;
        t = MusebookBountyEscrow.Terms({
            funder: funder_,
            token: token_,
            amount: amount_,
            arbiter: arbiter_,
            fundBy: fundBy,
            submitBy: submitBy,
            reviewBy: submitBy + REVIEW_WINDOW,
            termsHash: TERMS_HASH
        });
    }

    function _defaultTerms() internal view returns (MusebookBountyEscrow.Terms memory) {
        return _terms(funder, address(0), AMOUNT, address(0));
    }

    // ---- lifecycle shortcuts --------------------------------------------

    function _declare(MusebookBountyEscrow.Terms memory t) internal returns (uint256 id) {
        vm.prank(relayer);
        id = escrow.declareBounty(t, "musebook:thread/20102");
    }

    function _declareAndFund(MusebookBountyEscrow.Terms memory t) internal returns (uint256 id) {
        id = _declare(t);
        if (t.token == address(0)) {
            vm.prank(t.funder);
            escrow.fund{value: t.amount}(id);
        } else {
            MockERC20(t.token).mint(t.funder, t.amount);
            vm.startPrank(t.funder);
            MockERC20(t.token).approve(address(escrow), t.amount);
            escrow.fund(id);
            vm.stopPrank();
        }
    }

    function _defaultFunded() internal returns (uint256 id) {
        id = _declareAndFund(_defaultTerms());
    }

    // ---- submissions ----------------------------------------------------

    function _contentHash(address who) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("content", who));
    }

    /// @dev Self-registered: the payout address sends the transaction, proving control.
    function _submitSelf(uint256 id, address who) internal returns (uint256 sid) {
        vm.prank(who);
        sid = escrow.submit(id, who, _contentHash(who), WORK_URI, "");
    }

    /// @dev Relayed with a signature: the builder pays nothing, the relayer pays gas.
    function _submitSigned(uint256 id, address who, uint256 pk) internal returns (uint256 sid) {
        bytes memory sig = _signStatement(id, who, _contentHash(who), WORK_URI, pk);
        vm.prank(relayer);
        sid = escrow.submit(id, who, _contentHash(who), WORK_URI, sig);
    }

    /// @dev Relayed with no proof at all: evidence only, never payable.
    function _submitDeclared(uint256 id, address who) internal returns (uint256 sid) {
        vm.prank(relayer);
        sid = escrow.submit(id, who, _contentHash(who), WORK_URI, "");
    }

    function _signStatement(uint256 id, address payee, bytes32 hash_, string memory uri, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = escrow.submissionStatementDigest(id, payee, hash_, uri);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
