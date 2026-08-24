/*
 * test_version_sync.c - main/app_version.h and CMake's PROJECT_VER must agree.
 *
 * ============================ READ THIS ==============================
 * The firmware version exists in two places by necessity, not by choice:
 *
 *   main/app_version.h   HCS_FW_VERSION_MAJOR/MINOR/PATCH. Authoritative.
 *                        Reported in every HEARTBEAT (docs/protocol.md S10)
 *                        and in the device /device/hello body.
 *
 *   CMakeLists.txt       PROJECT_VER. ESP-IDF copies this - and ONLY this -
 *                        into the esp_app_desc_t that it embeds in the image
 *                        header. It is not derived from app_version.h and
 *                        cannot be: the header is compiled, the descriptor is
 *                        stamped by the build system.
 *
 * That descriptor is not cosmetic. main/ota.c reads it out of the OTHER OTA
 * slot via esp_ota_get_partition_description() to implement the anti-flap
 * rule ("never re-download the version the bootloader already rolled back").
 * If PROJECT_VER drifts from app_version.h, the version a node reports and
 * the version stamped in its slots stop matching, the anti-flap comparison
 * silently never matches, and a node behind a wall can loop
 * download -> boot -> rollback -> download forever.
 *
 * So the two are kept in sync mechanically, here, rather than by a comment
 * asking nicely. Bumping a version means editing both files; this test is
 * what tells you that you only edited one.
 * =====================================================================
 */
#include "harness.h"

#include <ctype.h>

static char *read_file(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (f == NULL) {
        return NULL;
    }
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return NULL;
    }
    const long sz = ftell(f);
    if (sz < 0 || fseek(f, 0, SEEK_SET) != 0) {
        fclose(f);
        return NULL;
    }
    char *buf = (char *)malloc((size_t)sz + 1u);
    if (buf == NULL) {
        fclose(f);
        return NULL;
    }
    const size_t got = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[got] = '\0';
    return buf;
}

/* Finds `#define <name> <int>` and returns the int, or -1 if absent. */
static long find_define_int(const char *text, const char *name)
{
    const char *p = text;
    const size_t n = strlen(name);
    while ((p = strstr(p, name)) != NULL) {
        /* Whole-token match only, so MAJOR never matches inside MAJOR_FOO. */
        const int left_ok = (p == text) || (isalnum((unsigned char)p[-1]) == 0
                                            && p[-1] != '_');
        const char after = p[n];
        if (left_ok && (after == ' ' || after == '\t')) {
            const char *v = p + n;
            while (*v == ' ' || *v == '\t') {
                v++;
            }
            if (isdigit((unsigned char)*v)) {
                return strtol(v, NULL, 10);
            }
        }
        p += n;
    }
    return -1;
}

/* Extracts the quoted value of `set(PROJECT_VER "...")`, tolerating
 * whitespace variations, into `out`. Returns 0 on success. */
static int find_project_ver(const char *text, char *out, size_t cap)
{
    const char *p = strstr(text, "PROJECT_VER");
    if (p == NULL) {
        return -1;
    }
    p = strchr(p, '"');
    if (p == NULL) {
        return -1;
    }
    p++;
    size_t i = 0;
    while (*p != '\0' && *p != '"') {
        if (i + 1u >= cap) {
            return -1;
        }
        out[i++] = *p++;
    }
    if (*p != '"') {
        return -1;
    }
    out[i] = '\0';
    return 0;
}

static void test_project_ver_matches_app_version_h(const char *repo_root)
{
    char path[1024];
    const char *fw = "firmware/esp32-csi-node";

    snprintf(path, sizeof path, "%s/%s/main/app_version.h", repo_root, fw);
    char *hdr = read_file(path);
    if (hdr == NULL) {
        printf("  FAIL cannot open %s\n", path);
        CHECK(hdr != NULL);
        return;
    }

    const long major = find_define_int(hdr, "HCS_FW_VERSION_MAJOR");
    const long minor = find_define_int(hdr, "HCS_FW_VERSION_MINOR");
    const long patch = find_define_int(hdr, "HCS_FW_VERSION_PATCH");
    free(hdr);

    CHECK(major >= 0);
    CHECK(minor >= 0);
    CHECK(patch >= 0);
    if (major < 0 || minor < 0 || patch < 0) {
        printf("  could not parse HCS_FW_VERSION_MAJOR/MINOR/PATCH out of "
               "%s - did the macro names change?\n",
               path);
        return;
    }

    snprintf(path, sizeof path, "%s/%s/CMakeLists.txt", repo_root, fw);
    char *cml = read_file(path);
    if (cml == NULL) {
        printf("  FAIL cannot open %s\n", path);
        CHECK(cml != NULL);
        return;
    }

    char project_ver[64];
    const int found = find_project_ver(cml, project_ver, sizeof project_ver);
    free(cml);

    CHECK_EQ_I64(found, 0);
    if (found != 0) {
        printf("  %s has no `set(PROJECT_VER \"x.y.z\")`. ESP-IDF stamps "
               "esp_app_desc_t.version from PROJECT_VER, and main/ota.c "
               "compares that descriptor against the OTA manifest. Without "
               "it the image reports version \"1\" and the anti-flap check "
               "in ota.c can never match.\n",
               path);
        return;
    }

    char expect[64];
    snprintf(expect, sizeof expect, "%ld.%ld.%ld", major, minor, patch);

    const int agree = (strcmp(project_ver, expect) == 0);
    if (!agree) {
        printf("  VERSION DRIFT: main/app_version.h says %s, CMakeLists.txt "
               "PROJECT_VER says \"%s\". app_version.h is authoritative - "
               "update PROJECT_VER to match it. Do NOT relax this test: the "
               "two values end up in the heartbeat and in the image "
               "descriptor respectively, and main/ota.c compares the "
               "descriptor against the OTA manifest.\n",
               expect, project_ver);
    }
    CHECK(agree);
}

int main(int argc, char **argv)
{
    TEST_SUITE("firmware version single source");
    test_project_ver_matches_app_version_h((argc > 1) ? argv[1] : "../..");
    return hcs_test_report();
}
