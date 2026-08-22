# Host tests for the Home CSI firmware.
#
#   make            build and run everything
#   make CC=clang   pick a compiler
#   make clean
#
# There is no ESP32 and no ESP-IDF involved here: these tests compile the
# pure, hardware-independent sources under
# ../esp32-csi-node/components/csi_protocol - the SAME files the firmware
# build compiles - with a plain host C compiler.
#
# On a machine without `make` (e.g. Windows on ARM64, the primary dev box for
# this project) use the equivalent Python runner instead:
#
#   python run_tests.py
#   CC="zig cc" python run_tests.py

CC      ?= cc
PROTO    = ../esp32-csi-node/components/csi_protocol
BUILD    = build

CFLAGS  += -std=c11 -Wall -Wextra -Werror -Wno-unused-function -O1 -g \
           -DHCS_HOST_BUILD=1 -I. -I$(PROTO)/include -Isupport

SHARED   = $(PROTO)/csi_codec.c \
           $(PROTO)/csi_ring.c \
           $(PROTO)/csi_batcher.c \
           $(PROTO)/bw_budget.c \
           $(PROTO)/seq_epoch.c

SUPPORT  = support/ref_chacha20poly1305.c

TESTS    = $(wildcard test_*.c)
BINS     = $(patsubst test_%.c,$(BUILD)/test_%,$(TESTS))

REPO_ROOT = ../..

.PHONY: all run clean
all: run

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/test_%: test_%.c $(SHARED) $(SUPPORT) harness.h | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $< $(SHARED) $(SUPPORT)

run: $(BINS)
	@fail=0; \
	for b in $(BINS); do \
	  ./$$b $(REPO_ROOT) || fail=1; \
	done; \
	if [ $$fail -ne 0 ]; then echo "TESTS FAILED"; exit 1; fi; \
	echo "All test binaries passed."

clean:
	rm -rf $(BUILD)
