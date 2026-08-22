# ESP-IDF v5.x project definition for the Home CSI node firmware.
#
# Build:  idf.py set-target esp32 && idf.py build
# The `components/` directory alongside this file is picked up automatically;
# components/csi_protocol holds the wire-format code that is shared verbatim
# with the host tests in ../tests.
cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(esp32-csi-node)
