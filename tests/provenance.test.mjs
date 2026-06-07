import assert from "node:assert/strict";
import test from "node:test";
import { extractProofObligations } from "../dist/obligations/extract.js";
import { extractHalo2Provenance, renderProvenanceGraph } from "../dist/provenance/halo2.js";
import { extractRustSolanaProvenance } from "../dist/provenance/rust.js";
import { extractSolidityProvenance } from "../dist/provenance/solidity.js";

test("Halo2 provenance extracts advice assignments, copies, and assignment-flow obligations", () => {
  const graph = extractHalo2Provenance([
    {
      path: "chip/mul/incomplete.rs",
      kind: "source",
      content: `
fn assign_incomplete_addition_input(region: &mut Region, row: usize, offset: usize, x_p: Value, y_p: Value) {
    // point scalar multiplication witness advice
    region.assign_advice(|| "x_p", self.double_and_add.x_p, row + offset, || x_p)?;
    region.assign_advice(|| "y_p", self.y_p, row + offset, || y_p)?;
    base_x.copy_advice(|| "base_x", region, self.double_and_add.x_p, row)?;
    meta.create_gate("mul gate", |meta| {
        let q_mul = meta.query_selector(config.q_mul);
        let x = meta.query_advice(config.x, Rotation::cur());
        vec![q_mul * x]
    });
}
`,
    },
  ]);

  assert.equal(graph.domain, "halo2");
  assert.equal(graph.summary.byKind.advice_assignment, 2);
  assert.equal(graph.summary.byKind.advice_copy, 1);
  assert.equal(graph.summary.byKind.gate_creation, 1);
  assert.ok(graph.summary.assignmentFlowObligations >= 2);
  assert.ok(graph.obligations.every((obligation) => obligation.kind === "provenance"));

  const rendered = renderProvenanceGraph(graph);
  assert.match(rendered, /assign_incomplete_addition_input/);
  assert.match(rendered, /source=x_p/);
  assert.match(rendered, /assignment-flow obligations/i);
});

test("Solidity provenance extracts EVM audit-routing facts and obligations", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/Vault.sol",
      kind: "source",
      content: `
contract Vault {
    AggregatorV3Interface public priceFeed;
    mapping(address => uint256) public balanceOf;

    function initialize(address feed) external initializer {
        priceFeed = AggregatorV3Interface(feed);
    }

    function upgradeTo(address impl, bytes calldata data) external onlyOwner {
        impl.delegatecall(data);
    }

    function deposit(uint256 assets) external {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);
        balanceOf[msg.sender] += assets;
    }

    function withdraw(uint256 shares, bytes calldata sig) external nonReentrant {
        bytes32 digest = _hashTypedDataV4(keccak256(sig));
        address signer = ECDSA.recover(digest, sig);
        (, int256 answer,, uint256 updatedAt,) = priceFeed.latestRoundData();
        require(answer > 0 && updatedAt + 1 hours >= block.timestamp, "STALE");
        unchecked { balanceOf[msg.sender] -= shares; }
        (bool ok,) = msg.sender.call{value: shares}("");
        require(ok, "ETH_SEND");
    }
}
`,
    },
  ]);

  assert.equal(graph.domain, "solidity");
  assert.equal(graph.summary.byKind.evm_external_function, 4);
  assert.equal(graph.summary.byKind.evm_delegatecall, 1);
  assert.equal(graph.summary.byKind.evm_token_transfer, 1);
  assert.ok((graph.summary.byKind.evm_state_write ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_signature_check ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_oracle_read ?? 0) >= 1);
  assert.equal(graph.summary.byKind.evm_external_call, 1);
  assert.equal(graph.summary.byKind.evm_unchecked_arithmetic, 1);
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-external-call-state-finalization"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-upgrade-initializer-storage"));
  assert.ok(graph.obligations.every((obligation) => obligation.kind === "provenance"));

  const rendered = renderProvenanceGraph(graph);
  assert.match(rendered, /Domain: solidity/);
  assert.match(rendered, /Routing obligations/);
  assert.match(rendered, /kind=evm_delegatecall/);
  assert.match(rendered, /latestRoundData/);
});

