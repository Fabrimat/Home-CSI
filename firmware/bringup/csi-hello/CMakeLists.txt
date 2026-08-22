# Standalone bring-up app. Deliberately independent of ../../esp32-csi-node:
# it shares no sources, no components and no sdkconfig with the real
# firmware, so it stays buildable even when the main app does not build.
#
#   cd firmware/bringup/csi-hello
#   idf.py set-target esp32
#   idf.py menuconfig      # enter the AP SSID/password under "csi-hello"
#   idf.py flash monitor
cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(csi-hello)
