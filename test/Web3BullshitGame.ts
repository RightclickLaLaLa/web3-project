import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";

describe("Web3BullshitGame", async function () {
  const { viem, networkHelpers } = await network.create();

  async function deployGame() {
    const game = await viem.deployContract("Web3BullshitGame");
    const [host, player2, player3, player4] = await viem.getWalletClients();
    return { game, host, player2, player3, player4 };
  }

  async function startedGameFixture() {
    const { game, host, player2, player3, player4 } = await networkHelpers.loadFixture(deployGame);
    const stake = 100000000000000000000n;
    const roomId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const deckCommitment = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    await game.write.deposit({ account: host.account, value: stake });
    await game.write.deposit({ account: player2.account, value: stake });
    await game.write.deposit({ account: player3.account, value: stake });
    await game.write.deposit({ account: player4.account, value: stake });

    await game.write.createRoom([roomId, stake], { account: host.account });
    await game.write.joinRoom([roomId], { account: player2.account });
    await game.write.joinRoom([roomId], { account: player3.account });
    await game.write.joinRoom([roomId], { account: player4.account });
    await game.write.startGame([roomId, deckCommitment], { account: host.account });

    return { game, host, player2, player3, player4, stake, roomId };
  }

  it("lets the host cancel a lobby room before starting", async function () {
    const { game, host, player2 } = await networkHelpers.loadFixture(deployGame);
    const stake = 100000000000000000000n;
    const roomId = "0xabababababababababababababababababababababababababababababababab";

    await game.write.deposit({ account: host.account, value: stake });
    await game.write.deposit({ account: player2.account, value: stake });
    await game.write.createRoom([roomId, stake], { account: host.account });

    await game.write.cancelLobbyRoom([roomId], { account: host.account });
    const room = await game.read.getRoom([roomId]);
    assert.equal(room[3], 4);
    assert.equal(room[4].length, 0);
    assert.equal(await game.read.isPlayerInRoom([roomId, host.account.address]), false);

    await viem.assertions.revertWithCustomError(
      game.write.joinRoom([roomId], { account: player2.account }),
      game,
      "InvalidStatus",
    );
  });

  it("allows a closed room id to be reused after disbanding", async function () {
    const { game, host } = await networkHelpers.loadFixture(deployGame);
    const stake = 100000000000000000000n;
    const roomId = "0xacacacacacacacacacacacacacacacacacacacacacacacacacacacacacacacac";

    await game.write.deposit({ account: host.account, value: stake });
    await game.write.createRoom([roomId, stake], { account: host.account });
    await game.write.cancelLobbyRoom([roomId], { account: host.account });
    await game.write.createRoom([roomId, stake], { account: host.account });

    const room = await game.read.getRoom([roomId]);
    assert.equal(room[3], 1);
    assert.deepEqual(
      room[4].map((player) => player.toLowerCase()),
      [host.account.address.toLowerCase()],
    );
    assert.equal(await game.read.isPlayerInRoom([roomId, host.account.address]), true);
  });

  it("requires the host to deposit before creating a room", async function () {
    const { game, host } = await networkHelpers.loadFixture(deployGame);
    const stake = 100000000000000000000n;
    const roomId = "0xaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae";

    await viem.assertions.revertWithCustomError(
      game.write.createRoom([roomId, stake], { account: host.account }),
      game,
      "InsufficientDeposit",
    );
  });

  it("rechecks every player's deposit before starting", async function () {
    const { game, host, player2, player3, player4 } = await networkHelpers.loadFixture(deployGame);
    const stake = 100000000000000000000n;
    const roomId = "0xafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafaf";
    const deckCommitment = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    await game.write.deposit({ account: host.account, value: stake });
    await game.write.deposit({ account: player2.account, value: stake });
    await game.write.deposit({ account: player3.account, value: stake });
    await game.write.deposit({ account: player4.account, value: stake });

    await game.write.createRoom([roomId, stake], { account: host.account });
    await game.write.joinRoom([roomId], { account: player2.account });
    await game.write.joinRoom([roomId], { account: player3.account });
    await game.write.joinRoom([roomId], { account: player4.account });
    await game.write.withdraw([1n], { account: player4.account });

    await viem.assertions.revertWithCustomError(
      game.write.startGame([roomId, deckCommitment], { account: host.account }),
      game,
      "InsufficientDeposit",
    );
  });

  it("can restart a finished room after a majority rematch vote", async function () {
    const { game, host, player2, player3, roomId } = await startedGameFixture();
    const nextDeckCommitment = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    await game.write.finishGame([roomId], { account: host.account });
    await game.write.voteRematch([roomId, true], { account: host.account });
    await game.write.voteRematch([roomId, true], { account: player2.account });
    await game.write.voteRematch([roomId, true], { account: player3.account });

    assert.equal(await game.read.rematchVoteCount([roomId]), 3n);
    await game.write.startGame([roomId, nextDeckCommitment], { account: host.account });
    const room = await game.read.getRoom([roomId]);
    assert.equal(room[3], 2);
    assert.equal(await game.read.rematchVoteCount([roomId]), 0n);
  });

  it("requires a majority rematch vote before restarting a finished room", async function () {
    const { game, host, roomId } = await startedGameFixture();
    const nextDeckCommitment = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

    await game.write.finishGame([roomId], { account: host.account });
    await game.write.voteRematch([roomId, true], { account: host.account });

    await viem.assertions.revertWithCustomError(
      game.write.startGame([roomId, nextDeckCommitment], { account: host.account }),
      game,
      "RematchNotApproved",
    );
  });

  it("closes a finished room when the rematch vote expires without majority", async function () {
    const { game, host, player2, roomId } = await startedGameFixture();

    await game.write.finishGame([roomId], { account: host.account });
    await game.write.voteRematch([roomId, true], { account: host.account });
    await networkHelpers.time.increase(31);

    await game.write.closeExpiredRematch([roomId], { account: host.account });
    const room = await game.read.getRoom([roomId]);
    assert.equal(room[3], 4);
    assert.equal(room[4].length, 0);
    assert.equal(await game.read.isPlayerInRoom([roomId, host.account.address]), false);
    assert.equal(await game.read.isPlayerInRoom([roomId, player2.account.address]), false);
  });

  it("removes all players when closing a finished room", async function () {
    const { game, host, player2, roomId } = await networkHelpers.loadFixture(startedGameFixture);

    await game.write.finishGame([roomId], { account: host.account });
    await game.write.closeFinishedRoom([roomId], { account: host.account });

    const room = await game.read.getRoom([roomId]);
    assert.equal(room[3], 4);
    assert.equal(room[4].length, 0);
    assert.equal(await game.read.isPlayerInRoom([roomId, host.account.address]), false);
    assert.equal(await game.read.isPlayerInRoom([roomId, player2.account.address]), false);
  });

  it("rejects rematch votes after the 30 second window", async function () {
    const { game, host, player2, roomId } = await startedGameFixture();

    await game.write.finishGame([roomId], { account: host.account });
    await game.write.voteRematch([roomId, true], { account: host.account });
    await networkHelpers.time.increase(31);

    await assert.rejects(
      game.write.voteRematch([roomId, true], { account: player2.account }),
      /Rematch window closed/,
    );
  });

  it("prevents the host from cancelling an active room", async function () {
    const { game, host, roomId } = await startedGameFixture();

    await viem.assertions.revertWithCustomError(
      game.write.cancelLobbyRoom([roomId], { account: host.account }),
      game,
      "InvalidStatus",
    );
  });

  it("lets the host remove a non-host player from a lobby room", async function () {
    const { game, host, player2, player3 } = await networkHelpers.loadFixture(deployGame);
    const stake = 100000000000000000000n;
    const roomId = "0xacacacacacacacacacacacacacacacacacacacacacacacacacacacacacacacac";

    await game.write.deposit({ account: host.account, value: stake });
    await game.write.deposit({ account: player2.account, value: stake });
    await game.write.deposit({ account: player3.account, value: stake });
    await game.write.createRoom([roomId, stake], { account: host.account });
    await game.write.joinRoom([roomId], { account: player2.account });
    await game.write.joinRoom([roomId], { account: player3.account });

    await game.write.removeLobbyPlayer([roomId, player2.account.address], { account: host.account });
    const room = await game.read.getRoom([roomId]);
    assert.equal(room[4].length, 2);
    assert.equal(room[4].some((player) => player.toLowerCase() === player2.account.address.toLowerCase()), false);

    await viem.assertions.revertWithCustomError(
      game.write.removeLobbyPlayer([roomId, host.account.address], { account: host.account }),
      game,
      "Unauthorized",
    );
  });

  it("lets the host remove a non-host player from a finished room", async function () {
    const { game, host, player2, player3, roomId } = await startedGameFixture();

    await game.write.finishGame([roomId], { account: host.account });
    await game.write.voteRematch([roomId, true], { account: player2.account });
    await game.write.voteRematch([roomId, true], { account: player3.account });

    assert.equal(await game.read.rematchVoteCount([roomId]), 2n);
    await game.write.removeLobbyPlayer([roomId, player2.account.address], { account: host.account });

    const room = await game.read.getRoom([roomId]);
    assert.equal(room[3], 3);
    assert.equal(room[4].length, 3);
    assert.equal(room[4].some((player) => player.toLowerCase() === player2.account.address.toLowerCase()), false);
    assert.equal(await game.read.rematchVotes([roomId, player2.account.address]), false);
    assert.equal(await game.read.rematchVoteCount([roomId]), 1n);
  });

  it("lets the owner remove a lobby player for relayed bot management", async function () {
    const { game, host, player2 } = await networkHelpers.loadFixture(deployGame);
    const stake = 100000000000000000000n;
    const roomId = "0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";

    await game.write.deposit({ account: host.account, value: stake });
    await game.write.deposit({ account: player2.account, value: stake });
    await game.write.createRoom([roomId, stake], { account: player2.account });
    await game.write.joinRoom([roomId], { account: host.account });

    await game.write.removeLobbyPlayer([roomId, host.account.address], { account: host.account });
    const room = await game.read.getRoom([roomId]);
    assert.equal(room[4].length, 1);
    assert.equal(room[4][0].toLowerCase(), player2.account.address.toLowerCase());
  });

  it("lets a non-host player leave a lobby room", async function () {
    const { game, host, player2 } = await networkHelpers.loadFixture(deployGame);
    const stake = 100000000000000000000n;
    const roomId = "0xadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadad";

    await game.write.deposit({ account: host.account, value: stake });
    await game.write.deposit({ account: player2.account, value: stake });
    await game.write.createRoom([roomId, stake], { account: host.account });
    await game.write.joinRoom([roomId], { account: player2.account });

    await game.write.leaveLobbyRoom([roomId], { account: player2.account });
    const room = await game.read.getRoom([roomId]);
    assert.equal(room[4].length, 1);
    assert.equal(room[4][0].toLowerCase(), host.account.address.toLowerCase());

    await viem.assertions.revertWithCustomError(
      game.write.leaveLobbyRoom([roomId], { account: host.account }),
      game,
      "Unauthorized",
    );
  });

  it("settles a failed bluff challenge on-chain without loser signature", async function () {
    const { game, host, player2, stake, roomId } = await startedGameFixture();
    const amount = 50000000000000000n;
    const claimRank = 0; // A
    const actualRanks = [0, 5, 13]; // A, 6, joker -> bluff because 6 is not A

    await game.write.settleChallenge(
      [roomId, player2.account.address, claimRank, actualRanks, amount],
      { account: host.account }
    );

    assert.equal(await game.read.deposits([host.account.address]), stake + amount);
    assert.equal(await game.read.deposits([player2.account.address]), stake - amount);
  });

  it("charges the challenger when the claim is honest", async function () {
    const { game, host, player2, stake, roomId } = await startedGameFixture();
    const amount = 50000000000000000n;
    const claimRank = 0; // A
    const actualRanks = [0, 13]; // A, joker -> honest

    await game.write.settleChallenge(
      [roomId, player2.account.address, claimRank, actualRanks, amount],
      { account: host.account }
    );

    assert.equal(await game.read.deposits([host.account.address]), stake - amount);
    assert.equal(await game.read.deposits([player2.account.address]), stake + amount);
  });

  it("settles only once at game end by charging the three losers", async function () {
    const { game, host, player2, player3, player4, stake, roomId } = await startedGameFixture();
    const amountPerLoser = 50000000000000000n;

    await game.write.settleFinalWinner(
      [roomId, player4.account.address, amountPerLoser],
      { account: host.account }
    );

    assert.equal(await game.read.deposits([player4.account.address]), stake + amountPerLoser * 3n);
    assert.equal(await game.read.deposits([host.account.address]), stake - amountPerLoser);
    assert.equal(await game.read.deposits([player2.account.address]), stake - amountPerLoser);
    assert.equal(await game.read.deposits([player3.account.address]), stake - amountPerLoser);
  });

  it("settles final penalties with different remaining-card amounts", async function () {
    const { game, host, player2, player3, player4, stake, roomId } = await startedGameFixture();
    const amounts = [
      1000000000000000000n,
      3000000000000000000n,
      7000000000000000000n
    ];

    await game.write.settleFinalPenalties(
      [
        roomId,
        player4.account.address,
        [host.account.address, player2.account.address, player3.account.address],
        amounts
      ],
      { account: host.account }
    );

    const events = await game.getEvents.AutoFinalSettlementTriggered();
    assert.equal(events.length, 1);
    assert.equal(events[0].args.roomId, roomId);
    assert.equal(events[0].args.winner?.toLowerCase(), player4.account.address.toLowerCase());
    assert.equal(events[0].args.submitter?.toLowerCase(), host.account.address.toLowerCase());
    assert.deepEqual(
      events[0].args.losers?.map((address) => address.toLowerCase()),
      [host.account.address, player2.account.address, player3.account.address].map((address) => address.toLowerCase())
    );
    assert.deepEqual(events[0].args.amounts, amounts);
    assert.equal(events[0].args.totalWon, 11000000000000000000n);

    assert.equal(await game.read.deposits([player4.account.address]), stake + 11000000000000000000n);
    assert.equal(await game.read.deposits([host.account.address]), stake - amounts[0]);
    assert.equal(await game.read.deposits([player2.account.address]), stake - amounts[1]);
    assert.equal(await game.read.deposits([player3.account.address]), stake - amounts[2]);
  });

  it("marks the current room epoch as settled to guard against replayed settlement", async function () {
    const { game, host, player2, player3, player4, roomId } = await startedGameFixture();
    const amounts = [
      1000000000000000000n,
      2000000000000000000n,
      3000000000000000000n
    ];

    assert.equal(await game.read.roomEpoch([roomId]), 1n);
    assert.equal(await game.read.settledEpochs([roomId, 1n]), false);

    await game.write.settleFinalPenalties(
      [
        roomId,
        player4.account.address,
        [host.account.address, player2.account.address, player3.account.address],
        amounts
      ],
      { account: host.account }
    );

    assert.equal(await game.read.settledEpochs([roomId, 1n]), true);

    await viem.assertions.revertWithCustomError(
      game.write.settleFinalPenalties(
        [
          roomId,
          player4.account.address,
          [host.account.address, player2.account.address, player3.account.address],
          amounts
        ],
        { account: player2.account }
      ),
      game,
      "SettlementAlreadyExecuted",
    );
  });

  it("allows any room player to submit final penalties", async function () {
    const { game, host, player2, player3, player4, stake, roomId } = await startedGameFixture();
    const amounts = [
      1000000000000000000n,
      2000000000000000000n,
      4000000000000000000n
    ];

    await game.write.settleFinalPenalties(
      [
        roomId,
        player4.account.address,
        [host.account.address, player2.account.address, player3.account.address],
        amounts
      ],
      { account: player2.account }
    );

    assert.equal(await game.read.deposits([player4.account.address]), stake + 7000000000000000000n);
    assert.equal(await game.read.deposits([host.account.address]), stake - amounts[0]);
    assert.equal(await game.read.deposits([player2.account.address]), stake - amounts[1]);
    assert.equal(await game.read.deposits([player3.account.address]), stake - amounts[2]);
  });

  it("penalizes a player who forfeits during an active game", async function () {
    const { game, host, player2, player3, player4, stake, roomId } = await startedGameFixture();
    const amountPerOpponent = 50000000000000000n;

    await game.write.forfeitGame(
      [roomId, amountPerOpponent],
      { account: player2.account }
    );

    assert.equal(await game.read.deposits([player2.account.address]), stake - amountPerOpponent * 3n);
    assert.equal(await game.read.deposits([host.account.address]), stake + amountPerOpponent);
    assert.equal(await game.read.deposits([player3.account.address]), stake + amountPerOpponent);
    assert.equal(await game.read.deposits([player4.account.address]), stake + amountPerOpponent);
  });
});

