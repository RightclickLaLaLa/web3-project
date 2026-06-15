import { network } from "hardhat";

const { viem } = await network.create();

const game = await viem.deployContract("Web3BullshitGame");

console.log(`Web3BullshitGame deployed to: ${game.address}`);
