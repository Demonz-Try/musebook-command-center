// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MusebookBountyEscrow} from "../src/MusebookBountyEscrow.sol";

/// @notice Deploys the escrow. There is nothing to configure: the constructor
/// takes no arguments, so the deployer chooses nothing, is granted nothing, and
/// cannot be asked for anything afterwards.
///
/// Local:
///   anvil --port 8546
///   forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8546 \
///     --private-key $LOCAL_ANVIL_KEY --broadcast
///
/// Public testnet (not performed here — see docs/deployment.md):
///   forge script script/Deploy.s.sol:Deploy --rpc-url $RH_TESTNET_RPC_URL \
///     --account escrowDeployer --broadcast --verify \
///     --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/
///
/// Prefer `--account <keystore-name>` over `--private-key`. A raw key on the
/// command line lands in shell history and process listings.
contract Deploy is Script {
    function run() external returns (MusebookBountyEscrow escrow) {
        vm.startBroadcast();
        escrow = new MusebookBountyEscrow();
        vm.stopBroadcast();

        console.log("MusebookBountyEscrow:", address(escrow));
        console.log("chainid:            ", block.chainid);
        console.log("name/symbol:        ", escrow.name(), escrow.symbol());
        console.log("dispute extension:  ", escrow.DISPUTE_EXTENSION());
        console.log("next bounty id:     ", escrow.nextBountyId());
    }
}

/// @notice Post-deploy assertions. Run against any deployment, by anyone, with no
/// credentials — it only reads. This is the check that the thing at an address is
/// the thing it claims to be and has no levers on it.
///
///   ESCROW=0x... forge script script/Deploy.s.sol:VerifyDeployment --rpc-url $RPC
contract VerifyDeployment is Script {
    function run() external view {
        address target = vm.envAddress("ESCROW");
        MusebookBountyEscrow escrow = MusebookBountyEscrow(target);

        require(target.code.length > 0, "no code at address");
        require(keccak256(bytes(escrow.name())) == keccak256("Musebook Bounty"), "unexpected name");
        require(escrow.DISPUTE_EXTENSION() == 7 days, "unexpected dispute extension");

        // No admin surface. If any of these responded, the deployment would not be
        // the contract in this repository.
        string[8] memory forbidden = [
            "owner()",
            "transferOwnership(address)",
            "pause()",
            "upgradeTo(address)",
            "upgradeToAndCall(address,bytes)",
            "sweep(address)",
            "rescue(address,uint256)",
            "emergencyWithdraw()"
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok,) = target.staticcall(abi.encodeWithSignature(forbidden[i]));
            require(!ok, "admin surface present");
        }

        // No proxy: EIP-1967 implementation and admin slots must be empty, and the
        // EIP-1822 slot too. A proxy here would mean the code can be swapped later.
        require(
            vm.load(target, 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc) == bytes32(0),
            "eip-1967 implementation slot set"
        );
        require(
            vm.load(target, 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103) == bytes32(0),
            "eip-1967 admin slot set"
        );
        require(
            vm.load(target, 0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7) == bytes32(0),
            "eip-1822 proxiable slot set"
        );

        // No SELFDESTRUCT, DELEGATECALL, CALLCODE, CREATE or CREATE2 in the runtime
        // code, walking past PUSH immediates so constants are not miscounted.
        bytes memory code = target.code;
        uint256 i2;
        while (i2 < code.length) {
            uint8 op = uint8(code[i2]);
            require(op != 0xff, "SELFDESTRUCT present");
            require(op != 0xf4, "DELEGATECALL present");
            require(op != 0xf2, "CALLCODE present");
            require(op != 0xf0, "CREATE present");
            require(op != 0xf5, "CREATE2 present");
            if (op >= 0x60 && op <= 0x7f) i2 += uint256(op) - 0x5f;
            i2 += 1;
        }

        console.log("verified immutable escrow at", target);
        console.log("runtime code size", code.length);
    }
}