test("Solidity provenance extracts bridge and OFT routing facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/BridgePool.sol",
      kind: "source",
      content: `
contract BridgePool {
    mapping(uint16 => address) public stargateImpls;
    mapping(uint32 => Path) public paths;
    uint64 public treasuryFee;
    uint128 public nativeDropAmount;

    function sendToken(uint32 dstEid, bytes32 receiver, uint256 amountLD, uint256 minAmountLD) external {
        uint64 amountSD = _ld2sd(amountLD);
        paths[dstEid].decreaseCredit(amountSD);
        bytes memory message = TaxiCodec.encodeTaxi(msg.sender, 1, receiver, amountSD, "");
        _lzSend(dstEid, message, "", MessagingFee(msg.value, 0), msg.sender);
    }

    function _lzReceive(Origin calldata origin, bytes32 guid, bytes calldata message) internal {
        (uint16 assetId, bytes32 receiver, uint64 amountSD,) = TaxiCodec.decodeTaxi(message);
        IERC20Minter(stargateImpls[assetId]).mint(address(uint160(uint256(receiver))), _sd2ld(amountSD));
        emit Received(origin.srcEid, guid, nativeDropAmount);
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_bridge_message ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_bridge_asset_mapping ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_bridge_credit_accounting ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_bridge_native_drop ?? 0) >= 1);
  assert.ok((graph.summary.byKind.evm_oft_supply_change ?? 0) >= 2);
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-bridge-message-domain-and-payload-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-bridge-credit-and-liquidity-conservation"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-oft-mint-burn-lock-unlock-conservation"));
});

test("Solidity provenance extracts stablecoin mint redeem and staking facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/EthenaCore.sol",
      kind: "source",
      content: `
contract EthenaCore is ERC4626 {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    mapping(address => uint256) public nonces;
    mapping(address => Cooldown) public cooldowns;
    mapping(address => bool) public fullRestrictedStaker;

    function mint(Order calldata order, Route calldata route, bytes calldata signature) external {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(order)));
        address signer = ECDSA.recover(digest, signature);
        require(hasRole(MINTER_ROLE, signer), "bad signer");
        nonces[order.beneficiary] += 1;
        IERC20(order.collateralAsset).safeTransferFrom(order.benefactor, route.custodian, order.collateralAmount);
        USDe.mint(order.beneficiary, order.usdeAmount);
    }

    function cooldownAssets(uint256 assets, address owner) external returns (uint256 shares) {
        if (fullRestrictedStaker[owner]) revert Restricted();
        shares = previewWithdraw(assets);
        _withdraw(msg.sender, address(silo), owner, assets, shares);
        cooldowns[owner] = Cooldown(block.timestamp, assets);
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_mint_redeem_order ?? 0) >= 4);
  assert.ok((graph.summary.byKind.evm_erc4626_cooldown ?? 0) >= 3);
  assert.ok((graph.summary.byKind.evm_restriction_role ?? 0) >= 2);
  assert.ok(
    graph.obligations.some((obligation) => obligation.id === "solidity-mint-redeem-order-collateral-binding"),
  );
  assert.ok(
    graph.obligations.some((obligation) => obligation.id === "solidity-erc4626-cooldown-share-asset-conservation"),
  );
  assert.ok(
    graph.obligations.some(
      (obligation) => obligation.id === "solidity-role-restriction-transfer-and-privilege-boundaries",
    ),
  );
});

