/* Tiny dependency-free assertion harness for the Home CSI host tests.
 *
 * No framework, no build-system magic: every test file is a standalone
 * `main()` that returns 0 on success and 1 on failure, printing one line per
 * check.  The runner (Makefile / run_tests.py) just executes each binary and
 * aggregates exit codes.
 */
#ifndef HCS_TEST_HARNESS_H
#define HCS_TEST_HARNESS_H

#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

static int hcs_test_failures;
static int hcs_test_checks;
static const char *hcs_test_suite = "?";

#define TEST_SUITE(name) (hcs_test_suite = (name))

#define CHECK(cond)                                                            \
    do {                                                                       \
        hcs_test_checks++;                                                     \
        if (!(cond)) {                                                         \
            hcs_test_failures++;                                               \
            printf("  FAIL %s:%d  CHECK(%s)\n", __FILE__, __LINE__, #cond);    \
        }                                                                      \
    } while (0)

#define CHECK_EQ_U64(actual, expected)                                         \
    do {                                                                       \
        hcs_test_checks++;                                                     \
        uint64_t a_ = (uint64_t)(actual);                                      \
        uint64_t e_ = (uint64_t)(expected);                                    \
        if (a_ != e_) {                                                        \
            hcs_test_failures++;                                               \
            printf("  FAIL %s:%d  %s: got %llu, want %llu\n", __FILE__,        \
                   __LINE__, #actual, (unsigned long long)a_,                  \
                   (unsigned long long)e_);                                    \
        }                                                                      \
    } while (0)

#define CHECK_EQ_I64(actual, expected)                                         \
    do {                                                                       \
        hcs_test_checks++;                                                     \
        int64_t a_ = (int64_t)(actual);                                        \
        int64_t e_ = (int64_t)(expected);                                      \
        if (a_ != e_) {                                                        \
            hcs_test_failures++;                                               \
            printf("  FAIL %s:%d  %s: got %lld, want %lld\n", __FILE__,        \
                   __LINE__, #actual, (long long)a_, (long long)e_);           \
        }                                                                      \
    } while (0)

static void hcs_test_hexdump(const char *label, const uint8_t *p, size_t n)
{
    printf("  %s (%zu bytes):", label, n);
    for (size_t i = 0; i < n; i++) {
        if ((i % 16) == 0) {
            printf("\n    %04zx  ", i);
        }
        printf("%02x ", p[i]);
    }
    printf("\n");
}

#define CHECK_BYTES(actual, expected, len)                                     \
    do {                                                                       \
        hcs_test_checks++;                                                     \
        if (memcmp((actual), (expected), (len)) != 0) {                        \
            hcs_test_failures++;                                               \
            printf("  FAIL %s:%d  byte mismatch (%s vs %s)\n", __FILE__,       \
                   __LINE__, #actual, #expected);                              \
            hcs_test_hexdump("got ", (const uint8_t *)(actual), (len));        \
            hcs_test_hexdump("want", (const uint8_t *)(expected), (len));      \
        }                                                                      \
    } while (0)

/* Loud, non-fatal notice used when a contract document cannot be checked
 * against (e.g. it still contains a generation placeholder).  Visible in the
 * test output so it cannot be quietly forgotten. */
#define TEST_NOTICE(...)                                                       \
    do {                                                                       \
        printf("  !! CONTRACT NOTICE: ");                                      \
        printf(__VA_ARGS__);                                                   \
        printf("\n");                                                          \
    } while (0)

static int hcs_test_report(void)
{
    if (hcs_test_failures == 0) {
        printf("PASS %-28s (%d checks)\n", hcs_test_suite, hcs_test_checks);
        return 0;
    }
    printf("FAIL %-28s (%d/%d checks failed)\n", hcs_test_suite,
           hcs_test_failures, hcs_test_checks);
    return 1;
}

#endif /* HCS_TEST_HARNESS_H */
