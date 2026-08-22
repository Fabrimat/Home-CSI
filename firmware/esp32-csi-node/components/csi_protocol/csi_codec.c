/*
 * csi_codec.c - Home CSI v1 wire format encoder/decoder.
 *
 * Compiled into BOTH the ESP-IDF firmware and the host tests. Keep it free of
 * ESP-IDF headers, allocation, floating point and locale-dependent calls.
 *
 * Every offset here is traceable to docs/protocol.md; the symbolic offsets
 * live in csi_wire.h so the layout appears in exactly one place.
 */

#include "csi_protocol/csi_codec.h"

#include <string.h>

/* --- little-endian primitives (proto: "all multi-byte ints are LE") ---- */

void hcs_put_u16le(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v & 0xFFu);
    p[1] = (uint8_t)((v >> 8) & 0xFFu);
}

void hcs_put_u32le(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v & 0xFFu);
    p[1] = (uint8_t)((v >> 8) & 0xFFu);
    p[2] = (uint8_t)((v >> 16) & 0xFFu);
    p[3] = (uint8_t)((v >> 24) & 0xFFu);
}

void hcs_put_u64le(uint8_t *p, uint64_t v)
{
    for (unsigned i = 0; i < 8; i++) {
        p[i] = (uint8_t)((v >> (8u * i)) & 0xFFu);
    }
}

uint16_t hcs_get_u16le(const uint8_t *p)
{
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

uint32_t hcs_get_u32le(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16)
           | ((uint32_t)p[3] << 24);
}

uint64_t hcs_get_u64le(const uint8_t *p)
{
    uint64_t v = 0;
    for (unsigned i = 0; i < 8; i++) {
        v |= (uint64_t)p[i] << (8u * i);
    }
    return v;
}

/* --- proto S4: nonce -------------------------------------------------- */

void hcs_nonce_build(uint8_t out[HCS_NONCE_LEN], uint16_t node_id,
                     uint32_t boot_epoch, uint32_t seq)
{
    hcs_put_u16le(&out[0], node_id);
    hcs_put_u32le(&out[2], boot_epoch);
    hcs_put_u32le(&out[6], seq);
    out[10] = 0x00; /* reserved, MUST be zero */
    out[11] = 0x00;
}

/* --- proto S3: cleartext header (also the AAD) ------------------------ */

size_t hcs_header_encode(uint8_t *out, size_t cap, const hcs_header_t *h)
{
    if (out == NULL || h == NULL || cap < HCS_HEADER_LEN) {
        return 0;
    }
    out[HCS_HDR_OFF_MAGIC + 0] = HCS_MAGIC_0;
    out[HCS_HDR_OFF_MAGIC + 1] = HCS_MAGIC_1;
    out[HCS_HDR_OFF_MAGIC + 2] = HCS_MAGIC_2;
    out[HCS_HDR_OFF_MAGIC + 3] = HCS_MAGIC_3;
    out[HCS_HDR_OFF_VERSION] = h->version;
    out[HCS_HDR_OFF_MSG_TYPE] = h->msg_type;
    hcs_put_u16le(&out[HCS_HDR_OFF_NODE_ID], h->node_id);
    hcs_put_u32le(&out[HCS_HDR_OFF_BOOT_EPOCH], h->boot_epoch);
    hcs_put_u32le(&out[HCS_HDR_OFF_SEQ], h->seq);
    hcs_nonce_build(&out[HCS_HDR_OFF_NONCE], h->node_id, h->boot_epoch, h->seq);
    return HCS_HEADER_LEN;
}

hcs_err_t hcs_header_decode(hcs_header_t *out, const uint8_t *in, size_t len)
{
    if (out == NULL || in == NULL || len < HCS_HEADER_LEN) {
        return HCS_ERR_ARG;
    }
    if (in[0] != HCS_MAGIC_0 || in[1] != HCS_MAGIC_1 || in[2] != HCS_MAGIC_2
        || in[3] != HCS_MAGIC_3) {
        return HCS_ERR_MAGIC;
    }
    hcs_header_t h;
    h.version = in[HCS_HDR_OFF_VERSION];
    h.msg_type = in[HCS_HDR_OFF_MSG_TYPE];
    h.node_id = hcs_get_u16le(&in[HCS_HDR_OFF_NODE_ID]);
    h.boot_epoch = hcs_get_u32le(&in[HCS_HDR_OFF_BOOT_EPOCH]);
    h.seq = hcs_get_u32le(&in[HCS_HDR_OFF_SEQ]);

    /* proto S4: decoders MUST recompute the nonce and reject on mismatch,
     * including the two reserved zero bytes. */
    uint8_t expect[HCS_NONCE_LEN];
    hcs_nonce_build(expect, h.node_id, h.boot_epoch, h.seq);
    if (memcmp(expect, &in[HCS_HDR_OFF_NONCE], HCS_NONCE_LEN) != 0) {
        return HCS_ERR_NONCE;
    }

    *out = h;
    return HCS_OK;
}

/* --- proto S9.1: batch header ----------------------------------------- */

