#include "onnxruntime_c_api.h"
#include <vector>
#include <fstream>
#include <iostream>
#include <chrono>
#include <sys/resource.h>
#include <string>
const OrtApi* api;
void check(OrtStatus* s) { if(s) { std::cerr<<api->GetErrorMessage(s)<<"\n"; api->ReleaseStatus(s); std::exit(1); } }
double rss() { std::ifstream f("/proc/self/status"); std::string key,line; while(f>>key) { if(key=="VmRSS:"){double n;f>>n;return n/1024;} std::getline(f,line); } return 0; }
template<class T> std::vector<T> read(const std::string& path) { std::ifstream f(path,std::ios::binary|std::ios::ate); if(!f){std::cerr<<"missing "<<path;std::exit(1);} auto bytes=f.tellg();std::vector<T> data(static_cast<size_t>(bytes)/sizeof(T));f.seekg(0);f.read(reinterpret_cast<char*>(data.data()),bytes);return data; }
int main(int argc,char** argv) {
 if(argc!=4) return 2;
 api=OrtGetApiBase()->GetApi(ORT_API_VERSION);
 if(!api) return 3;
 std::string path=argv[1],mode=argv[2],dir=argv[3];
 const double baseline=rss();
 OrtEnv* env;check(api->CreateEnv(ORT_LOGGING_LEVEL_WARNING,"luna-probe",&env));
 OrtSessionOptions* options;check(api->CreateSessionOptions(&options));
 check(api->SetIntraOpNumThreads(options,1));check(api->SetInterOpNumThreads(options,1));
 check(api->SetSessionExecutionMode(options,ORT_SEQUENTIAL));check(api->DisableCpuMemArena(options));check(api->DisableMemPattern(options));
 check(api->AddSessionConfigEntry(options,"session.intra_op.allow_spinning","0"));
 OrtSession* session;check(api->CreateSession(env,path.c_str(),options,&session));
 double loaded=rss();
 OrtMemoryInfo* memory;check(api->CreateCpuMemoryInfo(OrtArenaAllocator,OrtMemTypeDefault,&memory));
 std::vector<const char*> names;std::vector<OrtValue*> values;std::vector<float> pixels;std::vector<int64_t> ids,mask;
 if(mode=="image") {
  pixels=read<float>(dir+"/input-image.bin");int64_t shape[]={1,3,224,224};OrtValue* value;
  check(api->CreateTensorWithDataAsOrtValue(memory,pixels.data(),pixels.size()*sizeof(float),shape,4,ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,&value));
  names={"pixel_values"};values={value};
 } else {
  ids=read<int64_t>(dir+"/input-text.bin");mask.assign(ids.size(),1);int64_t shape[]={1,static_cast<int64_t>(ids.size())};
  for(auto* data:{&ids,&mask}) { OrtValue* value;check(api->CreateTensorWithDataAsOrtValue(memory,data->data(),data->size()*sizeof(int64_t),shape,2,ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,&value));values.push_back(value); }
  names={"input_ids","attention_mask"};
 }
 const char* output_name=mode=="image"?"image_embeds":"text_embeds";
 double elapsed=0;
 for(int i=0;i<20;i++) {
  OrtValue* output=nullptr;auto start=std::chrono::steady_clock::now();
  check(api->Run(session,nullptr,names.data(),values.data(),values.size(),&output_name,1,&output));
  elapsed+=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
  if(i==0) { void* raw;check(api->GetTensorMutableData(output,&raw));std::ofstream f(dir+"/native-"+mode+"-output.bin",std::ios::binary);f.write(static_cast<const char*>(raw),512*sizeof(float)); }
  api->ReleaseValue(output);
 }
 struct rusage usage;getrusage(RUSAGE_SELF,&usage);
 std::cout<<"{\"mode\":\""<<mode<<"\",\"baseline_rss_MiB\":"<<baseline<<",\"loaded_rss_MiB\":"<<loaded<<",\"final_rss_MiB\":"<<rss()<<",\"peak_rss_MiB\":"<<usage.ru_maxrss/1024.0<<",\"mean_inference_ms\":"<<elapsed/20<<"}\n";
 for(auto v:values)api->ReleaseValue(v);
 api->ReleaseMemoryInfo(memory);api->ReleaseSession(session);api->ReleaseSessionOptions(options);api->ReleaseEnv(env);
}
