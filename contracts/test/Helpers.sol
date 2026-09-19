// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MusebookBountyEscrow} from "../src/MusebookBountyEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Minimal ERC-20 for escrow tests. No mint restrictions: this is a test fixture.
contract MockERC20 is IERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) public virtual {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) public virtual returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        return transferFrom(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        if (from != msg.sender) {
            uint256 allowed = allowance[from][msg.sender];
            if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @dev Skims a fee on every transfer. The escrow must reject it rather than
/// silently hold less than the declared amount.
contract FeeOnTransferERC20 is MockERC20 {
    uint256 public constant FEE_BPS = 100;

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (from != msg.sender) {
            uint256 allowed = allowance[from][msg.sender];
            if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        }
        uint256 fee = (amount * FEE_BPS) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        balanceOf[address(0xFEE)] += fee;
        emit Transfer(from, to, amount - fee);
        return true;
    }
}

/// @dev Calls back into the escrow from inside an ERC-20 transfer.
contract ReentrantERC20 is MockERC20 {
    MusebookBountyEscrow public escrow;
    bytes public payload;
    bool public armed;

    function arm(MusebookBountyEscrow escrow_, bytes calldata payload_) external {
        escrow = escrow_;
        payload = payload_;
        armed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed) {
            armed = false;
            (bool ok,) = address(escrow).call(payload);
            require(!ok, "reentrancy unexpectedly succeeded");
        }
        return super.transfer(to, amount);
    }
}

/// @dev A payee that re-enters the escrow when it is paid.
/// `mode` selects what it does on receiving native currency.
contract MaliciousPayee {
    enum Mode {
        Accept, // behave
        Reenter, // re-enter and let the revert bubble, failing the push
        ReenterSwallow, // re-enter, swallow the revert, still accept the money
        Reject // refuse the transfer outright
    }

    MusebookBountyEscrow public immutable escrow;
    Mode public mode;
    bytes public payload;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(MusebookBountyEscrow escrow_) {
        escrow = escrow_;
    }

    function setMode(Mode mode_, bytes memory payload_) external {
        mode = mode_;
        payload = payload_;
    }

    function doSubmit(uint256 bountyId, bytes32 hash_, string calldata uri) external returns (uint256) {
        return escrow.submit(bountyId, address(this), hash_, uri, "");
    }

    function doWithdraw(address token) external returns (uint256) {
        return escrow.withdraw(token);
    }

    function doRelease(uint256 bountyId, uint256 submissionId) external {
        escrow.release(bountyId, submissionId, "");
    }

    receive() external payable {
        if (mode == Mode.Reject) revert("no thanks");
        if (mode == Mode.Reenter) {
            reentryAttempted = true;
            (bool ok,) = address(escrow).call(payload);
            reentrySucceeded = ok;
            require(ok, "reentrancy blocked");
        }
        if (mode == Mode.ReenterSwallow) {
            reentryAttempted = true;
            (bool ok,) = address(escrow).call(payload);
            reentrySucceeded = ok;
        }
    }
}

/// @dev Pushes native currency into a contract that has no `receive`. Post-EIP-6780
/// `selfdestruct` in the same transaction as creation still transfers the balance.
contract ForceFeeder {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}

/// @dev Accepts ERC-721 so it can hold a bounty token.
contract ContractHolder {
    MusebookBountyEscrow public immutable escrow;

    constructor(MusebookBountyEscrow escrow_) {
        escrow = escrow_;
    }

    function doFund(uint256 bountyId, uint256 value) external payable {
        escrow.fund{value: value}(bountyId);
    }

    function doRelease(uint256 bountyId, uint256 submissionId) external {
        escrow.release(bountyId, submissionId, "");
    }

    receive() external payable {}
}

/// @dev An ERC-1271 smart account, the shape §5.7.4 recommends a muse declare so
/// that key recovery lives in the account rather than in the escrow.
contract SmartAccount {
    bytes4 private constant MAGIC = 0x1626ba7e;

    address public signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function rotateSigner(address signer_) external {
        signer = signer_;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        (bytes32 r, bytes32 s, uint8 v) = _split(signature);
        return ecrecover(digest, v, r, s) == signer ? MAGIC : bytes4(0xffffffff);
    }

    function _split(bytes calldata sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "bad sig");
        r = bytes32(sig[0:32]);
        s = bytes32(sig[32:64]);
        v = uint8(sig[64]);
    }

    receive() external payable {}
}
