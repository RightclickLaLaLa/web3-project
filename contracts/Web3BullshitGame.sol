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

    struct DebtNote {
        bytes32 roomId;
        address winner;
        uint256 amount;
        uint256 nonce;
        uint256 expiration;
    }

    bytes32 public constant DEBT_NOTE_TYPEHASH = keccak256(
        "DebtNote(bytes32 roomId,address winner,uint256 amount,uint256 nonce,uint256 expiration)"
    );

    bytes32 private immutable DOMAIN_SEPARATOR;
    uint256 private immutable INITIAL_CHAIN_ID;

    address public owner;
    mapping(address => uint256) public deposits;
    mapping(bytes32 => Room) private rooms;
    mapping(bytes32 => mapping(address => bool)) public isPlayerInRoom;
    mapping(bytes32 => mapping(address => mapping(uint256 => bool))) public usedNonces;
    bytes32[] public roomIds;

    event Deposit(address indexed player, uint256 amount, uint256 newBalance);
    event Withdrawal(address indexed player, uint256 amount, uint256 remainingBalance);
    event RoomCreated(bytes32 indexed roomId, address indexed host, uint256 stakeRequired);
    event PlayerJoined(bytes32 indexed roomId, address indexed player, uint256 playerCount);
    event GameStarted(bytes32 indexed roomId, bytes32 indexed deckCommitment);
    event GameFinished(bytes32 indexed roomId);
    event DebtSettled(
        bytes32 indexed roomId,
        address indexed debtor,
        address indexed winner,
        uint256 amount,
        uint256 nonce
    );
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
    error ExpiredDebtNote();
    error DebtNoteAlreadyUsed();
    error InvalidSignature();
    error TransferFailed();
    error InvalidClaim();

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
        INITIAL_CHAIN_ID = block.chainid;
        DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        require(msg.value > 0, "Deposit must be greater than zero");
        deposits[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value, deposits[msg.sender]);
    }

    function createRoom(bytes32 roomId, uint256 stakeRequired) external {
        require(roomId != bytes32(0), "Room id is required");
        require(stakeRequired > 0, "Stake is required");
        if (rooms[roomId].status != RoomStatus.None) revert RoomAlreadyExists();

        Room storage room = rooms[roomId];
        room.host = msg.sender;
        room.stakeRequired = stakeRequired;
        room.status = RoomStatus.Lobby;
        room.players.push(msg.sender);
        isPlayerInRoom[roomId][msg.sender] = true;
        roomIds.push(roomId);

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

    function startGame(bytes32 roomId, bytes32 deckCommitment)
        external
        roomExists(roomId)
        onlyHost(roomId)
        inStatus(roomId, RoomStatus.Lobby)
    {
        require(deckCommitment != bytes32(0), "Deck commitment is required");
        Room storage room = rooms[roomId];
        if (room.players.length != 4) revert InvalidPlayerCount();

        room.deckCommitment = deckCommitment;
        room.status = RoomStatus.Active;
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
        rooms[roomId].status = RoomStatus.Closed;
        emit GameFinished(roomId);
    }

    function settleFinalWinner(bytes32 roomId, address winner, uint256 amountPerLoser)
        external
        roomExists(roomId)
        onlyHost(roomId)
        inStatus(roomId, RoomStatus.Active)
    {
        if (!isPlayerInRoom[roomId][winner]) revert NotPlayer();
        require(amountPerLoser > 0, "Amount is required");

        Room storage room = rooms[roomId];
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
        inStatus(roomId, RoomStatus.Active)
    {
        if (!isPlayerInRoom[roomId][msg.sender] && msg.sender != owner) revert NotPlayer();
        if (!isPlayerInRoom[roomId][winner]) revert NotPlayer();
        require(losers.length == amounts.length, "Length mismatch");
        require(losers.length > 0, "Losers are required");

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
        rooms[roomId].status = RoomStatus.Finished;
        emit AutoFinalSettlementTriggered(roomId, winner, msg.sender, losers, amounts, totalWon);
        emit FinalPenaltiesSettled(roomId, winner, totalWon);
        emit GameFinished(roomId);
    }

    function forfeitGame(bytes32 roomId, uint256 amountPerOpponent)
        external
        roomExists(roomId)
        inStatus(roomId, RoomStatus.Active)
    {
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

    function settleDebt(DebtNote calldata note, bytes calldata signature)
        external
        roomExists(note.roomId)
    {
        RoomStatus status = rooms[note.roomId].status;
        require(status == RoomStatus.Active || status == RoomStatus.Finished, "Room is not settleable");
        require(note.winner == msg.sender, "Only winner can settle");
        require(note.amount > 0, "Amount is required");
        if (block.timestamp > note.expiration) revert ExpiredDebtNote();
        if (!isPlayerInRoom[note.roomId][note.winner]) revert NotPlayer();

        bytes32 digest = getDebtNoteDigest(note);
        address debtor = _recoverSigner(digest, signature);
        if (debtor == address(0) || debtor == note.winner) revert InvalidSignature();
        if (!isPlayerInRoom[note.roomId][debtor]) revert NotPlayer();
        if (usedNonces[note.roomId][debtor][note.nonce]) revert DebtNoteAlreadyUsed();
        if (deposits[debtor] < note.amount) revert InsufficientDeposit();

        usedNonces[note.roomId][debtor][note.nonce] = true;
        deposits[debtor] -= note.amount;
        deposits[note.winner] += note.amount;

        emit DebtSettled(note.roomId, debtor, note.winner, note.amount, note.nonce);
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
        onlyHost(roomId)
        inStatus(roomId, RoomStatus.Finished)
    {
        rooms[roomId].status = RoomStatus.Closed;
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

    function getDebtNoteDigest(DebtNote calldata note) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                DEBT_NOTE_TYPEHASH,
                note.roomId,
                note.winner,
                note.amount,
                note.nonce,
                note.expiration
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function domainSeparator() public view returns (bytes32) {
        if (block.chainid == INITIAL_CHAIN_ID) {
            return DOMAIN_SEPARATOR;
        }
        return _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Web3BullshitGame")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function _recoverSigner(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) revert InvalidSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) {
            v += 27;
        }
        if (v != 27 && v != 28) revert InvalidSignature();

        return ecrecover(digest, v, r, s);
    }
}
