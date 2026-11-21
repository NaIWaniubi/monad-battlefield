// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MerkleDistributor — 贡献统计上链结算
/// @notice owner 只做一件事：把「贡献统计结果」的 Merkle 根和奖池总额写上链。
///         之后任何人拿 proof 直接 claim，钱从合约进入 account，合约不看名单、
///         不认中间人。root / total / 每条 (index,account,amount) / 是否已领，
///         全部链上可查，任何人可用公开数据重算根。
contract MerkleDistributor {
    address public immutable owner;
    bytes32 public root;
    uint256 public total; // 当前 root 对应的奖池总额（信息性，钱以余额为准）

    // 按 root 隔离防重领：换根后旧根的领取记录不影响新根
    mapping(bytes32 => mapping(uint256 => bool)) private claimedAt;

    event RootSet(bytes32 indexed root, uint256 total);
    event Claimed(uint256 indexed index, address indexed account, uint256 amount);

    error NotOwner();
    error AlreadyClaimed();
    error InvalidProof();
    error TransferFailed();

    constructor() {
        owner = msg.sender;
    }

    /// @notice 上链结算：设置本轮 root 并注入奖池（msg.value）
    function setRoot(bytes32 r, uint256 t) external payable {
        if (msg.sender != owner) revert NotOwner();
        root = r;
        total = t;
        emit RootSet(r, t);
    }

    function isClaimed(bytes32 r, uint256 index) public view returns (bool) {
        return claimedAt[r][index];
    }

    /// @notice 任何人可代发，钱只进 account；index 防重领
    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        bytes32 r = root;
        if (claimedAt[r][index]) revert AlreadyClaimed();
        if (!_verify(_leaf(index, account, amount), proof, r)) revert InvalidProof();
        claimedAt[r][index] = true;
        (bool ok,) = payable(account).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(index, account, amount);
    }

    /// @dev leaf = keccak256(abi.encode(index, account, amount))，与链下脚本一致
    function _leaf(uint256 index, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(abi.encode(index, account, amount));
    }

    /// @dev 排序拼接上卷；等价逻辑在 scripts/merkle-core.mjs，链下可独立复算
    function _verify(bytes32 h, bytes32[] calldata proof, bytes32 r) internal pure returns (bool) {
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 p = proof[i];
            h = h <= p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == r;
    }

    receive() external payable {}
}
