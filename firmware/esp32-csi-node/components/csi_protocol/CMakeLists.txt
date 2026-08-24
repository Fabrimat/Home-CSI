# Wire-format / pure-logic component.
#
# Deliberately depends on NOTHING from ESP-IDF: the exact same .c files are
# compiled by firmware/tests with a plain host compiler, which is how the
# byte layout stays provably identical in both places.
idf_component_register(
    SRCS
        "csi_codec.c"
        "csi_ring.c"
        "csi_batcher.c"
        "bw_budget.c"
        "seq_epoch.c"
        "device_token.c"
    INCLUDE_DIRS "include"
)

# The CSI slot size is a hardware-dependent, Kconfig-tunable number. It is
# injected as a compile definition rather than by #including sdkconfig.h so
# that these sources stay buildable by firmware/tests with a plain host
# compiler (where the default in csi_ring.h applies instead).
if(CONFIG_HCS_CSI_MAX_LEN)
    target_compile_definitions(${COMPONENT_LIB}
        PUBLIC CSI_RING_MAX_CSI_LEN=${CONFIG_HCS_CSI_MAX_LEN})
endif()
