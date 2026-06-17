// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract Web3BullshitGame {
    enum RoomStatus {
        None,
        Lobby,
        Active,
        Finished,
        Closed
    }

    struct Room {
        address host;
        uint256 stakeRequired;
        bytes32 deckCommitment;
        RoomStatus status;
        address[] players;
    }

    uint256 public constant REMATCH_WINDOW_SECONDS = 30;

    address public owner;
    mapping(address => uint256) public deposits;
    mapping(bytes32 => Room) private rooms;
    mapping(bytes32 => mapping(address => bool)) public isPlayerInRoom;
    mapping(bytes32 => mapping(address => bool)) public rematchVotes;
    mapping(bytes32 => uint256) public rematchVoteCount;
    mapping(bytes32 => uint256) public rematchVoteStartedAt;
    mapping(bytes32 => uint256) public roomEpoch;
    mapping(bytes32 => mapping(uint256 => bool)) public settledEpochs;
    bytes32[] public roomIds;

    event Deposit(address indexed player, uint256 amount, uint256 newBalance);
    event Withdrawal(address indexed player, uint256 amount, uint256 remainingBalance);
    event RoomCreated(bytes32 indexed roomId, address indexed host, uint256 stakeRequired);
    event PlayerJoined(bytes32 indexed roomId, address indexed player, uint256 playerCount);
    event PlayerRemoved(bytes32 indexed roomId, address indexed player, uint256 playerCount);
    event RematchVoted(bytes32 indexed roomId, address indexed player, bool approve, uint256 yesVotes);
    event RematchExpired(bytes32 indexed roomId, uint256 yesVotes);
    event GameStarted(bytes32 indexed roomId, bytes32 indexed deckCommitment);
    event GameFinished(bytes32 indexed roomId);
    event ChallengeSettled(
        bytes32 indexed roomId,
        address indexed loser,
        address indexed winner,
        address challenger,
        address actor,
        bool claimWasHonest,
        uint256 amount
    );
    event FinalWinnerSettled(
        bytes32 indexed roomId,
        address indexed winner,
        uint256 amountPerLoser,
        uint256 totalWon
    );
    event FinalPenaltiesSettled(
        bytes32 indexed roomId,
        address indexed winner,
        uint256 totalWon
    );
    event AutoFinalSettlementTriggered(
        bytes32 indexed roomId,
        address indexed winner,
        address indexed submitter,
        address[] losers,
        uint256[] amounts,
        uint256 totalWon
    );
    event PlayerForfeited(
        bytes32 indexed roomId,
        address indexed quitter,
        uint256 amountPerOpponent,
        uint256 totalPenalty
    );

    error Unauthorized();
    error InvalidStatus(RoomStatus expected, RoomStatus actual);
    error RoomAlreadyExists();
    error RoomNotFound();
    error AlreadyJoined();
    error NotPlayer();
    error InsufficientDeposit();
    error InvalidPlayerCount();
    error TransferFailed();
    error InvalidClaim();
    error RematchNotApproved();
    error SettlementAlreadyExecuted();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier roomExists(bytes32 roomId) {
        if (rooms[roomId].status == RoomStatus.None) revert RoomNotFound();
        _;
    }

    modifier onlyHost(bytes32 roomId) {
        if (rooms[roomId].host != msg.sender) revert Unauthorized();
        _;
    }

    modifier inStatus(bytes32 roomId, RoomStatus status) {
        if (rooms[roomId].status != status) revert InvalidStatus(status, rooms[roomId].status);
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {
        deposit();
    }

    function _closeRoomAndRemovePlayers(bytes32 roomId) internal {
        Room storage room = rooms[roomId];
        uint256 remaining = room.players.length;

        while (remaining > 0) {
            address player = room.players[remaining - 1];
            room.players.pop();
            remaining -= 1;
            isPlayerInRoom[roomId][player] = false;
            if (rematchVotes[roomId][player]) {
                rematchVotes[roomId][player] = false;
            }
            emit PlayerRemoved(roomId, player, remaining);
        }

        rematchVoteCount[roomId] = 0;
        rematchVoteStartedAt[roomId] = 0;
        room.status = RoomStatus.Closed;
    }

    function deposit() public payable {
        require(msg.value > 0, "Deposit must be greater than zero");
        deposits[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value, deposits[msg.sender]);
    }

    function createRoom(bytes32 roomId, uint256 stakeRequired) external {
        require(roomId != bytes32(0), "Room id is required");
        require(stakeRequired > 0, "Stake is required");
        RoomStatus previousStatus = rooms[roomId].status;
        if (previousStatus != RoomStatus.None && previousStatus != RoomStatus.Closed) revert RoomAlreadyExists();
        if (deposits[msg.sender] < stakeRequired) revert InsufficientDeposit();

        Room storage room = rooms[roomId];
        room.host = msg.sender;
        room.stakeRequired = stakeRequired;
        room.deckCommitment = bytes32(0);
        room.status = RoomStatus.Lobby;
        room.players.push(msg.sender);
        isPlayerInRoom[roomId][msg.sender] = true;
        if (previousStatus == RoomStatus.None) {
            roomIds.push(roomId);
        }

        emit RoomCreated(roomId, msg.sender, stakeRequired);
        emit PlayerJoined(roomId, msg.sender, 1);
    }

    function joinRoom(bytes32 roomId)
        external
        roomExists(roomId)
        inStatus(roomId, RoomStatus.Lobby)
    {
        Room storage room = rooms[roomId];
        if (isPlayerInRoom[roomId][msg.sender]) revert AlreadyJoined();
        if (deposits[msg.sender] < room.stakeRequired) revert InsufficientDeposit();
        if (room.players.length >= 4) revert InvalidPlayerCount();

        room.players.push(msg.sender);
        isPlayerInRoom[roomId][msg.sender] = true;
        emit PlayerJoined(roomId, msg.sender, room.players.length);
    }

    function removeLobbyPlayer(bytes32 roomId, address player)
        external
        roomExists(roomId)
    {
        Room storage room = rooms[roomId];
        if (room.status != RoomStatus.Lobby && room.status != RoomStatus.Finished) {
            revert InvalidStatus(RoomStatus.Lobby, room.status);
        }
        if (msg.sender != room.host && msg.sender != owner) revert Unauthorized();
        if (player == room.host) revert Unauthorized();
        if (!isPlayerInRoom[roomId][player]) revert NotPlayer();

        uint256 index = room.players.length;
        for (uint256 i = 0; i < room.players.length; i++) {
            if (room.players[i] == player) {
                index = i;
                break;
            }
        }
        if (index == room.players.length) revert NotPlayer();

        room.players[index] = room.players[room.players.length - 1];
        room.players.pop();
        isPlayerInRoom[roomId][player] = false;
        if (rematchVotes[roomId][player]) {
            rematchVotes[roomId][player] = false;
            rematchVoteCount[roomId] -= 1;
            if (rematchVoteCount[roomId] == 0) {
                rematchVoteStartedAt[roomId] = 0;
            }
        }
        emit PlayerRemoved(roomId, player, room.players.length);
    }

    function voteRematch(bytes32 roomId, bool approve)
        external
        roomExists(roomId)
        inStatus(roomId, RoomStatus.Finished)
    {
        if (!isPlayerInRoom[roomId][msg.sender]) revert NotPlayer();

        bool previous = rematchVotes[roomId][msg.sender];
        if (previous == approve) {
            emit RematchVoted(roomId, msg.sender, approve, rematchVoteCount[roomId]);
            return;
        }

        uint256 startedAt = rematchVoteStartedAt[roomId];
        if (startedAt > 0) {
            require(block.timestamp < startedAt + REMATCH_WINDOW_SECONDS, "Rematch window closed");
        }

        rematchVotes[roomId][msg.sender] = approve;
        if (approve) {
            if (rematchVoteStartedAt[roomId] == 0) {
                rematchVoteStartedAt[roomId] = block.timestamp;
            }
            rematchVoteCount[roomId] += 1;
        } else {
            rematchVoteCount[roomId] -= 1;
            if (rematchVoteCount[roomId] == 0) {
                rematchVoteStartedAt[roomId] = 0;
            }
        }
        emit RematchVoted(roomId, msg.sender, approve, rematchVoteCount[roomId]);
    }

    function leaveLobbyRoom(bytes32 roomId)
        external
        roomExists(roomId)
        inStatus(roomId, RoomStatus.Lobby)
    {
        Room storage room = rooms[roomId];
        if (msg.sender == room.host) revert Unauthorized();
        if (!isPlayerInRoom[roomId][msg.sender]) revert NotPlayer();

        uint256 index = room.players.length;
        for (uint256 i = 0; i < room.players.length; i++) {
            if (room.players[i] == msg.sender) {
                index = i;
                break;
            }
        }
        if (index == room.players.length) revert NotPlayer();

        room.players[index] = room.players[room.players.length - 1];
        room.players.pop();
        isPlayerInRoom[roomId][msg.sender] = false;
        emit PlayerRemoved(roomId, msg.sender, room.players.length);
    }

    function startGame(bytes32 roomId, bytes32 deckCommitment)
        external
        roomExists(roomId)
        onlyHost(roomId)
    {
        require(deckCommitment != bytes32(0), "Deck commitment is required");
        Room storage room = rooms[roomId];
        if (room.status != RoomStatus.Lobby && room.status != RoomStatus.Finished) {
            revert InvalidStatus(RoomStatus.Lobby, room.status);
        }
        if (room.players.length != 4) revert InvalidPlayerCount();
        if (room.status == RoomStatus.Finished && rematchVoteCount[roomId] * 2 <= room.players.length) {
            revert RematchNotApproved();
        }
        for (uint256 i = 0; i < room.players.length; i++) {
            address player = room.players[i];
            if (deposits[player] < room.stakeRequired) revert InsufficientDeposit();
        }

        room.deckCommitment = deckCommitment;
        roomEpoch[roomId] += 1;
        room.status = RoomStatus.Active;
        for (uint256 i = 0; i < room.players.length; i++) {
            address player = room.players[i];
            if (rematchVotes[roomId][player]) {
                rematchVotes[roomId][player] = false;
            }
        }
        rematchVoteCount[roomId] = 0;
        rematchVoteStartedAt[roomId] = 0;
        emit GameStarted(roomId, deckCommitment);
    }

    function finishGame(bytes32 roomId)
        external
        roomExists(roomId)
        onlyHost(roomId)
        inStatus(roomId, RoomStatus.Active)
    {
        rooms[roomId].status = RoomStatus.Finished;
        emit GameFinished(roomId);
    }

    function cancelLobbyRoom(bytes32 roomId)
        external
        roomExists(roomId)
        onlyHost(roomId)
        inStatus(roomId, RoomStatus.Lobby)
    {
        _closeRoomAndRemovePlayers(roomId);
        emit GameFinished(roomId);
    }

    function settleFinalWinner(bytes32 roomId, address winner, uint256 amountPerLoser)
        external
        roomExists(roomId)
        onlyHost(roomId)
    {
        Room storage room = rooms[roomId];
        if (room.status != RoomStatus.Active && room.status != RoomStatus.Finished) {
            revert InvalidStatus(RoomStatus.Active, room.status);
        }
        _markCurrentEpochSettled(roomId);
        if (!isPlayerInRoom[roomId][winner]) revert NotPlayer();
        require(amountPerLoser > 0, "Amount is required");

        uint256 totalWon = 0;
        for (uint256 i = 0; i < room.players.length; i++) {
            address loser = room.players[i];
            if (loser == winner) {
                continue;
            }
            if (deposits[loser] < amountPerLoser) revert InsufficientDeposit();
            deposits[loser] -= amountPerLoser;
            totalWon += amountPerLoser;
        }

        deposits[winner] += totalWon;
        room.status = RoomStatus.Finished;
        emit FinalWinnerSettled(roomId, winner, amountPerLoser, totalWon);
        emit GameFinished(roomId);
    }

    function settleFinalPenalties(
        bytes32 roomId,
        address winner,
        address[] calldata losers,
        uint256[] calldata amounts
    )
        external
        roomExists(roomId)
    {
        Room storage room = rooms[roomId];
        if (room.status != RoomStatus.Active && room.status != RoomStatus.Finished) {
            revert InvalidStatus(RoomStatus.Active, room.status);
        }
        if (!isPlayerInRoom[roomId][msg.sender] && msg.sender != owner) revert NotPlayer();
        if (!isPlayerInRoom[roomId][winner]) revert NotPlayer();
        require(losers.length == amounts.length, "Length mismatch");
        require(losers.length > 0, "Losers are required");
        _markCurrentEpochSettled(roomId);

        uint256 totalWon = 0;
        for (uint256 i = 0; i < losers.length; i++) {
            address loser = losers[i];
            uint256 amount = amounts[i];
            if (!isPlayerInRoom[roomId][loser] || loser == winner) revert NotPlayer();
            require(amount > 0, "Amount is required");
            if (deposits[loser] < amount) revert InsufficientDeposit();
            deposits[loser] -= amount;
            totalWon += amount;
        }

        deposits[winner] += totalWon;
        room.status = RoomStatus.Finished;
        emit AutoFinalSettlementTriggered(roomId, winner, msg.sender, losers, amounts, totalWon);
        emit FinalPenaltiesSettled(roomId, winner, totalWon);
        emit GameFinished(roomId);
    }

    function forfeitGame(bytes32 roomId, uint256 amountPerOpponent)
        external
        roomExists(roomId)
        inStatus(roomId, RoomStatus.Active)
    {
        _markCurrentEpochSettled(roomId);
        if (!isPlayerInRoom[roomId][msg.sender]) revert NotPlayer();
        require(amountPerOpponent > 0, "Amount is required");

        Room storage room = rooms[roomId];
        uint256 totalPenalty = amountPerOpponent * (room.players.length - 1);
        if (deposits[msg.sender] < totalPenalty) revert InsufficientDeposit();

        deposits[msg.sender] -= totalPenalty;
        for (uint256 i = 0; i < room.players.length; i++) {
            address opponent = room.players[i];
            if (opponent != msg.sender) {
                deposits[opponent] += amountPerOpponent;
            }
        }

        room.status = RoomStatus.Finished;
        emit PlayerForfeited(roomId, msg.sender, amountPerOpponent, totalPenalty);
        emit GameFinished(roomId);
    }

    function settleChallenge(
        bytes32 roomId,
        address actor,
        uint8 claimRank,
        uint8[] calldata actualRanks,
        uint256 amount
    ) external roomExists(roomId) inStatus(roomId, RoomStatus.Active) {
        if (!isPlayerInRoom[roomId][msg.sender] || !isPlayerInRoom[roomId][actor]) revert NotPlayer();
        if (actor == msg.sender) revert InvalidClaim();
        if (claimRank > 12 || actualRanks.length == 0 || actualRanks.length > 6) revert InvalidClaim();
        require(amount > 0, "Amount is required");

        bool claimWasHonest = true;
        for (uint256 i = 0; i < actualRanks.length; i++) {
            uint8 rank = actualRanks[i];
            if (rank > 13) revert InvalidClaim();
            if (rank != claimRank && rank != 13) {
                claimWasHonest = false;
            }
        }

        address loser = claimWasHonest ? msg.sender : actor;
        address winner = claimWasHonest ? actor : msg.sender;
        if (deposits[loser] < amount) revert InsufficientDeposit();

        deposits[loser] -= amount;
        deposits[winner] += amount;

        emit ChallengeSettled(
            roomId,
            loser,
            winner,
            msg.sender,
            actor,
            claimWasHonest,
            amount
        );
    }

    function withdraw(uint256 amount) external {
        require(amount > 0, "Amount is required");
        if (deposits[msg.sender] < amount) revert InsufficientDeposit();

        deposits[msg.sender] -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawal(msg.sender, amount, deposits[msg.sender]);
    }

    function closeFinishedRoom(bytes32 roomId)
        external
        roomExists(roomId)
        inStatus(roomId, RoomStatus.Finished)
    {
        Room storage room = rooms[roomId];
        if (msg.sender != room.host && msg.sender != owner) revert Unauthorized();
        _closeRoomAndRemovePlayers(roomId);
        emit GameFinished(roomId);
    }

    function closeExpiredRematch(bytes32 roomId)
        external
        roomExists(roomId)
        inStatus(roomId, RoomStatus.Finished)
    {
        Room storage room = rooms[roomId];
        uint256 startedAt = rematchVoteStartedAt[roomId];
        require(startedAt > 0, "Rematch was not started");
        require(block.timestamp >= startedAt + REMATCH_WINDOW_SECONDS, "Rematch window is open");
        if (rematchVoteCount[roomId] * 2 > room.players.length) revert RematchNotApproved();

        uint256 yesVotes = rematchVoteCount[roomId];
        _closeRoomAndRemovePlayers(roomId);
        emit RematchExpired(roomId, yesVotes);
        emit GameFinished(roomId);
    }

    function _markCurrentEpochSettled(bytes32 roomId) private {
        uint256 epoch = roomEpoch[roomId];
        if (settledEpochs[roomId][epoch]) revert SettlementAlreadyExecuted();
        settledEpochs[roomId][epoch] = true;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Owner is required");
        owner = newOwner;
    }

    function getRoom(bytes32 roomId)
        external
        view
        roomExists(roomId)
        returns (
            address host,
            uint256 stakeRequired,
            bytes32 deckCommitment,
            RoomStatus status,
            address[] memory players
        )
    {
        Room storage room = rooms[roomId];
        return (room.host, room.stakeRequired, room.deckCommitment, room.status, room.players);
    }

    function roomCount() external view returns (uint256) {
        return roomIds.length;
    }

}
