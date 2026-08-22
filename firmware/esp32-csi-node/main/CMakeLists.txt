idf_component_register(
    SRCS
        "main.c"
        "node_config.c"
        "boot_epoch.c"
        "wifi_link.c"
        "csi_capture.c"
        "sounding.c"
        "crypto.c"
        "net_uplink.c"
        "time_sync.c"
        "heartbeat.c"
        "status_led.c"
    INCLUDE_DIRS "."
    REQUIRES
        csi_protocol      # shared wire format, also compiled by ../../tests
        nvs_flash
        esp_wifi
        esp_netif
        esp_event
        esp_timer
        esp_hw_support    # esp_random
        lwip
        mbedtls
        driver            # gpio / rmt, only used by the optional LED backends
        esp_system
)
