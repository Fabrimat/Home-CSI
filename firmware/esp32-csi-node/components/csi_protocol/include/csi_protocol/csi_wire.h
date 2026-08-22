/*
 * csi_wire.h - Home CSI v1 wire format constants and in-memory structs.
 *
 * NORMATIVE SOURCE: docs/protocol.md (v1). Every constant below is traceable
 * to a section of that document; the section number is in the comment. If
 * this file and docs/protocol.md ever disagree, that is a bug in one of them
 * and must be reconciled - do not "fix" it locally.
 *
 * This header is compiled BOTH into the ESP-IDF firmware and into the host
 * test binaries (firmware/tests). It must therefore stay free of any ESP-IDF
 * or FreeRTOS dependency: plain C11 and <stdint.h> only.
 */
#ifndef CSI_PROTOCOL_CSI_WIRE_H
#define CSI_PROTOCOL_CSI_WIRE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* --- section 3: cleartext header ------------------------------------- */

/* ASCII "HCS1". Never changes across protocol versions (proto S3). */
#define HCS_MAGIC_0 0x48u /* 'H' */
#define HCS_MAGIC_1 0x43u /* 'C' */
#define HCS_MAGIC_2 0x53u /* 'S' */
#define HCS_MAGIC_3 0x31u /* '1' */

#define HCS_PROTOCOL_VERSION 1u /* proto S3 / S12 */

#define HCS_HEADER_LEN 28u /* proto S3: fixed, and also the AEAD AAD */

/* Field offsets inside the cleartext header (proto S3). */
#define HCS_HDR_OFF_MAGIC      0u
#define HCS_HDR_OFF_VERSION    4u
#define HCS_HDR_OFF_MSG_TYPE   5u
#define HCS_HDR_OFF_NODE_ID    6u
#define HCS_HDR_OFF_BOOT_EPOCH 8u
#define HCS_HDR_OFF_SEQ        12u
#define HCS_HDR_OFF_NONCE      16u

/* --- section 5: crypto ------------------------------------------------ */

#define HCS_KEY_LEN   32u /* ChaCha20-Poly1305 key, unique per node */
#define HCS_NONCE_LEN 12u /* IETF 96-bit nonce */
#define HCS_TAG_LEN   16u /* Poly1305 tag */

/* --- section 8: message types ---------------------------------------- */

typedef enum {
    HCS_MSG_INVALID = 0,   /* reserved, MUST be rejected */
    HCS_MSG_CSI_BATCH = 1, /* proto S9 */
    HCS_MSG_HEARTBEAT = 2, /* proto S10 */
    HCS_MSG_LOG = 3,       /* reserved for future use */
    HCS_MSG_OTA_STATUS = 4 /* reserved for future use */
} hcs_msg_type_t;

/* --- section 9: CSI_BATCH -------------------------------------------- */

#define HCS_BATCH_HEADER_LEN 22u /* proto S9.1 */
#define HCS_RECORD_FIXED_LEN 31u /* proto S9.2, excludes csi_data */

/* Field offsets inside a batch header (proto S9.1). */
#define HCS_BH_OFF_WALL_CLOCK 0u
#define HCS_BH_OFF_MONO       8u
#define HCS_BH_OFF_SNTP       16u
#define HCS_BH_OFF_RESERVED   17u
#define HCS_BH_OFF_COUNT      20u

/* Field offsets inside a CSI record (proto S9.2). */
#define HCS_REC_OFF_SRC_MAC   0u
#define HCS_REC_OFF_DST_MAC   6u
#define HCS_REC_OFF_RSSI      12u
#define HCS_REC_OFF_RATE      13u
#define HCS_REC_OFF_SIG_MODE  14u
#define HCS_REC_OFF_MCS       15u
#define HCS_REC_OFF_BANDWIDTH 16u
#define HCS_REC_OFF_CHANNEL   17u
#define HCS_REC_OFF_SECONDARY 18u
#define HCS_REC_OFF_NOISE     19u
#define HCS_REC_OFF_RX_TS     20u
#define HCS_REC_OFF_FORMAT    28u
#define HCS_REC_OFF_CSI_LEN   29u
#define HCS_REC_OFF_CSI_DATA  31u

/* proto S9.3. Never infer a subcarrier count from this tag - use csi_len. */
typedef enum {
    HCS_CSI_FORMAT_LLTF = 0,
    HCS_CSI_FORMAT_HT_LTF = 1,
    HCS_CSI_FORMAT_LLTF_HT_LTF = 2,
    HCS_CSI_FORMAT_STBC_HT_LTF = 3
} hcs_csi_format_t;

