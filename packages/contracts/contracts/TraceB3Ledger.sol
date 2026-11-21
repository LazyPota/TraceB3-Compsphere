// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title TraceB3Ledger
 * @notice Minimal, append-only on-chain custody anchor for TRACEB3 Digital Waste Passports.
 * @dev Stores cryptographic event commitments, custody transitions, and authoritative timestamps
 *      to provide a shared, tamper-evident audit trail without storing PII on-chain.
 *      Supports gasless meta-transactions via EIP-712 typed signatures and per-actor nonces.
 */
contract TraceB3Ledger is AccessControl, EIP712, Nonces, Pausable {
    /// @notice Role permitted to register and revoke operational custody actors.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    /// @notice EIP-712 typehash matching @traceb3/core CustodyIntent schema.
    bytes32 public constant CUSTODY_INTENT_TYPEHASH = keccak256(
        "CustodyIntent(bytes32 batchId,uint8 eventType,bytes32 eventHash,bytes32 prevHash,uint32 targetSeq,address actor,uint256 nonce,uint64 deadline)"
    );

    /// @notice Operational role assigned to an organization member wallet.
    enum ActorRole {
        NONE,
        GENERATOR,
        TRANSPORTER,
        FACILITY
    }

    /// @notice Lifecycle status of an anchored waste batch.
    enum BatchStatus {
        NONE,
        REGISTERED,
        IN_TRANSIT,
        RECEIVED,
        TREATED
    }

    /// @notice Custody event classification matching @traceb3/core EventType enum.
    enum EventType {
        CREATED,
        CUSTODY_TRANSFERRED,
        REVISION,
        TREATMENT
    }

    /// @notice Signed EIP-712 payload authorizing a single custody event anchor.
    struct CustodyIntent {
        bytes32 batchId;
        EventType eventType;
        bytes32 eventHash;
        bytes32 prevHash;
        uint32 targetSeq;
        address actor;
        uint256 nonce;
        uint64 deadline;
    }

    /// @notice On-chain authorization record for an operational actor wallet.
    struct ActorInfo {
        ActorRole role;
        bytes32 orgId;
        bool active;
    }

    /// @notice Immutable record of a single anchored custody event (1-based sequence).
    struct AnchoredEvent {
        uint32 seq;
        EventType eventType;
        bytes32 eventHash;
        bytes32 prevHash;
        uint32 targetSeq;
        address actor;
        bytes32 orgId;
        uint64 timestamp;
    }

    /// @notice Current custody state header for an anchored waste batch.
    struct BatchHeader {
        bool exists;
        BatchStatus status;
        bytes32 headHash;
        bytes32 currentCustodianOrgId;
        uint32 eventCount;
    }

    mapping(address wallet => ActorInfo info) private _actors;
    mapping(bytes32 batchId => BatchHeader header) private _batches;
    mapping(bytes32 batchId => AnchoredEvent[] events) private _batchEvents;

    /// @notice Emitted when an actor wallet is registered or updated.
    event ActorRegistered(
        address indexed wallet,
        ActorRole indexed role,
        bytes32 indexed orgId
    );

    /// @notice Emitted when an actor wallet is revoked.
    event ActorRevoked(address indexed wallet, bytes32 indexed orgId);

    /// @notice Emitted when a new waste batch is created and anchored.
    event BatchCreated(
        bytes32 indexed batchId,
        uint32 seq,
        bytes32 indexed eventHash,
        address indexed actor,
        bytes32 orgId,
        uint64 timestamp
    );

    /// @notice Emitted when custody of a batch transfers to a new organization.
    event CustodyTransferred(
        bytes32 indexed batchId,
        uint32 seq,
        bytes32 indexed eventHash,
        BatchStatus newStatus,
        address indexed actor,
        bytes32 fromOrgId,
        bytes32 toOrgId,
        uint64 timestamp
    );

    /// @notice Emitted when an organization anchors an append-only revision for an earlier event.
    event RevisionCreated(
        bytes32 indexed batchId,
        uint32 seq,
        uint32 targetSeq,
        bytes32 indexed eventHash,
        address indexed actor,
        bytes32 orgId,
        uint64 timestamp
    );

    /// @notice Emitted when the receiving facility records final batch treatment.
    event TreatmentRecorded(
        bytes32 indexed batchId,
        uint32 seq,
        bytes32 indexed eventHash,
        address indexed actor,
        bytes32 orgId,
        uint64 timestamp
    );

    /// @notice Thrown when a required address argument is the zero address.
    error ZeroAddress();

    /// @notice Thrown when an organization identifier is zero.
    error InvalidOrgId();

    /// @notice Thrown when an actor role is invalid or unauthorized for an operation.
    error InvalidActorRole(ActorRole role);

    /// @notice Thrown when caller holds neither DEFAULT_ADMIN_ROLE nor REGISTRAR_ROLE.
    error UnauthorizedRegistrar(address caller);

    /// @notice Thrown when an actor wallet is not registered or has been revoked.
    error ActorNotActive(address actor);

    /// @notice Thrown when batchId in an intent is zero.
    error ZeroBatchId();

    /// @notice Thrown when eventHash in an intent is zero.
    error ZeroEventHash();

    /// @notice Thrown when the intent deadline has passed.
    error IntentExpired(uint64 deadline, uint256 currentTimestamp);

    /// @notice Thrown when intent.eventType does not match the called function.
    error InvalidEventType(EventType expected, EventType actual);

    /// @notice Thrown when EIP-712 signature verification fails or recovers a different signer.
    error InvalidSignature();

    /// @notice Thrown when creating a batch whose batchId already exists.
    error BatchAlreadyExists(bytes32 batchId);

    /// @notice Thrown when referencing a batchId that has not been created.
    error BatchNotFound(bytes32 batchId);

    /// @notice Thrown when intent.prevHash does not match the expected chain head hash.
    error InvalidPrevHash(bytes32 expected, bytes32 actual);

    /// @notice Thrown when a 1-based sequence number or targetSeq is invalid or out of range.
    error InvalidTargetSeq(uint32 targetSeq);

    /// @notice Thrown when the batch's current status does not permit the requested transition.
    error InvalidBatchStatus(BatchStatus currentStatus);

    /// @notice Thrown when a custody transfer targets the organization already holding custody.
    error SameOrganizationTransfer(bytes32 orgId);

    /// @notice Thrown when a revision targets another REVISION event instead of a base event.
    error CannotReviseRevision(uint32 targetSeq);

    /// @notice Thrown when the actor's organization does not match the required organization.
    error OrganizationMismatch(bytes32 expectedOrgId, bytes32 actualOrgId);

    modifier onlyRegistrarOrAdmin() {
        address caller = _msgSender();
        if (!hasRole(DEFAULT_ADMIN_ROLE, caller) && !hasRole(REGISTRAR_ROLE, caller)) {
            revert UnauthorizedRegistrar(caller);
        }
        _;
    }

    /**
     * @notice Initializes TraceB3Ledger with admin and registrar role holders.
     * @param admin Address granted DEFAULT_ADMIN_ROLE (manages roles and emergency pause).
     * @param registrar Address granted REGISTRAR_ROLE (manages operational actor wallets).
     */
    constructor(address admin, address registrar) EIP712("TraceB3Ledger", "1") {
        if (admin == address(0) || registrar == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, registrar);
    }

    /**
     * @notice Registers or updates an active operational actor wallet for an organization.
     * @param wallet Actor EVM address that will sign CustodyIntent messages.
     * @param role Operational role (GENERATOR, TRANSPORTER, or FACILITY).
     * @param orgId Keccak256 hash of the organization's UUID.
     */
    function registerActor(
        address wallet,
        ActorRole role,
        bytes32 orgId
    ) external onlyRegistrarOrAdmin {
        if (wallet == address(0)) {
            revert ZeroAddress();
        }
        if (role == ActorRole.NONE) {
            revert InvalidActorRole(role);
        }
        if (orgId == bytes32(0)) {
            revert InvalidOrgId();
        }

        _actors[wallet] = ActorInfo({role: role, orgId: orgId, active: true});
        emit ActorRegistered(wallet, role, orgId);
    }

    /**
     * @notice Revokes an active actor wallet, preventing future custody signatures.
     * @param wallet Actor EVM address to revoke.
     */
    function revokeActor(address wallet) external onlyRegistrarOrAdmin {
        if (wallet == address(0)) {
            revert ZeroAddress();
        }
        ActorInfo storage actorInfo = _actors[wallet];
        if (!actorInfo.active) {
            revert ActorNotActive(wallet);
        }

        actorInfo.active = false;
        emit ActorRevoked(wallet, actorInfo.orgId);
    }

    /**
     * @notice Pauses all custody anchoring functions in an emergency.
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Resumes custody anchoring functions after a pause.
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Anchors the initial CREATED event for a waste batch (seq = 1).
     * @dev Callable by any relayer holding a valid EIP-712 signature from an active GENERATOR.
     * @param intent Signed custody intent with eventType CREATED, prevHash 0, targetSeq 0.
     * @param signature EIP-712 signature produced by intent.actor.
     */
    function createBatch(
        CustodyIntent calldata intent,
        bytes calldata signature
    ) external whenNotPaused {
        ActorInfo storage actorInfo = _verifyAndConsumeIntent(
            intent,
            signature,
            EventType.CREATED
        );
        if (actorInfo.role != ActorRole.GENERATOR) {
            revert InvalidActorRole(actorInfo.role);
        }
        if (intent.targetSeq != 0) {
            revert InvalidTargetSeq(intent.targetSeq);
        }
        if (intent.prevHash != bytes32(0)) {
            revert InvalidPrevHash(bytes32(0), intent.prevHash);
        }

        BatchHeader storage batch = _batches[intent.batchId];
        if (batch.exists) {
            revert BatchAlreadyExists(intent.batchId);
        }

        uint64 ts = uint64(block.timestamp);
        batch.exists = true;
        batch.status = BatchStatus.REGISTERED;
        batch.headHash = intent.eventHash;
        batch.currentCustodianOrgId = actorInfo.orgId;
        batch.eventCount = 1;

        _batchEvents[intent.batchId].push(
            AnchoredEvent({
                seq: 1,
                eventType: EventType.CREATED,
                eventHash: intent.eventHash,
                prevHash: bytes32(0),
                targetSeq: 0,
                actor: intent.actor,
                orgId: actorInfo.orgId,
                timestamp: ts
            })
        );

        emit BatchCreated(
            intent.batchId,
            1,
            intent.eventHash,
            intent.actor,
            actorInfo.orgId,
            ts
        );
    }

    /**
     * @notice Anchors a CUSTODY_TRANSFERRED event (pickup by TRANSPORTER or delivery to FACILITY).
     * @dev Enforces REGISTERED -> IN_TRANSIT (TRANSPORTER) and IN_TRANSIT -> RECEIVED (FACILITY),
     *      and prohibits transferring custody to the same organization.
     * @param intent Signed custody intent with eventType CUSTODY_TRANSFERRED and targetSeq 0.
     * @param signature EIP-712 signature produced by intent.actor.
     */
    function transferCustody(
        CustodyIntent calldata intent,
        bytes calldata signature
    ) external whenNotPaused {
        ActorInfo storage actorInfo = _verifyAndConsumeIntent(
            intent,
            signature,
            EventType.CUSTODY_TRANSFERRED
        );
        if (intent.targetSeq != 0) {
            revert InvalidTargetSeq(intent.targetSeq);
        }

        BatchHeader storage batch = _batches[intent.batchId];
        if (!batch.exists) {
            revert BatchNotFound(intent.batchId);
        }
        if (intent.prevHash != batch.headHash) {
            revert InvalidPrevHash(batch.headHash, intent.prevHash);
        }

        BatchStatus nextStatus;
        if (batch.status == BatchStatus.REGISTERED) {
            if (actorInfo.role != ActorRole.TRANSPORTER) {
                revert InvalidActorRole(actorInfo.role);
            }
            nextStatus = BatchStatus.IN_TRANSIT;
        } else if (batch.status == BatchStatus.IN_TRANSIT) {
            if (actorInfo.role != ActorRole.FACILITY) {
                revert InvalidActorRole(actorInfo.role);
            }
            nextStatus = BatchStatus.RECEIVED;
        } else {
            revert InvalidBatchStatus(batch.status);
        }

        if (actorInfo.orgId == batch.currentCustodianOrgId) {
            revert SameOrganizationTransfer(actorInfo.orgId);
        }

        bytes32 fromOrgId = batch.currentCustodianOrgId;
        bytes32 toOrgId = actorInfo.orgId;
        uint32 seq = batch.eventCount + 1;
        uint64 ts = uint64(block.timestamp);

        batch.status = nextStatus;
        batch.headHash = intent.eventHash;
        batch.currentCustodianOrgId = toOrgId;
        batch.eventCount = seq;

        _batchEvents[intent.batchId].push(
            AnchoredEvent({
                seq: seq,
                eventType: EventType.CUSTODY_TRANSFERRED,
                eventHash: intent.eventHash,
                prevHash: intent.prevHash,
                targetSeq: 0,
                actor: intent.actor,
                orgId: toOrgId,
                timestamp: ts
            })
        );

        emit CustodyTransferred(
            intent.batchId,
            seq,
            intent.eventHash,
            nextStatus,
            intent.actor,
            fromOrgId,
            toOrgId,
            ts
        );
    }

    /**
     * @notice Anchors an append-only REVISION event referencing an earlier non-revision event.
     * @dev Preserves the original event and batch status/custodian while advancing headHash and eventCount.
     * @param intent Signed custody intent with eventType REVISION and 1-based targetSeq.
     * @param signature EIP-712 signature produced by intent.actor.
     */
    function createRevision(
        CustodyIntent calldata intent,
        bytes calldata signature
    ) external whenNotPaused {
        ActorInfo storage actorInfo = _verifyAndConsumeIntent(
            intent,
            signature,
            EventType.REVISION
        );

        BatchHeader storage batch = _batches[intent.batchId];
        if (!batch.exists) {
            revert BatchNotFound(intent.batchId);
        }
        if (intent.prevHash != batch.headHash) {
            revert InvalidPrevHash(batch.headHash, intent.prevHash);
        }
        if (intent.targetSeq == 0 || intent.targetSeq > batch.eventCount) {
            revert InvalidTargetSeq(intent.targetSeq);
        }

        AnchoredEvent storage targetEvent = _batchEvents[intent.batchId][intent.targetSeq - 1];
        if (targetEvent.eventType == EventType.REVISION) {
            revert CannotReviseRevision(intent.targetSeq);
        }
        if (actorInfo.orgId != targetEvent.orgId) {
            revert OrganizationMismatch(targetEvent.orgId, actorInfo.orgId);
        }

        uint32 seq = batch.eventCount + 1;
        uint64 ts = uint64(block.timestamp);

        batch.headHash = intent.eventHash;
        batch.eventCount = seq;

        _batchEvents[intent.batchId].push(
            AnchoredEvent({
                seq: seq,
                eventType: EventType.REVISION,
                eventHash: intent.eventHash,
                prevHash: intent.prevHash,
                targetSeq: intent.targetSeq,
                actor: intent.actor,
                orgId: actorInfo.orgId,
                timestamp: ts
            })
        );

        emit RevisionCreated(
            intent.batchId,
            seq,
            intent.targetSeq,
            intent.eventHash,
            intent.actor,
            actorInfo.orgId,
            ts
        );
    }

    /**
     * @notice Anchors the final TREATMENT event for a received waste batch.
     * @dev Requires RECEIVED status, FACILITY role, and matching currentCustodianOrgId; transitions to TREATED.
     * @param intent Signed custody intent with eventType TREATMENT and targetSeq 0.
     * @param signature EIP-712 signature produced by intent.actor.
     */
    function recordTreatment(
        CustodyIntent calldata intent,
        bytes calldata signature
    ) external whenNotPaused {
        ActorInfo storage actorInfo = _verifyAndConsumeIntent(
            intent,
            signature,
            EventType.TREATMENT
        );
        if (intent.targetSeq != 0) {
            revert InvalidTargetSeq(intent.targetSeq);
        }
        if (actorInfo.role != ActorRole.FACILITY) {
            revert InvalidActorRole(actorInfo.role);
        }

        BatchHeader storage batch = _batches[intent.batchId];
        if (!batch.exists) {
            revert BatchNotFound(intent.batchId);
        }
        if (batch.status != BatchStatus.RECEIVED) {
            revert InvalidBatchStatus(batch.status);
        }
        if (actorInfo.orgId != batch.currentCustodianOrgId) {
            revert OrganizationMismatch(batch.currentCustodianOrgId, actorInfo.orgId);
        }
        if (intent.prevHash != batch.headHash) {
            revert InvalidPrevHash(batch.headHash, intent.prevHash);
        }

        uint32 seq = batch.eventCount + 1;
        uint64 ts = uint64(block.timestamp);

        batch.status = BatchStatus.TREATED;
        batch.headHash = intent.eventHash;
        batch.eventCount = seq;

        _batchEvents[intent.batchId].push(
            AnchoredEvent({
                seq: seq,
                eventType: EventType.TREATMENT,
                eventHash: intent.eventHash,
                prevHash: intent.prevHash,
                targetSeq: 0,
                actor: intent.actor,
                orgId: actorInfo.orgId,
                timestamp: ts
            })
        );

        emit TreatmentRecorded(
            intent.batchId,
            seq,
            intent.eventHash,
            intent.actor,
            actorInfo.orgId,
            ts
        );
    }

    /**
     * @notice Returns the current batch header for a given batchId.
     * @param batchId Keccak256 hash of the batch UUID.
     * @return BatchHeader struct containing existence, status, headHash, custodian org, and eventCount.
     */
    function getBatch(bytes32 batchId) external view returns (BatchHeader memory) {
        return _batches[batchId];
    }

    /**
     * @notice Returns a single anchored event by its 1-based sequence number.
     * @param batchId Keccak256 hash of the batch UUID.
     * @param seq 1-based event sequence number (1 <= seq <= eventCount).
     * @return AnchoredEvent struct stored at the specified sequence.
     */
    function getEvent(
        bytes32 batchId,
        uint32 seq
    ) external view returns (AnchoredEvent memory) {
        if (seq == 0 || seq > _batches[batchId].eventCount) {
            revert InvalidTargetSeq(seq);
        }
        return _batchEvents[batchId][seq - 1];
    }

    /**
     * @notice Returns the total number of anchored events for a batch.
     * @param batchId Keccak256 hash of the batch UUID.
     * @return Number of anchored events (0 if batch does not exist).
     */
    function eventCount(bytes32 batchId) external view returns (uint32) {
        return _batches[batchId].eventCount;
    }

    /**
     * @notice Returns registration info for an actor wallet.
     * @param wallet Actor EVM address.
     * @return ActorInfo struct containing role, orgId, and active status.
     */
    function getActor(address wallet) external view returns (ActorInfo memory) {
        return _actors[wallet];
    }

    /**
     * @notice Returns the current EIP-712 domain separator for this contract and chain.
     * @return EIP-712 domain separator hash.
     */
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _verifyAndConsumeIntent(
        CustodyIntent calldata intent,
        bytes calldata signature,
        EventType expectedEventType
    ) internal returns (ActorInfo storage actorInfo) {
        if (intent.batchId == bytes32(0)) {
            revert ZeroBatchId();
        }
        if (intent.eventHash == bytes32(0)) {
            revert ZeroEventHash();
        }
        if (intent.eventType != expectedEventType) {
            revert InvalidEventType(expectedEventType, intent.eventType);
        }
        if (intent.actor == address(0)) {
            revert ZeroAddress();
        }
        if (block.timestamp > intent.deadline) {
            revert IntentExpired(intent.deadline, block.timestamp);
        }

        actorInfo = _actors[intent.actor];
        if (!actorInfo.active) {
            revert ActorNotActive(intent.actor);
        }

        bytes32 structHash = keccak256(
            abi.encode(
                CUSTODY_INTENT_TYPEHASH,
                intent.batchId,
                uint8(intent.eventType),
                intent.eventHash,
                intent.prevHash,
                intent.targetSeq,
                intent.actor,
                intent.nonce,
                intent.deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recovered, ECDSA.RecoverError recoverErr, ) = ECDSA.tryRecoverCalldata(
            digest,
            signature
        );
        if (recoverErr != ECDSA.RecoverError.NoError || recovered != intent.actor) {
            revert InvalidSignature();
        }

        _useCheckedNonce(intent.actor, intent.nonce);
    }
}