test("Solidity provenance extracts deployed stablecoin V2 authorization and limit facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/EthenaMintingV2.sol",
      kind: "source",
      content: `
contract EthenaMintingV2 {
    mapping(address => bool) private _whitelistedBenefactors;
    mapping(address => mapping(address => bool)) private _approvedBeneficiariesPerBenefactor;
    mapping(uint256 => mapping(address => BlockTotals)) public totalPerBlockPerAsset;
    uint128 public stablesDeltaLimit;
    bytes4 private constant EIP1271_MAGICVALUE = bytes4(keccak256("isValidSignature(bytes32,bytes)"));

    function verifyOrder(Order calldata order, Signature calldata signature) public view returns (bytes32 digest) {
        if (signature.signature_type == SignatureType.EIP1271) {
            if (IERC1271(order.benefactor).isValidSignature(digest, signature.signature_bytes) != EIP1271_MAGICVALUE) {
                revert InvalidEIP1271Signature();
            }
        }
        if (!_whitelistedBenefactors[order.benefactor]) revert BenefactorNotWhitelisted();
        if (order.benefactor != order.beneficiary && !_approvedBeneficiariesPerBenefactor[order.benefactor][order.beneficiary]) {
            revert BeneficiaryNotApproved();
        }
        if (!verifyStablesLimit(order.collateral_amount, order.usde_amount, order.collateral_asset, order.order_type)) {
            revert InvalidStablePrice();
        }
    }

    function verifyStablesLimit(uint128 collateralAmount, uint128 usdeAmount, address collateralAsset, OrderType orderType) public view returns (bool) {
        uint128 collateralDecimals = IERC20Metadata(collateralAsset).decimals();
        uint128 differenceInBps = ((collateralAmount - usdeAmount) * 10000) / usdeAmount;
        return differenceInBps <= stablesDeltaLimit || orderType == OrderType.REDEEM;
    }

    function redeem(Order calldata order) external belowGlobalMaxRedeemPerBlock(order.usde_amount) {
        totalPerBlockPerAsset[block.number][order.collateral_asset].redeemedPerBlock += order.usde_amount;
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_eip1271_signature ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_beneficiary_allowlist ?? 0) >= 3);
  assert.ok((graph.summary.byKind.evm_stable_price_limit ?? 0) >= 3);
  assert.ok((graph.summary.byKind.evm_block_limit ?? 0) >= 2);
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-eip1271-contract-signature-boundary"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-benefactor-beneficiary-allowlist-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-stable-price-decimal-limit"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-per-asset-global-block-limit"));
});

test("Solidity provenance extracts governance payload execution facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "src/StarGuard.sol",
      kind: "source",
      content: `
contract StarGuard {
    struct SpellData { address addr; bytes32 tag; uint256 deadline; }
    mapping(address => uint256) public wards;
    SpellData public spellData;
    SubProxyLike public immutable subProxy;
    uint256 public maxDelay;

    function plot(address addr_, bytes32 tag_) external auth {
        spellData.addr = addr_;
        spellData.tag = tag_;
        spellData.deadline = block.timestamp + maxDelay;
    }

    function exec() external returns (address addr) {
        SpellData memory spellDataCopy = spellData;
        require(spellDataCopy.tag == spellDataCopy.addr.codehash, "wrong-codehash");
        require(block.timestamp <= spellDataCopy.deadline, "expired-spell");
        require(StarSpellLike(spellDataCopy.addr).isExecutable(), "not-yet-executable");
        delete spellData;
        subProxy.exec(spellDataCopy.addr, abi.encodePacked(StarSpellLike.execute.selector));
        require(subProxy.wards(address(this)) == 1, "subProxy-owner-change");
        return spellDataCopy.addr;
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_governance_payload ?? 0) >= 6);
  assert.ok(
    graph.obligations.some((obligation) => obligation.id === "solidity-governance-payload-execution-boundary"),
  );
});

