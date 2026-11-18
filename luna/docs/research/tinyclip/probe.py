"""Standalone research probe; never invoked by Luna or CI. See README.md."""
import os
os.environ['OMP_NUM_THREADS']='1'
os.environ['OPENBLAS_NUM_THREADS']='1'
import sys,json,time,resource,pathlib,subprocess,statistics
P=pathlib.Path(os.environ.get('LUNA_TINYCLIP_CACHE', '/tmp/luna-tinyclip-research'))

def rss():
 for line in pathlib.Path('/proc/self/status').read_text().splitlines():
  if line.startswith('VmRSS:'):return int(line.split()[1])/1024

def worker(model,mode):
 import numpy as np
 import onnxruntime as ort
 from PIL import Image,ImageOps
 from tokenizers import Tokenizer
 baseline=rss(); start=time.perf_counter()
 opts=ort.SessionOptions();opts.intra_op_num_threads=1;opts.inter_op_num_threads=1
 opts.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
 opts.enable_cpu_mem_arena=False;opts.enable_mem_pattern=False
 opts.add_session_config_entry('session.intra_op.allow_spinning','0')
 session=ort.InferenceSession(str(P/f'{model}-{mode}.onnx'),sess_options=opts,providers=['CPUExecutionProvider'])
 load_s=time.perf_counter()-start;loaded=rss()
 rows=json.loads((P/'evaluation-rows.json').read_text())['rows']
 tok=None
 if mode=='text':
  tok=Tokenizer.from_file(str(P/'tokenizer.json'));tok.enable_truncation(max_length=77)
 means=np.array([.48145466,.4578275,.40821073],dtype=np.float32)
 std=np.array([.26862954,.26130258,.27577711],dtype=np.float32)
 output=open(P/f'{model}-{mode}-vectors.bin','wb');times=[]
 for row in rows:
  items=[None] if mode=='image' else [row['row'][f'caption_{i}'] for i in range(5)]
  for item in items:
   start=time.perf_counter()
   if mode=='image':
    with Image.open(P/'images'/f"{row['row_idx']:04d}.jpg") as original:
     im=ImageOps.exif_transpose(original).convert('RGB')
     w,h=im.size
     size=(224,int(224*h/w)) if w<h else (int(224*w/h),224)
     im=im.resize(size,Image.Resampling.BICUBIC)
     left=(im.width-224)//2;top=(im.height-224)//2
     im=im.crop((left,top,left+224,top+224))
     a=np.asarray(im,dtype=np.float32)/255
     a=(a-means)/std
     inputs={'pixel_values':np.ascontiguousarray(a.transpose(2,0,1)[None])}
   else:
    enc=tok.encode(item)
    inputs={'input_ids':np.array([enc.ids],dtype=np.int64),'attention_mask':np.array([enc.attention_mask],dtype=np.int64)}
   v=session.run(None,inputs)[0][0]
   times.append((time.perf_counter()-start)*1000)
   output.write(v.astype(np.float32).tobytes())
 output.close()
 print(json.dumps({'model':model,'mode':mode,'onnxruntime':ort.__version__,'count':len(times),'baseline_rss_MiB':baseline,'loaded_rss_MiB':loaded,'final_rss_MiB':rss(),'peak_rss_MiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,'load_seconds':load_s,'mean_ms':statistics.mean(times),'p90_ms':float(np.percentile(times,90)),'p99_ms':float(np.percentile(times,99))}))

def main():
 import numpy as np
 results=[]
 for model in ['model','model_int8']:
  for mode in ['image','text']:
   p=subprocess.run([sys.executable,__file__,'worker',model,mode],capture_output=True,text=True)
   if p.returncode:
    r={'model':model,'mode':mode,'error':p.stderr[-2500:]};print(json.dumps(r),flush=True)
   else:r=json.loads(p.stdout);print(json.dumps(r),flush=True)
   results.append(r)
 metrics={}; ranks={};scores={}
 for model in ['model','model_int8']:
  if any('error' in r for r in results if r['model']==model):continue
  im=np.fromfile(P/f'{model}-image-vectors.bin',dtype=np.float32).reshape(-1,512);tx=np.fromfile(P/f'{model}-text-vectors.bin',dtype=np.float32).reshape(-1,512)
  im/=np.linalg.norm(im,axis=1,keepdims=True);tx/=np.linalg.norm(tx,axis=1,keepdims=True)
  sim=tx@im.T;order=np.argsort(-sim,axis=1);truth=np.repeat(np.arange(len(im)),5)
  rank=np.argmax(order==truth[:,None],axis=1)+1
  metrics[model]={f'recall_at_{k}':float(np.mean(rank<=k)) for k in [1,5,10]}
  metrics[model]['median_rank']=float(np.median(rank));ranks[model]=rank;scores[model]=order
  np.save(P/f'{model}-ranks.npy',rank)
 if len(metrics)==2:
  metrics['comparison']={'top1_agreement':float(np.mean(scores['model'][:,0]==scores['model_int8'][:,0])), 'mean_image_cosine':float(np.mean(np.sum(np.fromfile(P/'model-image-vectors.bin',dtype=np.float32).reshape(-1,512)*np.fromfile(P/'model_int8-image-vectors.bin',dtype=np.float32).reshape(-1,512),axis=1))), 'mean_text_cosine':float(np.mean(np.sum(np.fromfile(P/'model-text-vectors.bin',dtype=np.float32).reshape(-1,512)*np.fromfile(P/'model_int8-text-vectors.bin',dtype=np.float32).reshape(-1,512),axis=1)))}
 out={'workers':results,'retrieval':metrics,'dataset':'jxie/flickr8k test rows 0:1000, all 5 captions per image; 1000 candidate images, 5000 queries'}
 (P/'results.json').write_text(json.dumps(out,indent=2));print(json.dumps(metrics,indent=2),flush=True)
 if any('error' in result for result in results):
  raise RuntimeError('An encoder probe failed; inspect the recorded errors.')
if __name__=='__main__':
 if len(sys.argv)>1:worker(sys.argv[2],sys.argv[3])
 else:main()
