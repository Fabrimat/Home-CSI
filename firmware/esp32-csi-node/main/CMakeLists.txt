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
        "ota.c"
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
        # --- OTA (main/ota.c) ---
        app_update        # esp_ota_ops: begin/write/end/set_boot_partition
        esp_app_format    # esp_app_desc.h, read out of the other OTA slot
        esp_partition     # esp_partition_read for the SHA-256 read-back
        esp_http_client   # hello + manifest + firmware fetch
        esp-tls           # esp_crt_bundle: real certificate validation
        json              # cJSON, for the three-field manifest
)