test("Rust provenance extracts Solana OFT and governance facts", () => {
  const graph = extractRustSolanaProvenance([
    {
      path: "programs/oft/src/instructions/lz_receive.rs",
      kind: "source",
      content: `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, MintTo, TokenAccount};

#[derive(Accounts)]
pub struct LzReceive<'info> {
    #[account(mut, seeds = [b"OFT", oft_store.mint.as_ref()], bump = oft_store.bump)]
    pub oft_store: Account<'info, OFTStore>,
    #[account(mut, token::mint = mint, token::authority = recipient)]
    pub recipient_token: Account<'info, TokenAccount>,
    pub endpoint_program: Program<'info, Endpoint>,
}

pub fn apply(ctx: &mut Context<LzReceive>, params: LzReceiveParams) -> Result<()> {
    let peer = ctx.accounts.oft_store.peer(params.src_eid)?;
    require!(peer.address == params.sender, ErrorCode::InvalidPeer);
    let amount_ld = sd2ld(params.amount_sd, ctx.accounts.oft_store.shared_decimals);
    let seeds = &[b"OFT", ctx.accounts.oft_store.mint.as_ref(), &[ctx.accounts.oft_store.bump]];
    token::mint_to(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo { mint: ctx.accounts.mint.to_account_info(), to: ctx.accounts.recipient_token.to_account_info(), authority: ctx.accounts.oft_store.to_account_info() },
        &[seeds],
    ), amount_ld)?;
    oapp::endpoint_cpi::clear(ctx.accounts.endpoint_program.to_account_info(), params.guid)?;
    Ok(())
}
`,
    },
    {
      path: "programs/governance/src/instructions/lz_receive.rs",
      kind: "source",
      content: `
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct LzReceive<'info> {
    #[account(seeds = [b"Governance"], bump = governance.bump)]
    pub governance: Account<'info, Governance>,
    /// CHECK: replaced by CPI authority
    pub cpi_authority: UncheckedAccount<'info>,
}

pub fn apply(ctx: &mut Context<LzReceive>, params: LzReceiveParams) -> Result<()> {
    let remote = ctx.accounts.governance.remote(params.src_eid)?;
    require!(remote.address == params.sender, ErrorCode::InvalidRemote);
    let instruction = decode_governance_instruction(&params.message)?;
    solana_program::program::invoke_signed(&instruction, ctx.remaining_accounts, &[&[b"CpiAuthority", &[ctx.accounts.governance.bump]]])?;
    Ok(())
}
`,
    },
  ]);

  assert.equal(graph.domain, "solana-rust");
  assert.ok((graph.summary.byKind.solana_anchor_account ?? 0) >= 4);
  assert.ok((graph.summary.byKind.solana_pda_derivation ?? 0) >= 2);
  assert.ok((graph.summary.byKind.solana_token_accounting ?? 0) >= 2);
  assert.ok((graph.summary.byKind.solana_cpi_call ?? 0) >= 2);
  assert.ok((graph.summary.byKind.solana_cross_chain_message ?? 0) >= 2);
  assert.ok((graph.summary.byKind.solana_governance_execution ?? 0) >= 2);
  assert.ok((graph.summary.byKind.solana_decimal_conversion ?? 0) >= 1);
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solana-anchor-account-constraint-integrity"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solana-layerzero-message-peer-replay-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solana-governance-execution-account-authority"));
});

test("proof obligations combine corpus, learning, and provenance facts", () => {
  const graph = extractHalo2Provenance([
    {
      path: "chip/example.rs",
      kind: "source",
      content: 'fn assign(region: &mut Region, row: usize, base: Value) { region.assign_advice(|| "base", self.base, row, || base)?; }',
    },
  ]);
  const obligations = extractProofObligations({
    source: [],
    corpus: [
      {
        path: "book/nullifiers.md",
        kind: "corpus",
        content: "The circuit must check that the diversified public key equals the viewing-key multiplication result.",
      },
    ],
    projectLearning: {
      candidateInvariants: ["Witness values that affect a checked statement should be enforced by visible equations."],
      evidenceRefs: ["book/nullifiers.md:1"],
    },
    provenanceGraphs: [graph],
  });

  assert.ok(obligations.some((obligation) => obligation.kind === "spec"));
  assert.ok(obligations.some((obligation) => obligation.kind === "learning"));
  assert.ok(obligations.some((obligation) => obligation.kind === "provenance"));
  assert.ok(obligations.every((obligation) => obligation.evidenceRefs.every((ref) => !ref.startsWith("/"))));
});
