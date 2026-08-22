/*
 * status_led.c - see status_led.h for the hardware caveat.
 *
 * Three backends, chosen in Kconfig:
 *   NONE    - default. Logs state transitions. Always compiles, always works.
 *   GPIO    - blinks one plain GPIO with a per-state pattern. Works with any
 *             indicator LED on any pin, including one you solder on yourself.
 *   WS2812  - drives an addressable ring over RMT, with a brightness cap.
 *
 * The animation runs in its own low-priority task at 20 Hz. It never touches
 * the capture or uplink paths, and every backend call is fire-and-forget: a
 * failing LED bus can slow this task down and nothing else.
 */

#include "status_led.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_HCS_LED_BACKEND_GPIO
#include "driver/gpio.h"
#endif

#if CONFIG_HCS_LED_BACKEND_WS2812
#include "driver/rmt_tx.h"
#endif

static const char *TAG = "status_led";

#define TICK_MS 50 /* 20 Hz animation */

static volatile led_state_t s_state = LED_STATE_BOOTING;
static volatile uint32_t s_blip_ticks;

static const char *state_name(led_state_t s)
{
    switch (s) {
    case LED_STATE_BOOTING:
        return "BOOTING";
    case LED_STATE_CONNECTING:
        return "CONNECTING";
    case LED_STATE_NO_SERVER:
        return "CONNECTED-NO-SERVER";
    case LED_STATE_STREAMING:
        return "STREAMING";
    case LED_STATE_ERROR:
        return "ERROR";
    default:
        return "?";
    }
}

/* ---------------------------------------------------------------- colours */

typedef struct {
    uint8_t r, g, b;
} rgb_t;

/* Base colour per state, before the brightness cap. */
static rgb_t state_colour(led_state_t s)
{
    switch (s) {
    case LED_STATE_BOOTING:
        return (rgb_t){ 255, 255, 255 };
    case LED_STATE_CONNECTING:
        return (rgb_t){ 0, 80, 255 };
    case LED_STATE_NO_SERVER:
        return (rgb_t){ 255, 140, 0 };
    case LED_STATE_STREAMING:
        return (rgb_t){ 0, 255, 60 };
    case LED_STATE_ERROR:
    default:
        return (rgb_t){ 255, 0, 0 };
    }
}

/* 0-255 intensity envelope for the current state at animation tick `t`.
 * Distinguishable at a glance from across a room:
 *   BOOTING     slow white breathe
 *   CONNECTING  1 Hz blue pulse
 *   NO_SERVER   amber, two short blinks then a gap
 *   STREAMING   dim green, brief bright blip when a batch is sent
 *   ERROR       red, fast double blink
 */
static uint8_t envelope(led_state_t s, uint32_t t)
{
    switch (s) {
    case LED_STATE_BOOTING: {
        const uint32_t p = t % 40u; /* 2 s */
        return (uint8_t)((p < 20u) ? (p * 255u / 20u)
                                   : ((40u - p) * 255u / 20u));
    }
    case LED_STATE_CONNECTING:
        return (uint8_t)(((t % 20u) < 10u) ? 255 : 20);
    case LED_STATE_NO_SERVER: {
        const uint32_t p = t % 30u;
        return (uint8_t)((p < 3u || (p >= 6u && p < 9u)) ? 255 : 0);
    }
    case LED_STATE_STREAMING:
        return (uint8_t)(s_blip_ticks > 0u ? 255 : 40);
    case LED_STATE_ERROR:
    default: {
        const uint32_t p = t % 20u;
        return (uint8_t)((p < 2u || (p >= 4u && p < 6u)) ? 255 : 0);
    }
    }
}

/* ------------------------------------------------------------- backends */

#if CONFIG_HCS_LED_BACKEND_NONE

static esp_err_t backend_init(void)
{
    ESP_LOGI(TAG, "LED backend: none (state changes are logged only). "
                  "Select a backend in menuconfig once the Halocode's LED "
                  "pin has actually been measured.");
    return ESP_OK;
}
static void backend_show(rgb_t c, uint8_t level)
{
    (void)c;
    (void)level;
}

#elif CONFIG_HCS_LED_BACKEND_GPIO

