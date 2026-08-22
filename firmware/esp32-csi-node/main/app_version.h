/* Firmware version reported in every HEARTBEAT (docs/protocol.md S10).
 * Bump this whenever behaviour on the wire or in the field changes - it is
 * the only way an operator can tell which node is running what. */
#ifndef HCS_APP_VERSION_H
#define HCS_APP_VERSION_H

#define HCS_FW_VERSION_MAJOR 0
#define HCS_FW_VERSION_MINOR 1
#define HCS_FW_VERSION_PATCH 0

/* 0.x means: never run on real hardware by the author of this code. See the
 * "what must be verified on hardware" section of firmware/README.md. */

#endif /* HCS_APP_VERSION_H */
