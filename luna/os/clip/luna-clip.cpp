// luna-clip: runs one TinyCLIP encoder for lunad's photo search.
//
// lunad is a static musl binary and can't load ONNX Runtime's shared
// library, so the model runs here: a small program linked against Alpine's
// libonnxruntime, started by lunad as `nobody` with memory and CPU caps, fed
// over stdin and answering on stdout. lunad does all parsing (tokenizing,
// decoding thumbnails); this program only ever sees fixed-size tensors.
//
//   luna-clip <encoder.onnx> image   requests: 3*224*224 float32 (CHW, normalized)
//   luna-clip <encoder.onnx> text    requests: u32 n, then n int64 token ids (n <= 77)
//
// Each request gets 512 little-endian float32 back (the embedding, not yet
// normalized). EOF on stdin ends the program with status 0; any error ends
// it with a message on stderr and a non-zero status, and lunad starts a new
// one if it still needs it.
//
// Build: see build.sh (alpine:3.24, onnxruntime-dev).

#include "onnxruntime_c_api.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

const OrtApi* api = nullptr;
constexpr int kDim = 512;
constexpr int kSide = 224;
constexpr uint32_t kMaxTokens = 77;

[[noreturn]] void die(const char* what) {
  std::fprintf(stderr, "luna-clip: %s\n", what);
  std::exit(1);
}

void check(OrtStatus* status) {
  if (status) {
    std::fprintf(stderr, "luna-clip: %s\n", api->GetErrorMessage(status));
    api->ReleaseStatus(status);
    std::exit(1);
  }
}

// Read exactly n bytes; false on clean EOF before the first byte.
bool read_exact(void* buf, size_t n) {
  auto* p = static_cast<char*>(buf);
  size_t got = 0;
  while (got < n) {
    size_t r = std::fread(p + got, 1, n - got, stdin);
    if (r == 0) {
      if (got == 0 && std::feof(stdin)) return false;
      die("short request");
    }
    got += r;
  }
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::fprintf(stderr, "usage: luna-clip <encoder.onnx> image|text\n");
    return 2;
  }
  const std::string model = argv[1];
  const std::string mode = argv[2];
  if (mode != "image" && mode != "text") die("mode must be image or text");

  api = OrtGetApiBase()->GetApi(ORT_API_VERSION);
  if (!api) die("this ONNX Runtime is too old");

  // One thread, no arena, no spinning: the box keeps serving files while
  // this works, and memory stays close to the model's own size.
  OrtEnv* env;
  check(api->CreateEnv(ORT_LOGGING_LEVEL_ERROR, "luna-clip", &env));
  OrtSessionOptions* options;
  check(api->CreateSessionOptions(&options));
  check(api->SetIntraOpNumThreads(options, 1));
  check(api->SetInterOpNumThreads(options, 1));
  check(api->SetSessionExecutionMode(options, ORT_SEQUENTIAL));
  check(api->DisableCpuMemArena(options));
  check(api->DisableMemPattern(options));
  check(api->AddSessionConfigEntry(options, "session.intra_op.allow_spinning", "0"));
  OrtSession* session;
  check(api->CreateSession(env, model.c_str(), options, &session));
  OrtMemoryInfo* memory;
  check(api->CreateCpuMemoryInfo(OrtDeviceAllocator, OrtMemTypeDefault, &memory));

  const bool image = mode == "image";
  const char* output_name = image ? "image_embeds" : "text_embeds";
  std::vector<float> pixels(image ? 3 * kSide * kSide : 0);
  std::vector<int64_t> ids;
  std::vector<int64_t> mask;

  // Ready: lunad waits for this byte so a model that fails to load is
  // reported at start, not on the first request.
  std::fputc('R', stdout);
  std::fflush(stdout);

  for (;;) {
    std::vector<OrtValue*> inputs;
    std::vector<const char*> names;
    if (image) {
      if (!read_exact(pixels.data(), pixels.size() * sizeof(float))) break;
      int64_t shape[] = {1, 3, kSide, kSide};
      OrtValue* value;
      check(api->CreateTensorWithDataAsOrtValue(memory, pixels.data(), pixels.size() * sizeof(float), shape, 4,
                                                ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &value));
      inputs = {value};
      names = {"pixel_values"};
    } else {
      uint32_t n;
      if (!read_exact(&n, sizeof n)) break;
      if (n == 0 || n > kMaxTokens) die("bad token count");
      ids.resize(n);
      read_exact(ids.data(), n * sizeof(int64_t));
      mask.assign(n, 1);
      int64_t shape[] = {1, static_cast<int64_t>(n)};
      for (auto* data : {&ids, &mask}) {
        OrtValue* value;
        check(api->CreateTensorWithDataAsOrtValue(memory, data->data(), data->size() * sizeof(int64_t), shape, 2,
                                                  ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64, &value));
        inputs.push_back(value);
      }
      names = {"input_ids", "attention_mask"};
    }
    OrtValue* output = nullptr;
    check(api->Run(session, nullptr, names.data(), inputs.data(), inputs.size(), &output_name, 1, &output));
    OrtTensorTypeAndShapeInfo* info;
    check(api->GetTensorTypeAndShape(output, &info));
    size_t count;
    check(api->GetTensorShapeElementCount(info, &count));
    api->ReleaseTensorTypeAndShapeInfo(info);
    if (count != kDim) die("unexpected output size");
    void* raw;
    check(api->GetTensorMutableData(output, &raw));
    if (std::fwrite(raw, sizeof(float), kDim, stdout) != kDim) die("write failed");
    std::fflush(stdout);
    api->ReleaseValue(output);
    for (auto* v : inputs) api->ReleaseValue(v);
  }

  api->ReleaseMemoryInfo(memory);
  api->ReleaseSession(session);
  api->ReleaseSessionOptions(options);
  api->ReleaseEnv(env);
  return 0;
}
