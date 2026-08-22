/*
 * status_led.h - front-panel status, behind an interface.
 *
 * ============================ HARDWARE CAVEAT ============================
 * The Makeblock Halocode is documented as carrying a 12-LED RGB ring, but
 * THIS PROJECT HAS NOT VERIFIED the driver chip or the GPIO it is wired to.
 * Nothing here asserts otherwise:
 *
 *   - the pin, the LED count and the brightness cap are all Kconfig values;
 *   - the backend is selectable, and the DEFAULT IS "none" (log only);
 *   - every other subsystem is completely independent of this module, so a
 *     wrong pin or a missing driver costs you an indicator, not a node.
 *
 * Confirm the real pin before selecting a backend. firmware/bringup has a
 * table to record it in.
 * =========================================================================
 */
#ifndef HCS_STATUS_LED_H
#define HCS_STATUS_LED_H

#include "esp_err.h"

typedef enum {
    LED_STATE_BOOTING = 0,   /* white breathe - powered, starting up */
    LED_STATE_CONNECTING,    /* blue pulse  - looking for the dedicated AP */
    LED_STATE_NO_SERVER,     /* amber pulse - on Wi-Fi, uplink not working */
    LED_STATE_STREAMING,     /* green blip per batch - everything is fine */
    LED_STATE_ERROR,         /* red double-blink - misconfigured or wedged */
    LED_STATE_COUNT
} led_state_t;

esp_err_t status_led_init(void);

/* Cheap and idempotent; safe to call from any task at any rate. */
void status_led_set(led_state_t state);

/* One short flash on top of the current state, used to make "a batch just
 * went out" visible. Ignored by backends that cannot do it. */
void status_led_blip(void);

#endif /* HCS_STATUS_LED_H */
