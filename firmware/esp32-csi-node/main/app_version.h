/* Firmware version reported in every HEARTBEAT (docs/protocol.md S10) and in
 * the /device/hello body (main/ota.c).
 * Bump this whenever behaviour on the wire or in the field changes - it is
 * the only way an operator can tell which node is running what.
 *
 * THIS FILE IS AUTHORITATIVE, but it is not the only copy: ESP-IDF stamps
 * esp_app_desc_t.version (which the bootloader and main/ota.c's anti-flap
 * check read out of an OTA slot) from CMake's PROJECT_VER instead, because a
 * compiled header cannot reach the image descriptor. Bumping a version means
 * editing BOTH this file and PROJECT_VER in ../CMakeLists.txt;
 * firmware/tests/test_version_sync.c fails if you only edit one. */
#ifndef HCS_APP_VERSION_H
#define HCS_APP_VERSION_H

#define HCS_FW_VERSION_MAJOR 0
#define HCS_FW_VERSION_MINOR 1
#define HCS_FW_VERSION_PATCH 0

/* "major.minor.patch" as a string literal, for the hello body and logs. The
 * double indirection is the standard stringify-a-macro dance: without it the
 * result would be the literal text "HCS_FW_VERSION_MAJOR". */
#define HCS_FW_VERSION_STR__(a, b, c) #a "." #b "." #c
#define HCS_FW_VERSION_STR_(a, b, c) HCS_FW_VERSION_STR__(a, b, c)
#define HCS_FW_VERSION_STR                                                     \
    HCS_FW_VERSION_STR_(HCS_FW_VERSION_MAJOR, HCS_FW_VERSION_MINOR,            \
                        HCS_FW_VERSION_PATCH)

/* 0.x means: never run on real hardware by the author of this code. See the
 * "what must be verified on hardware" section of firmware/README.md. */

#endif /* HCS_APP_VERSION_H */
