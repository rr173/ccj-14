const mem=new Map();globalThis.localStorage={getItem:k=>mem.has(k)?mem.get(k):null,setItem:(k,v)=>mem.set(k,v),removeItem:k=>mem.delete(k)};
const BASE='http://127.0.0.1:8099';const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const realFetch=globalThis.fetch;
globalThis.fetch=async(u,o)=>{const res=await realFetch(u,o);
  if(o&&o.method==='PUT'){const j=await res.clone().json().catch(()=>({}));if(res.status!==200)console.log('PUT409',j.reason||j.error);}
  return res;};
const {Store}=await import('./web/js/geom/store.js');
process.chdir('/workspace/rect-constraints');