size_t hcs_batch_header_encode(uint8_t *out, size_t cap,
                               const hcs_batch_header_t *bh)
{
    if (out == NULL || bh == NULL || cap < HCS_BATCH_HEADER_LEN) {
        return 0;
    }
    hcs_put_u64le(&out[HCS_BH_OFF_WALL_CLOCK], bh->wall_clock_us);
    hcs_put_u64le(&out[HCS_BH_OFF_MONO], bh->mono_us);
    out[HCS_BH_OFF_SNTP] = bh->sntp_synced ? 1u : 0u;
    out[HCS_BH_OFF_RESERVED + 0] = 0u; /* MUST be zero */
    out[HCS_BH_OFF_RESERVED + 1] = 0u;
    out[HCS_BH_OFF_RESERVED + 2] = 0u;
    hcs_put_u16le(&out[HCS_BH_OFF_COUNT], bh->record_count);
    return HCS_BATCH_HEADER_LEN;
}

/* --- proto S9.2: CSI record ------------------------------------------- */

size_t hcs_record_encode(uint8_t *out, size_t cap, const hcs_csi_record_t *r)
{
    if (out == NULL || r == NULL) {
        return 0;
    }
    const size_t total = (size_t)HCS_RECORD_FIXED_LEN + (size_t)r->csi_len;
    if (cap < total) {
        return 0;
    }
    if (r->csi_len != 0 && r->csi_data == NULL) {
        return 0;
    }
    memcpy(&out[HCS_REC_OFF_SRC_MAC], r->src_mac, 6);
    memcpy(&out[HCS_REC_OFF_DST_MAC], r->dst_mac, 6);
    out[HCS_REC_OFF_RSSI] = (uint8_t)r->rssi;
    out[HCS_REC_OFF_RATE] = r->rate;
    out[HCS_REC_OFF_SIG_MODE] = r->sig_mode;
    out[HCS_REC_OFF_MCS] = r->mcs;
    out[HCS_REC_OFF_BANDWIDTH] = r->bandwidth;
    out[HCS_REC_OFF_CHANNEL] = r->channel;
    out[HCS_REC_OFF_SECONDARY] = r->secondary_channel;
    out[HCS_REC_OFF_NOISE] = (uint8_t)r->noise_floor;
    hcs_put_u64le(&out[HCS_REC_OFF_RX_TS], r->rx_timestamp_us);
    out[HCS_REC_OFF_FORMAT] = r->csi_format;
    hcs_put_u16le(&out[HCS_REC_OFF_CSI_LEN], r->csi_len);
    if (r->csi_len != 0) {
        memcpy(&out[HCS_REC_OFF_CSI_DATA], r->csi_data, r->csi_len);
    }
    return total;
}

/* --- proto S10: heartbeat --------------------------------------------- */

size_t hcs_heartbeat_encode(uint8_t *out, size_t cap,
                            const hcs_heartbeat_t *hb)
{
    if (out == NULL || hb == NULL || cap < HCS_HEARTBEAT_LEN) {
        return 0;
    }
    hcs_put_u32le(&out[0], hb->uptime_s);
    hcs_put_u32le(&out[4], hb->free_heap_bytes);
    hcs_put_u32le(&out[8], hb->min_free_heap_bytes);
    hcs_put_u32le(&out[12], hb->frames_captured);
    hcs_put_u32le(&out[16], hb->frames_dropped);
    hcs_put_u32le(&out[20], hb->batches_sent);
    hcs_put_u32le(&out[24], hb->send_failures);
    out[28] = (uint8_t)hb->rssi_to_ap;
    out[29] = hb->channel;
    out[30] = hb->sntp_synced ? 1u : 0u;
    out[31] = hb->fw_version_major;
    out[32] = hb->fw_version_minor;
    out[33] = hb->fw_version_patch;
    out[34] = 0u; /* reserved, MUST be zero */
    out[35] = 0u;
    return HCS_HEARTBEAT_LEN;
}

/* --- proto S2/S5/S11: seal a complete datagram ------------------------ */

hcs_err_t hcs_datagram_seal(uint8_t *out, size_t out_cap, size_t *out_len,
                            const hcs_header_t *hdr, const uint8_t *plaintext,
                            size_t pt_len, const uint8_t key[HCS_KEY_LEN],
                            hcs_aead_seal_fn seal, void *seal_ctx)
{
    if (out == NULL || out_len == NULL || hdr == NULL || key == NULL
        || seal == NULL || (plaintext == NULL && pt_len != 0)) {
        return HCS_ERR_ARG;
    }
    /* proto S11: the whole datagram must fit in 1200 bytes. */
    if (pt_len > HCS_MAX_PLAINTEXT_LEN) {
        return HCS_ERR_TOO_LARGE;
    }
    const size_t total = HCS_HEADER_LEN + pt_len + HCS_TAG_LEN;
    if (out_cap < total) {
        return HCS_ERR_CAPACITY;
    }

    if (hcs_header_encode(out, out_cap, hdr) != HCS_HEADER_LEN) {
        return HCS_ERR_CAPACITY;
    }

    /* proto S5: the AAD is the full 28-byte header exactly as it appears on
     * the wire, nonce field included. The nonce passed to the AEAD is the
     * very same bytes, read back out of the encoded header, so the two can
     * never diverge. */
    const uint8_t *nonce = &out[HCS_HDR_OFF_NONCE];
    uint8_t *ct = &out[HCS_HEADER_LEN];
    uint8_t *tag = &out[HCS_HEADER_LEN + pt_len];

    if (seal(seal_ctx, key, nonce, out, HCS_HEADER_LEN, plaintext, pt_len, ct,
             tag)
        != 0) {
        return HCS_ERR_CRYPTO;
    }

    *out_len = total;
    return HCS_OK;
}
