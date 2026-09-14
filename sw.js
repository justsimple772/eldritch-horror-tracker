
const CACHE="eh-tracker-v25";
const PRECACHE=["./","./index.html","./manifest.webmanifest","./mobile-ui.css?v=20260914-n","./icon-192.png","./icon-512.png","./apple-touch-icon.png"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRECACHE)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>/^eh-tracker-v\d+$/.test(k)&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("message",event=>{if(event.data&&event.data.type==="SKIP_WAITING") self.skipWaiting();});
self.addEventListener("fetch",event=>{
  const req=event.request, url=new URL(req.url);
  if(req.method!=="GET"||url.origin!==self.location.origin) return;
  if(url.searchParams.has("eh-update")){event.respondWith(fetch(req,{cache:"no-store"}));return;}
  const page=req.mode==="navigate"||url.pathname.endsWith("/")||url.pathname.endsWith("/index.html");
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    if(page){
      try{
        const res=await fetch(req,{cache:"no-cache"});
        if(res.ok) await cache.put("./index.html",res.clone());
        return res;
      }catch(error){const hit=await cache.match("./index.html");if(hit) return hit;throw error;}
    }
    const hit=await cache.match(req);
    if(hit) return hit;
    const res=await fetch(req);
    if(res.ok) await cache.put(req,res.clone());
    return res;
  })());
});

