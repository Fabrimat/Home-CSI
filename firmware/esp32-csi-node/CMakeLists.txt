# ESP-IDF v5.x project definition for the Home CSI node firmware.
#
# Build:  idf.py set-target esp32 && idf.py build
# The `components/` directory alongside this file is picked up automatically;
# components/csi_protocol holds the wire-format code that is shared verbatim
# with the host tests in ../tests.
cmake_minimum_required(VERSION 3.16)

# ESP-IDF stamps esp_app_desc_t.version (embedded in the image header) from
# PROJECT_VER, and from nothing else. main/ota.c reads that descriptor out of
# the OTHER OTA slot to implement its anti-flap rule, so this string must
# equal main/app_version.h - which stays the authoritative copy, because it is
# what the heartbeat and the /device/hello body report.
#
# Bumping a version therefore means editing BOTH files.
# firmware/tests/test_version_sync.c fails if you only edit one.
set(PROJECT_VER "0.1.0")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(esp32-csi-node)