static esp_err_t backend_init(void)
{
    const gpio_config_t io = {
        .pin_bit_mask = 1ULL << CONFIG_HCS_LED_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    const esp_err_t err = gpio_config(&io);
    ESP_LOGI(TAG, "LED backend: single GPIO %d (UNVERIFIED PIN)",
             CONFIG_HCS_LED_GPIO);
    return err;
}

static void backend_show(rgb_t c, uint8_t level)
{
    (void)c; /* a plain LED has no colour; the pattern carries the meaning */
    gpio_set_level(CONFIG_HCS_LED_GPIO, level > 127 ? 1 : 0);
}

#else /* CONFIG_HCS_LED_BACKEND_WS2812 */

/* WS2812 timing, in RMT ticks at 10 MHz (0.1 us per tick). */
#define WS_RES_HZ 10000000
#define WS_T0H 3  /* 0.3 us */
#define WS_T0L 9  /* 0.9 us */
#define WS_T1H 9  /* 0.9 us */
#define WS_T1L 3  /* 0.3 us */

static rmt_channel_handle_t s_chan;
static rmt_encoder_handle_t s_encoder;
static uint8_t s_pixels[CONFIG_HCS_LED_COUNT * 3];

static esp_err_t backend_init(void)
{
    rmt_tx_channel_config_t chan_cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .gpio_num = CONFIG_HCS_LED_GPIO,
        .mem_block_symbols = 64,
        .resolution_hz = WS_RES_HZ,
        .trans_queue_depth = 2,
    };
    esp_err_t err = rmt_new_tx_channel(&chan_cfg, &s_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_new_tx_channel: %s", esp_err_to_name(err));
        return err;
    }

    const rmt_bytes_encoder_config_t bytes_cfg = {
        .bit0 = { .level0 = 1, .duration0 = WS_T0H,
                  .level1 = 0, .duration1 = WS_T0L },
        .bit1 = { .level0 = 1, .duration0 = WS_T1H,
                  .level1 = 0, .duration1 = WS_T1L },
        .flags.msb_first = 1,
    };
    err = rmt_new_bytes_encoder(&bytes_cfg, &s_encoder);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_new_bytes_encoder: %s", esp_err_to_name(err));
        return err;
    }
    err = rmt_enable(s_chan);
    ESP_LOGI(TAG, "LED backend: WS2812 x%d on GPIO %d (UNVERIFIED PIN/CHIP)",
             CONFIG_HCS_LED_COUNT, CONFIG_HCS_LED_GPIO);
    return err;
}

static void backend_show(rgb_t c, uint8_t level)
{
    for (int i = 0; i < CONFIG_HCS_LED_COUNT; i++) {
        /* WS2812 wants GRB order. */
        s_pixels[i * 3 + 0] = (uint8_t)((c.g * level) / 255);
        s_pixels[i * 3 + 1] = (uint8_t)((c.r * level) / 255);
        s_pixels[i * 3 + 2] = (uint8_t)((c.b * level) / 255);
    }
    const rmt_transmit_config_t tx = { .loop_count = 0 };
    /* Fire and forget: a failing LED bus must never stall this task. */
    (void)rmt_transmit(s_chan, s_encoder, s_pixels, sizeof s_pixels, &tx);
}

#endif /* backend selection */

/* -------------------------------------------------------------- driver */

static void led_task(void *arg)
{
    (void)arg;
    uint32_t t = 0;
    led_state_t last = LED_STATE_COUNT;
    for (;;) {
        const led_state_t st = s_state;
        if (st != last) {
            ESP_LOGI(TAG, "state -> %s", state_name(st));
            last = st;
            t = 0;
        }

        const rgb_t base = state_colour(st);
        uint8_t level = envelope(st, t);

#if !CONFIG_HCS_LED_BACKEND_NONE
        /* Brightness cap. These live in bedrooms; full brightness at 03:00
         * is how a monitoring node gets unplugged permanently. */
        const uint32_t capped =
            ((uint32_t)level * (uint32_t)CONFIG_HCS_LED_MAX_BRIGHTNESS) / 255u;
        level = (uint8_t)capped;
#endif
        backend_show(base, level);

        if (s_blip_ticks > 0u) {
            s_blip_ticks--;
        }
        t++;
        vTaskDelay(pdMS_TO_TICKS(TICK_MS));
    }
}

esp_err_t status_led_init(void)
{
    const esp_err_t err = backend_init();
    if (err != ESP_OK) {
        /* Deliberately not fatal: a broken indicator must not stop a node
         * from doing its actual job. */
        ESP_LOGW(TAG, "LED backend init failed (%s) - continuing without an "
                      "indicator",
                 esp_err_to_name(err));
    }
    if (xTaskCreate(led_task, "status_led", 2560, NULL, 1, NULL) != pdPASS) {
        ESP_LOGW(TAG, "could not start LED task - continuing without one");
    }
    return ESP_OK;
}

void status_led_set(led_state_t state)
{
    if (state < LED_STATE_COUNT) {
        s_state = state;
    }
}

void status_led_blip(void)
{
    s_blip_ticks = 2; /* ~100 ms */
}
