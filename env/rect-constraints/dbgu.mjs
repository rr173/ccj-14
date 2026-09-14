const mem=new Map();
globalThis.localStorage={getItem:k=>mem.has(k)?mem.get(k):null,setItem:(k,v)=>mem.set(k,v),removeItem:k=>mem.delete(k)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let activeFetch=null; globalThis.fetch=(u,o)=>activeFetch(u,o);
globalThis.setTimeout=(f,ms,...a)=>setTimeout._r?.(f,ms,...a)??setTimeout; 
