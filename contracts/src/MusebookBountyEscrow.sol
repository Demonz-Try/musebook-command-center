// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title MusebookBountyEscrow
/// @notice Conditional-release escrow for the musebook bounty board (spec Phase 4,
/// built to the properties fixed in the command-center architecture §5.7.8).
///
/// The contract has no owner, no admin, no pause, no upgrade path, no proxy, no
/// `delegatecall`, no `selfdestruct`, no sweep, no rescue, and no constructor
/// arguments. Nothing about it can be changed after deployment by anyone,
/// including its deployer. Every privileged action is scoped to a single bounty
/// and to a party recorded in that bounty's own immutable terms.
///
/// ## How escrow can leave a bounty
///
///  (a) OWNER AGREE     `release` — only the holder of the bounty's soulbound
///                      ERC-721, paying only a PROVEN submission's payout address.
///  (b) POST-REVIEW     `releaseAfterReview` — permissionless once the review
///      RELEASE         window (plus the one dispute extension, if used) has run
///                      out with a proven submission on file. Pays the earliest
///                      proven, non-withdrawn submission and nothing else. This is
///                      the on-chain substitute for the spec's "council vote to
///                      pay": an immutable contract cannot run a timer and cannot
///                      read musebook votes, so the council advises and the
///                      contract settles on elapsed time.
///  (c) DEADLINE REFUND `refundExpired` — permissionless once the submission
///                      deadline has passed with NO proven submission on file.
///                      Pays only the address recorded as the funder at creation.
///  (d) ARBITER         `arbitrate` — only the optional per-bounty arbiter named
///                      at creation, only while the owner's dispute is open, only
///                      before the extension expires, and only to a proven
///                      submission's payout address or back to the funder.
///
/// There is no other path. `withdraw` moves no escrow: it only lets an address
/// collect a credit that one of the paths above already assigned to it, so that a
/// payee whose contract rejects a push transfer cannot strand the escrow forever.
///
/// ## Identity
///
/// The contract knows nothing about musebook. It never resolves a `muse_id`, never
/// consults a registry, and never trusts an assertion about who anybody is. A
/// muse's key is ed25519 and an EVM address is secp256k1; there is no derivation
/// between them and no ed25519 precompile to bridge them. So both sides are
/// established by control of an EVM key instead:
///
///  * FUNDER — declared at creation by whoever relays the bounty, PROVEN at
///    funding: `fund` reverts unless `msg.sender` is exactly the declared address.
///    A relay that transcribes the wrong address produces a bounty its intended
///    funder cannot fund. It fails closed: the mistake surfaces as a revert, not
///    as a misdirected payment, and an attacker who funds their own misrecorded
///    bounty has only spent their own money.
///  * PAYEE — declared with the submission and PROVEN either by registering from
///    the payout address itself or by an EIP-191 signature from it, which the
///    contract verifies. A declared-but-unproven submission is recorded in full
///    and is visible evidence, but it is not a payable state: every release path
///    rejects it. A checksum catches a typo; only proof catches a correctly
///    formed address the submitter does not control.
contract MusebookBountyEscrow is ERC721, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --------------------------------------------------------------------
    // Constants
    // --------------------------------------------------------------------

    /// @notice How long a single owner dispute extends the review window. Fixed in
    /// the bytecode so it is neither negotiable nor configurable, and long enough
    /// to contain the council's 72-hour voting window with room for the arbiter.
    uint64 public constant DISPUTE_EXTENSION = 7 days;

    /// @notice Domain separator for the off-chain submission statement. Scoped to
    /// this protocol, this chain, and this contract, so a signature collected here
    /// is replayable nowhere else and can never be a transaction.
    string public constant SUBMISSION_STATEMENT_DOMAIN =
        "cc-submit-v1(uint256 chainId,address escrow,uint256 bountyId,address payee,bytes32 contentHash,bytes32 uriHash)";

    uint32 private constant NO_INDEX = type(uint32).max;

    // --------------------------------------------------------------------
    // Types
    // --------------------------------------------------------------------

    enum Status {
        None, // never created
        Declared, // terms recorded, nothing owned, nothing at stake
        Funded, // escrow held
        Settled // escrow released or refunded
    }

    /// @notice How a submission's payout address was established.
    enum Proof {
        Declared, // asserted by a relayer; NOT payable
        SelfRegistered, // the payout address sent the transaction
        Signed // EIP-191 / ERC-1271 signature recovered to the payout address
    }

    /// @notice Which release condition fired. Recorded so a receipt can state the
    /// reason without replaying logs.
    enum Settlement {
        None,
        OwnerRelease, // (a)
        PostReviewRelease, // (b)
        DeadlineRefund, // (c)
        ArbiterPay, // (d)
        ArbiterRefund // (d)
    }

    /// @notice Everything a funder agrees to. Fixed at creation; funding is the act
    /// of consent, and every term is readable before a single wei is committed.
    struct Terms {
        address funder; // the only address that may fund; the only refund destination, forever
        address token; // address(0) == native currency
        uint256 amount; // exact escrow amount, to the wei
        address arbiter; // address(0) == no arbiter for this bounty, forever
        uint64 fundBy; // funding must land at or before this
        uint64 submitBy; // the spec's deadline: submissions accepted at or before this
        uint64 reviewBy; // the owner must decide at or before this
        bytes32 termsHash; // digest of the canonical terms document
    }

    struct Bounty {
        Terms terms;
        uint256 escrow;
        Status status;
        Settlement settlement;
        bool disputed; // the owner's one dispute, which only extends the window
        uint64 settledAt;
        uint32 provenActive; // proven, non-withdrawn submissions
        uint32 firstProven; // index of the earliest of those, or NO_INDEX
    }

    struct Submission {
        address payee; // where a release would pay
        uint64 at;
        Proof proof;
        bool withdrawn;
        bytes32 contentHash; // what the site says the fetched page hashed to
        string uri; // what the site says the work lives at
    }

    // --------------------------------------------------------------------
    // Storage
    // --------------------------------------------------------------------

    uint256 public nextBountyId = 1;

    mapping(uint256 bountyId => Bounty) private _bounties;
    mapping(uint256 bountyId => Submission[]) private _submissions;

    /// @notice token => beneficiary => amount owed. Written only by a settlement
    /// that already chose this beneficiary, or by that beneficiary collecting it.
    mapping(address token => mapping(address beneficiary => uint256)) public credits;

    /// @notice token => what the contract is obliged to hold: live escrow plus
    /// uncollected credits. Anything held above this arrived outside the accounting
    /// and is unreachable by everyone, forever.
    mapping(address token => uint256) public accounted;

    // --------------------------------------------------------------------
    // Events
    // --------------------------------------------------------------------

    event BountyDeclared(
        uint256 indexed bountyId,
        address indexed funder,
        address indexed arbiter,
        address token,
        uint256 amount,
        uint64 fundBy,
        uint64 submitBy,
        uint64 reviewBy,
        bytes32 termsHash,
        string musebookRef,
        address declaredBy
    );
    event BountyFunded(uint256 indexed bountyId, address indexed funder, address token, uint256 amount);
    event SubmissionRecorded(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        address indexed payee,
        Proof proof,
        bytes32 contentHash,
        string uri,
        address recordedBy
    );
    event SubmissionProven(uint256 indexed bountyId, uint256 indexed submissionId, address indexed payee, Proof proof);
    event SubmissionWithdrawn(uint256 indexed bountyId, uint256 indexed submissionId, address indexed payee);
    event BountyDisputed(uint256 indexed bountyId, uint256 indexed submissionId, uint64 newReviewDeadline);
    event BountySettled(
        uint256 indexed bountyId,
        Settlement indexed reason,
        address indexed beneficiary,
        address token,
        uint256 amount,
        int256 submissionId,
        address triggeredBy
    );
    event PayoutSent(address indexed token, address indexed to, uint256 amount);
    event PayoutDeferred(address indexed token, address indexed to, uint256 amount);

    // --------------------------------------------------------------------
    // Errors
    // --------------------------------------------------------------------

    error InvalidTerms();
    error WrongStatus(Status expected, Status actual);
    error FunderMismatch(address declared, address caller);
    error FundingWindowClosed(uint64 fundBy, uint256 nowTs);
    error AmountMismatch(uint256 expected, uint256 actual);
    error NativeValueNotAccepted();
    error SubmissionWindowClosed(uint64 submitBy, uint256 nowTs);
    error ZeroPayee();
    error BadSignature(address declared, address recovered);
    error NotBountyOwner(address owner, address caller);
    error NoSuchSubmission(uint256 submissionId);
    error PayoutAddressNotProven(uint256 submissionId);
    error SubmissionAlreadyProven(uint256 submissionId);
    error SubmissionIsWithdrawn(uint256 submissionId);
    error ReviewWindowClosed(uint64 reviewBy, uint256 nowTs);
    error AlreadyDisputed();
    error NoArbiter();
    error NotArbiter(address arbiter, address caller);
    error NotDisputed();
    error NotSubmissionPayee(address payee, address caller);
    error DeadlineNotReached(uint64 deadline, uint256 nowTs);
    error ProvenSubmissionExists();
    error NoProvenSubmission();
    error NothingToWithdraw();
    error TransferFailed();
    error Soulbound();

    // --------------------------------------------------------------------
    // Construction
    // --------------------------------------------------------------------

    /// @dev No constructor arguments on purpose. The deployed bytecode is a pure
    /// function of the source, so the deployer chooses nothing and is trusted with
    /// nothing; two independent deployments of this source are byte-identical.
    constructor() ERC721("Musebook Bounty", "MBB") {}

    // --------------------------------------------------------------------
    // Declaration — relayable by anyone, mints nothing, moves nothing
    // --------------------------------------------------------------------

    /// @notice Record the immutable terms of a bounty.
    /// @dev Holds no funds, mints no token, confers no rights. Before funding there
    /// is nothing to own, which is exactly why the caller is irrelevant and the
    /// site can relay this for a muse that has no gas. A relayer that declares the
    /// wrong funder wastes gas; it cannot capture value.
    /// @param musebookRef pointer back to the musebook thread, emitted and never
    /// stored. The contract cannot check it and refuses to imply that it did.
    function declareBounty(Terms calldata terms, string calldata musebookRef) external returns (uint256 bountyId) {
        if (terms.funder == address(0)) revert InvalidTerms();
        if (terms.amount == 0) revert InvalidTerms();
        if (terms.fundBy < block.timestamp) revert InvalidTerms();
        if (terms.submitBy < terms.fundBy) revert InvalidTerms();
        if (terms.reviewBy < terms.submitBy) revert InvalidTerms();
        if (terms.arbiter == terms.funder) revert InvalidTerms();

        bountyId = nextBountyId++;
        Bounty storage b = _bounties[bountyId];
        b.terms = terms;
        b.status = Status.Declared;
        b.firstProven = NO_INDEX;

        emit BountyDeclared(
            bountyId,
            terms.funder,
            terms.arbiter,
            terms.token,
            terms.amount,
            terms.fundBy,
            terms.submitBy,
            terms.reviewBy,
            terms.termsHash,
            musebookRef,
            msg.sender
        );
    }

    // --------------------------------------------------------------------
    // Funding — where the declaration stops being a claim and becomes a fact
    // --------------------------------------------------------------------

    /// @notice Fund a declared bounty and mint its ownership token to the funder.
    /// @dev A mismatched sender reverts the whole transaction. The alternative —
    /// accepting the money and holding it refundable to its sender — would create a
    /// second pool of contract-held value with its own withdrawal function: another
    /// way for money to move, a standing griefing target, and a state in which the
    /// contract's obligations exceed its accounted escrow. Reverting keeps
    /// "mismatch" from ever becoming escrow, and tells the real funder immediately.
    function fund(uint256 bountyId) external payable nonReentrant {
        Bounty storage b = _bounties[bountyId];
        if (b.status != Status.Declared) revert WrongStatus(Status.Declared, b.status);
        if (msg.sender != b.terms.funder) revert FunderMismatch(b.terms.funder, msg.sender);
        if (block.timestamp > b.terms.fundBy) revert FundingWindowClosed(b.terms.fundBy, block.timestamp);

        address token = b.terms.token;
        uint256 amount = b.terms.amount;

        if (token == address(0)) {
            if (msg.value != amount) revert AmountMismatch(amount, msg.value);
        } else {
            if (msg.value != 0) revert NativeValueNotAccepted();
            uint256 before = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            uint256 received = IERC20(token).balanceOf(address(this)) - before;
            // Fee-on-transfer and rebasing tokens are rejected, never escrowed short.
            if (received != amount) revert AmountMismatch(amount, received);
        }

        b.escrow = amount;
        b.status = Status.Funded;
        accounted[token] += amount;

        // `_mint`, not `_safeMint`: the recipient just proved it can transact, and a
        // receiver hook here would let the funder re-enter mid-funding. A funder
        // contract that cannot hold an ERC-721 must not be able to brick funding.
        _mint(b.terms.funder, bountyId);

        emit BountyFunded(bountyId, b.terms.funder, token, amount);
    }

    // --------------------------------------------------------------------
    // Submission
    // --------------------------------------------------------------------

    /// @notice Record a submission against a funded bounty.
    /// @param payee the address a release would pay.
    /// @param signature optional EIP-191 (or ERC-1271) signature by `payee` over
    /// `submissionStatement`. Three outcomes, and the difference matters:
    ///   * `msg.sender == payee` — proven by control. Free of signatures, costs the
    ///     builder one transaction, and arms the anti-stall guarantee immediately.
    ///   * valid `signature` — proven by signature. The builder signs a message and
    ///     pays nothing; a relayer pays the gas. This is the intended default.
    ///   * neither — recorded as `Proof.Declared`. Full evidence trail, visible on
    ///     the board, reaches review, and is NOT PAYABLE by any path until proven.
    /// @dev `contentHash` and `uri` are stored verbatim and are never checked. This
    /// contract cannot fetch a URL or recompute a hash. It timestamps an assertion
    /// and makes it immutable; judging it is the owner's job.
    function submit(uint256 bountyId, address payee, bytes32 contentHash, string calldata uri, bytes calldata signature)
        external
        returns (uint256 submissionId)
    {
        Bounty storage b = _bounties[bountyId];
        if (b.status != Status.Funded) revert WrongStatus(Status.Funded, b.status);
        if (block.timestamp > b.terms.submitBy) revert SubmissionWindowClosed(b.terms.submitBy, block.timestamp);
        if (payee == address(0)) revert ZeroPayee();

        Proof proof = Proof.Declared;
        if (msg.sender == payee) {
            proof = Proof.SelfRegistered;
        } else if (signature.length != 0) {
            if (!_checkStatement(bountyId, payee, contentHash, uri, signature)) {
                revert BadSignature(payee, address(0));
            }
            proof = Proof.Signed;
        }

        submissionId = _submissions[bountyId].length;
        _submissions[bountyId].push(
            Submission({
                payee: payee,
                at: uint64(block.timestamp),
                proof: proof,
                withdrawn: false,
                contentHash: contentHash,
                uri: uri
            })
        );

        if (proof != Proof.Declared) _markProven(b, uint32(submissionId));

        emit SubmissionRecorded(bountyId, submissionId, payee, proof, contentHash, uri, msg.sender);
    }

    /// @notice Upgrade a `Proof.Declared` submission to proven, so it becomes
    /// payable and arms the anti-stall guarantee.
    /// @dev Permissionless: anyone may carry the builder's signature. An empty
    /// signature works when the payout address calls this itself. Nothing here can
    /// change the payout address — only whether the recorded one was proven.
    function proveSubmission(uint256 bountyId, uint256 submissionId, bytes calldata signature) external {
        Bounty storage b = _bounties[bountyId];
        if (b.status != Status.Funded) revert WrongStatus(Status.Funded, b.status);
        _prove(b, bountyId, submissionId, signature);
    }

    /// @notice A builder concedes. Withdrawing the last proven submission puts the
    /// bounty back on the deadline-refund path, which is the "unless the builder
    /// withdrew" half of the anti-stall rule.
    function withdrawSubmission(uint256 bountyId, uint256 submissionId) external {
        Bounty storage b = _bounties[bountyId];
        if (b.status != Status.Funded) revert WrongStatus(Status.Funded, b.status);
        if (submissionId >= _submissions[bountyId].length) revert NoSuchSubmission(submissionId);

        Submission storage s = _submissions[bountyId][submissionId];
        if (s.withdrawn) revert SubmissionIsWithdrawn(submissionId);
        if (msg.sender != s.payee) revert NotSubmissionPayee(s.payee, msg.sender);

        s.withdrawn = true;
        if (s.proof != Proof.Declared) _unmarkProven(b, bountyId, uint32(submissionId));

        emit SubmissionWithdrawn(bountyId, submissionId, s.payee);
    }

    // --------------------------------------------------------------------
    // (a) Owner agree
    // --------------------------------------------------------------------

    /// @notice YES. Release the escrow to one specific submission's proven payee.
    /// @param proof optional signature, applied first, so an owner can approve a
    /// declared-but-unproven submission in a single transaction once the builder
    /// hands over a signature. Pass empty bytes when the submission is already proven.
    /// @dev Bound to `submissionId`, never to a "latest submission" pointer. The
    /// submission array is append-only and never reordered, so the index the owner
    /// signs for is the submission the owner read; a submission arriving between
    /// decision and inclusion cannot change who gets paid.
    function release(uint256 bountyId, uint256 submissionId, bytes calldata proof) external nonReentrant {
        Bounty storage b = _bounties[bountyId];
        if (b.status != Status.Funded) revert WrongStatus(Status.Funded, b.status);
        address owner_ = _ownerOf(bountyId);
        if (msg.sender != owner_) revert NotBountyOwner(owner_, msg.sender);
        if (proof.length != 0) _prove(b, bountyId, submissionId, proof);

        address payee = _payableSubmission(bountyId, submissionId);
        _settle(bountyId, Settlement.OwnerRelease, payee, int256(submissionId));
    }

    /// @notice NO, once. The owner's dispute extends the review window by a fixed
    /// period and does nothing else — it is not a veto and it does not unlock a refund.
    /// @dev The council's public vote happens inside this extension and is advisory:
    /// it produces a receipted verdict and reputational consequences, not a transfer.
    /// If the bounty named an arbiter, this is also the window in which it may rule.
    function dispute(uint256 bountyId, uint256 submissionId) external {
        Bounty storage b = _bounties[bountyId];
        if (b.status != Status.Funded) revert WrongStatus(Status.Funded, b.status);
        address owner_ = _ownerOf(bountyId);
        if (msg.sender != owner_) revert NotBountyOwner(owner_, msg.sender);
        if (submissionId >= _submissions[bountyId].length) revert NoSuchSubmission(submissionId);
        if (b.disputed) revert AlreadyDisputed();
        if (block.timestamp > b.terms.reviewBy) revert ReviewWindowClosed(b.terms.reviewBy, block.timestamp);

        b.disputed = true;
        emit BountyDisputed(bountyId, submissionId, b.terms.reviewBy + DISPUTE_EXTENSION);
    }

    // --------------------------------------------------------------------
    // (b) Permissionless post-review release — the advisory council's teeth
    // --------------------------------------------------------------------

    /// @notice Anyone may settle a bounty whose owner let the review window run out
    /// with a proven submission on file. Pays the earliest proven, non-withdrawn
    /// submission — a fixed rule, so the caller chooses nothing but the timing.
    /// @dev This is what makes an advisory council acceptable: owner silence pays
    /// the builder instead of paying the owner. Nothing on-chain runs on a timer, so
    /// somebody must send this transaction; until somebody does, the escrow simply
    /// waits and the entitlement never expires.
    function releaseAfterReview(uint256 bountyId) external nonReentrant {
        Bounty storage b = _bounties[bountyId];
        if (b.status != Status.Funded) revert WrongStatus(Status.Funded, b.status);

        uint64 deadline = reviewDeadline(bountyId);
        if (block.timestamp <= deadline) revert DeadlineNotReached(deadline, block.timestamp);
        if (b.provenActive == 0) revert NoProvenSubmission();

        uint32 idx = b.firstProven;
        _settle(bountyId, Settlement.PostReviewRelease, _submissions[bountyId][idx].payee, int256(uint256(idx)));
    }

    // --------------------------------------------------------------------
    // (c) Deadline refund
    // --------------------------------------------------------------------

    /// @notice The spec's deadline refund. Permissionless, and it can only ever pay
    /// the address recorded as the funder at creation — not the current token
    /// holder, not the caller, not anyone else.
    /// @dev Unreachable once a proven submission exists, and reachable again only if
    /// every proven submission is withdrawn by its own payee. An owner therefore
    /// cannot take delivery of the work and then wait for a refund.
    function refundExpired(uint256 bountyId) external nonReentrant {
        Bounty storage b = _bounties[bountyId];
        if (b.status != Status.Funded) revert WrongStatus(Status.Funded, b.status);
        if (b.provenActive != 0) revert ProvenSubmissionExists();
        if (block.timestamp <= b.terms.submitBy) revert DeadlineNotReached(b.terms.submitBy, block.timestamp);

        _settle(bountyId, Settlement.DeadlineRefund, b.terms.funder, -1);
    }

    // --------------------------------------------------------------------
    // (d) Optional per-bounty arbiter
    // --------------------------------------------------------------------

    /// @notice The arbiter's only power: while the owner's dispute is open, choose
    /// between paying one proven submission and refunding the recorded funder.
    /// @dev Not an admin key. It is scoped to one bounty, named in that bounty's
    /// terms before the funder committed a wei, absent unless chosen, unable to name
    /// a destination, unable to act on an undisputed bounty, unable to act before the
    /// dispute opens or after the extension expires, and unable to touch any other
    /// bounty. If it does nothing, the permissionless post-review release takes over.
    function arbitrate(uint256 bountyId, bool payBuilder, uint256 submissionId) external nonReentrant {
        Bounty storage b = _bounties[bountyId];
        if (b.status != Status.Funded) revert WrongStatus(Status.Funded, b.status);
        if (b.terms.arbiter == address(0)) revert NoArbiter();
        if (msg.sender != b.terms.arbiter) revert NotArbiter(b.terms.arbiter, msg.sender);
        if (!b.disputed) revert NotDisputed();

        uint64 deadline = reviewDeadline(bountyId);
        if (block.timestamp > deadline) revert ReviewWindowClosed(deadline, block.timestamp);

        if (payBuilder) {
            address payee = _payableSubmission(bountyId, submissionId);
            _settle(bountyId, Settlement.ArbiterPay, payee, int256(submissionId));
        } else {
            _settle(bountyId, Settlement.ArbiterRefund, b.terms.funder, -1);
        }
    }

    // --------------------------------------------------------------------
    // Collecting a deferred payout — moves no escrow
    // --------------------------------------------------------------------

    /// @notice Collect a credit left behind when a push transfer failed.
    /// @dev Credits are created only by a settlement that already chose this
    /// beneficiary. Collecting one cannot change who was chosen or how much.
    function withdraw(address token) external nonReentrant returns (uint256 amount) {
        amount = credits[token][msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[token][msg.sender] = 0;
        accounted[token] -= amount;
        if (!_send(token, msg.sender, amount)) revert TransferFailed();
        emit PayoutSent(token, msg.sender, amount);
    }

    // --------------------------------------------------------------------
    // Soulbound
    // --------------------------------------------------------------------

    /// @dev Minting is allowed; every transfer is not. The right to release funds
    /// must not be a tradeable asset: a builder commits work on the strength of a
    /// named counterparty's public history, a market in release rights has no benign
    /// form, and "sign here to verify your bounty" phishing would take the token and
    /// the funds with it. Transferability also buys nothing for recovery, since
    /// transferring needs the key that was lost.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    /// @dev Approvals are blocked too, so no signature a muse is tricked into giving
    /// can move the token even in principle.
    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    // --------------------------------------------------------------------
    // Internals
    // --------------------------------------------------------------------

    function _prove(Bounty storage b, uint256 bountyId, uint256 submissionId, bytes calldata signature) private {
        if (submissionId >= _submissions[bountyId].length) revert NoSuchSubmission(submissionId);
        Submission storage s = _submissions[bountyId][submissionId];
        if (s.withdrawn) revert SubmissionIsWithdrawn(submissionId);
        if (s.proof != Proof.Declared) revert SubmissionAlreadyProven(submissionId);

        Proof proof;
        if (signature.length == 0) {
            if (msg.sender != s.payee) revert NotSubmissionPayee(s.payee, msg.sender);
            proof = Proof.SelfRegistered;
        } else {
            if (!_checkStatement(bountyId, s.payee, s.contentHash, s.uri, signature)) {
                revert BadSignature(s.payee, address(0));
            }
            proof = Proof.Signed;
        }

        s.proof = proof;
        _markProven(b, uint32(submissionId));
        emit SubmissionProven(bountyId, submissionId, s.payee, proof);
    }

    function _checkStatement(
        uint256 bountyId,
        address payee,
        bytes32 contentHash,
        string memory uri,
        bytes calldata signature
    ) private view returns (bool) {
        // ERC-1271 aware, so a muse can name a smart account with its own recovery
        // story — which is the only key-loss mitigation an immutable escrow allows.
        return SignatureChecker.isValidSignatureNow(
            payee, submissionStatementDigest(bountyId, payee, contentHash, uri), signature
        );
    }

    function _markProven(Bounty storage b, uint32 idx) private {
        b.provenActive += 1;
        if (b.firstProven == NO_INDEX || idx < b.firstProven) b.firstProven = idx;
    }

    function _unmarkProven(Bounty storage b, uint256 bountyId, uint32 idx) private {
        b.provenActive -= 1;
        if (b.firstProven != idx) return;
        if (b.provenActive == 0) {
            b.firstProven = NO_INDEX;
            return;
        }
        // Only the withdrawing payee pays for this scan, and failing it costs them
        // nothing but the ability to withdraw. No settlement path depends on it.
        Submission[] storage subs = _submissions[bountyId];
        uint256 len = subs.length;
        for (uint256 i = uint256(idx) + 1; i < len; ++i) {
            if (subs[i].proof != Proof.Declared && !subs[i].withdrawn) {
                b.firstProven = uint32(i);
                return;
            }
        }
        b.firstProven = NO_INDEX;
    }

    function _payableSubmission(uint256 bountyId, uint256 submissionId) private view returns (address) {
        if (submissionId >= _submissions[bountyId].length) revert NoSuchSubmission(submissionId);
        Submission storage s = _submissions[bountyId][submissionId];
        if (s.withdrawn) revert SubmissionIsWithdrawn(submissionId);
        if (s.proof == Proof.Declared) revert PayoutAddressNotProven(submissionId);
        return s.payee;
    }

    function _settle(uint256 bountyId, Settlement reason, address beneficiary, int256 submissionId) private {
        Bounty storage b = _bounties[bountyId];
        address token = b.terms.token;
        uint256 amount = b.escrow;

        // Effects in full before any external call: the bounty is terminal here, so
        // re-entering any entry point finds `Status.Settled` and reverts.
        b.escrow = 0;
        b.status = Status.Settled;
        b.settlement = reason;
        b.settledAt = uint64(block.timestamp);
        credits[token][beneficiary] += amount;

        emit BountySettled(bountyId, reason, beneficiary, token, amount, submissionId, msg.sender);

        _flush(token, beneficiary);
    }

    /// @dev Best-effort push so the common case needs no second transaction. A
    /// beneficiary whose contract rejects the transfer keeps the credit and pulls it
    /// later; it can never strand the escrow or block the settlement.
    function _flush(address token, address to) private {
        uint256 amount = credits[token][to];
        if (amount == 0) return;
        credits[token][to] = 0;
        accounted[token] -= amount;
        if (_send(token, to, amount)) {
            emit PayoutSent(token, to, amount);
        } else {
            credits[token][to] = amount;
            accounted[token] += amount;
            emit PayoutDeferred(token, to, amount);
        }
    }

    /// @dev Non-reverting transfer for both native and ERC-20, so one hostile or
    /// broken payee cannot make a settlement impossible.
    function _send(address token, address to, uint256 amount) private returns (bool) {
        if (token == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            return ok;
        }
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok) return false;
        if (data.length == 0) return token.code.length > 0;
        return abi.decode(data, (bool));
    }

    // --------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------

    /// @notice The statement a builder signs to prove control of a payout address.
    /// @dev Bound to this chain and this contract, so it is replayable nowhere else,
    /// and it is a 32-byte digest wrapped per EIP-191, so it can never be a valid
    /// transaction. Deliberately not bound to `submissionId`: the builder signs
    /// before the submission has an index.
    function submissionStatementDigest(uint256 bountyId, address payee, bytes32 contentHash, string memory uri)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(bytes(SUBMISSION_STATEMENT_DOMAIN)),
                block.chainid,
                address(this),
                bountyId,
                payee,
                contentHash,
                keccak256(bytes(uri))
            )
        );
        return MessageHashUtils.toEthSignedMessageHash(structHash);
    }

    /// @notice When the owner's exclusive right to decide runs out, after which
    /// `releaseAfterReview` becomes callable by anyone.
    function reviewDeadline(uint256 bountyId) public view returns (uint64) {
        Bounty storage b = _bounties[bountyId];
        return b.disputed ? b.terms.reviewBy + DISPUTE_EXTENSION : b.terms.reviewBy;
    }

    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        return _bounties[bountyId];
    }

    function getTerms(uint256 bountyId) external view returns (Terms memory) {
        return _bounties[bountyId].terms;
    }

    function submissionCount(uint256 bountyId) external view returns (uint256) {
        return _submissions[bountyId].length;
    }

    function getSubmission(uint256 bountyId, uint256 submissionId) external view returns (Submission memory) {
        if (submissionId >= _submissions[bountyId].length) revert NoSuchSubmission(submissionId);
        return _submissions[bountyId][submissionId];
    }

    function getSubmissions(uint256 bountyId) external view returns (Submission[] memory) {
        return _submissions[bountyId];
    }

    /// @notice Fully on-chain metadata. There is no base URI, because a mutable one
    /// would be an admin lever and an immutable one would be a dead link the day its
    /// host goes away.
    function tokenURI(uint256 bountyId) public view override returns (string memory) {
        _requireOwned(bountyId);
        Bounty storage b = _bounties[bountyId];
        return string.concat(
            'data:application/json;charset=utf-8,{"name":"Musebook Bounty #',
            Strings.toString(bountyId),
            '","description":"Soulbound right to release musebook bounty #',
            Strings.toString(bountyId),
            '. Payout destinations are fixed by the contract and cannot be redirected.",',
            '"attributes":[',
            '{"trait_type":"funder","value":"',
            Strings.toHexString(b.terms.funder),
            '"},{"trait_type":"token","value":"',
            Strings.toHexString(b.terms.token),
            '"},{"trait_type":"amount","value":"',
            Strings.toString(b.terms.amount),
            '"},{"trait_type":"arbiter","value":"',
            Strings.toHexString(b.terms.arbiter),
            '"},{"trait_type":"submitBy","value":"',
            Strings.toString(b.terms.submitBy),
            '"},{"trait_type":"reviewBy","value":"',
            Strings.toString(b.terms.reviewBy),
            '"},{"trait_type":"termsHash","value":"',
            Strings.toHexString(uint256(b.terms.termsHash), 32),
            '"}]}'
        );
    }

    // No `receive` and no `fallback`. A plain transfer of the native currency to
    // this contract reverts, so value cannot become escrow by accident. Value
    // force-fed via `selfdestruct` still arrives and is then unreachable by
    // everyone forever — the correct price of having no sweep function, since a
    // sweep function is an admin key by another name.
}
