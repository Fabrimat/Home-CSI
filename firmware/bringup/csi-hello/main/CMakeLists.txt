idf_component_register(
    SRCS "csi_hello_main.c"
    INCLUDE_DIRS "."
    REQUIRES nvs_flash esp_wifi esp_netif esp_event esp_timer
)
