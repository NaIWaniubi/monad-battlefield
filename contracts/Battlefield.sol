// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Battlefield — 2500 个互不相干的格子
/// @notice 并行度的全部秘密：没有任何全局计数器。
///         每一笔 claim 只写自己那一个 slot，所以相邻格的交易可以真正并行执行。
///         全局统计（TPS / 总数 / 阵营占比）全部由链下从事件推导 —— 不要加 totalClaims++。
contract Battlefield {
    uint16 public constant SIDE  = 50;
    uint16 public constant CELLS = 2500;

    struct Cell {
        address owner;  // 20 bytes
        uint32  heat;   //  4 bytes
        uint8   color;  //  1 byte   → 三个字段打包进同一个 slot
    }

    /// @dev 每格独占 1 个 slot：claim(id) 的写集是 cells[id]，与任何其他 id 不重叠
    Cell[CELLS] public cells;

    event Claim(uint16 indexed id, address indexed who, uint8 color, uint32 heat);

    error BadId();

    function claim(uint16 id, uint8 color) external {
        if (id >= CELLS) revert BadId();

        Cell storage c = cells[id];
        c.owner = msg.sender;
        c.color = color;

        uint32 h;
        unchecked { h = c.heat + 1; }
        c.heat = h;

        emit Claim(id, msg.sender, color, h);
    }
}