/* proto S9.2: sig_mode. */
#define HCS_SIG_MODE_NON_HT 0u
#define HCS_SIG_MODE_HT     1u
#define HCS_MCS_NOT_APPLICABLE 0xFFu

/* proto S9.2: bandwidth. This deployment is pinned to 20 MHz. */
#define HCS_BW_HT20 0u
#define HCS_BW_HT40 1u

/* --- section 10: HEARTBEAT ------------------------------------------- */

#define HCS_HEARTBEAT_LEN 36u /* proto S10, fixed */

/* --- section 11: sizing and limits ----------------------------------- */

#define HCS_MAX_DATAGRAM_LEN 1200u /* proto S11, full UDP payload */
#define HCS_MAX_PLAINTEXT_LEN                                                  \
    (HCS_MAX_DATAGRAM_LEN - HCS_HEADER_LEN - HCS_TAG_LEN) /* 1156 */

/* proto S11: the largest csi_len that can ever fit in an otherwise empty
 * batch. A record bigger than this MUST be dropped and counted. */
#define HCS_MAX_CSI_LEN_IN_BATCH                                               \
    (HCS_MAX_PLAINTEXT_LEN - HCS_BATCH_HEADER_LEN - HCS_RECORD_FIXED_LEN) /*1103*/

/* proto S11 defaults; both are runtime-configurable. */
#define HCS_DEFAULT_MAX_RECORDS_PER_BATCH 16u
#define HCS_DEFAULT_FLUSH_TIME_BUDGET_MS  200u

/* --- error codes ------------------------------------------------------ */

typedef enum {
    HCS_OK = 0,
    HCS_ERR_ARG = -1,       /* NULL / nonsensical argument */
    HCS_ERR_CAPACITY = -2,  /* output buffer too small */
    HCS_ERR_MAGIC = -3,     /* magic bytes wrong */
    HCS_ERR_VERSION = -4,   /* unsupported protocol version */
    HCS_ERR_NONCE = -5,     /* nonce field does not match identity fields */
    HCS_ERR_TOO_LARGE = -6, /* would exceed a protocol maximum */
    HCS_ERR_CRYPTO = -7,    /* AEAD seal/open failed */
    HCS_ERR_EXHAUSTED = -8  /* sequence space exhausted (see seq_epoch.h) */
} hcs_err_t;

/* --- in-memory representations --------------------------------------- */

typedef struct {
    uint8_t version;    /* proto S3, offset 4 */
    uint8_t msg_type;   /* proto S3, offset 5 */
    uint16_t node_id;   /* proto S3, offset 6 */
    uint32_t boot_epoch;/* proto S3, offset 8 */
    uint32_t seq;       /* proto S3, offset 12 */
    /* nonce is derived, never stored: see hcs_nonce_build(). */
} hcs_header_t;

typedef struct {
    uint64_t wall_clock_us; /* proto S7/S9.1 */
    uint64_t mono_us;       /* proto S7/S9.1 */
    uint8_t sntp_synced;    /* proto S7/S9.1, 0 or 1 */
    uint16_t record_count;  /* proto S9.1 */
} hcs_batch_header_t;

typedef struct {
    uint8_t src_mac[6];
    uint8_t dst_mac[6];
    int8_t rssi;
    uint8_t rate;
    uint8_t sig_mode;
    uint8_t mcs;
    uint8_t bandwidth;
    uint8_t channel;
    uint8_t secondary_channel;
    int8_t noise_floor;
    uint64_t rx_timestamp_us;
    uint8_t csi_format;
    uint16_t csi_len;
    const uint8_t *csi_data; /* csi_len bytes, borrowed, not owned */
} hcs_csi_record_t;

typedef struct {
    uint32_t uptime_s;
    uint32_t free_heap_bytes;
    uint32_t min_free_heap_bytes;
    uint32_t frames_captured;
    uint32_t frames_dropped;
    uint32_t batches_sent;
    uint32_t send_failures;
    int8_t rssi_to_ap;
    uint8_t channel;
    uint8_t sntp_synced;
    uint8_t fw_version_major;
    uint8_t fw_version_minor;
    uint8_t fw_version_patch;
} hcs_heartbeat_t;

#ifdef __cplusplus
}
#endif

#endif /* CSI_PROTOCOL_CSI_WIRE_H */
