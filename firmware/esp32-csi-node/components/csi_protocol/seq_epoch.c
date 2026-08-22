/* seq_epoch.c - see seq_epoch.h. */

#include "csi_protocol/seq_epoch.h"

#include <string.h>

hcs_err_t hcs_seq_init(hcs_seq_t *s, uint16_t node_id, uint32_t boot_epoch)
{
    if (s == NULL) {
        return HCS_ERR_ARG;
    }
    memset(s, 0, sizeof(*s));
    if (node_id == 0u) {
        /* proto S3: 0 is reserved/invalid. */
        s->exhausted = true;
        return HCS_ERR_ARG;
    }
    s->node_id = node_id;
    s->boot_epoch = boot_epoch;
    s->next_seq = 0u; /* proto S3: first datagram after boot uses seq 0 */
    s->exhausted = false;
    return HCS_OK;
}

hcs_err_t hcs_seq_next(hcs_seq_t *s, uint8_t msg_type, hcs_header_t *out)
{
    if (s == NULL || out == NULL) {
        return HCS_ERR_ARG;
    }
    if (s->exhausted) {
        return HCS_ERR_EXHAUSTED;
    }

    out->version = (uint8_t)HCS_PROTOCOL_VERSION;
    out->msg_type = msg_type;
    out->node_id = s->node_id;
    out->boot_epoch = s->boot_epoch;
    out->seq = s->next_seq;

    if (s->next_seq == 0xFFFFFFFFu) {
        /* This value is handed out, but there is no successor: refuse to
         * wrap, because that would reuse a nonce under the same key. */
        s->exhausted = true;
    } else {
        s->next_seq++;
    }
    return HCS_OK;
}

bool hcs_seq_exhausted(const hcs_seq_t *s)
{
    return (s == NULL) || s->exhausted;
}

hcs_err_t hcs_boot_epoch_advance(uint32_t stored, uint32_t *next)
{
    if (next == NULL) {
        return HCS_ERR_ARG;
    }
    if (stored == 0xFFFFFFFFu) {
        *next = stored;
        return HCS_ERR_EXHAUSTED;
    }
    *next = stored + 1u;
    return HCS_OK;
}
