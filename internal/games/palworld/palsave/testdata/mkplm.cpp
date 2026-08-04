// Dev-only helper: compress a raw GVAS blob into a Palworld "PlM" (Oodle
// Kraken) .sav container, so we can generate a test fixture in the new save
// format. Not shipped — palcon itself only ever decompresses.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

struct CompressOptions;
struct LRMCascade;

int CompressBlock(int codec_id, uint8_t *src_in, uint8_t *dst_in, int src_size,
                  int level, const CompressOptions *compressopts,
                  uint8_t *src_window_base, LRMCascade *lrm);

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: mkplm <raw-gvas-in> <sav-out>\n");
    return 2;
  }
  FILE *in = fopen(argv[1], "rb");
  if (!in) { perror("open input"); return 1; }
  std::vector<uint8_t> src;
  uint8_t buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, in)) > 0) src.insert(src.end(), buf, buf + n);
  fclose(in);

  std::vector<uint8_t> dst(src.size() + 65536);
  const int kKraken = 8, kLevelNormal = 4;
  int rc = CompressBlock(kKraken, src.data(), dst.data(), (int)src.size(),
                         kLevelNormal, nullptr, nullptr, nullptr);
  if (rc <= 0) { fprintf(stderr, "CompressBlock failed: %d\n", rc); return 1; }

  uint32_t uncompressed_len = (uint32_t)src.size();
  uint32_t compressed_len = (uint32_t)rc;
  FILE *out = fopen(argv[2], "wb");
  if (!out) { perror("open output"); return 1; }
  fwrite(&uncompressed_len, 4, 1, out);
  fwrite(&compressed_len, 4, 1, out);
  fwrite("PlM", 1, 3, out);
  uint8_t save_type = 0x31; // PLM / Oodle
  fwrite(&save_type, 1, 1, out);
  fwrite(dst.data(), 1, compressed_len, out);
  fclose(out);
  fprintf(stderr, "wrote %s: %u -> %u bytes\n", argv[2], uncompressed_len, compressed_len);
  return 0;
}
