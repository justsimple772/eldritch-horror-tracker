const CACHE="eh-tracker-v7";
const PRECACHE=["./","./index.html","./manifest.webmanifest","./icon-192.png","./icon-512.png","./apple-touch-icon.png"];
self.addEventListener("install", event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRECACHE)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("message", event=>{
  if(event.data && event.data.type==="SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("fetch", event=>{
  const req=event.request;
  if(req.method!=="GET") return;
  const url=new URL(req.url);
  const isPage=req.mode==="navigate" || url.pathname.endsWith("/") || url.pathname.endsWith("/index.html") || url.pathname.endsWith("sw.js");
  if(isPage){
    event.respondWith(
      fetch(req).then(res=>{
        const copy=res.clone();
        if(res.ok) caches.open(CACHE).then(c=>c.put(req, copy));
        return res;
      }).catch(()=>caches.match(req).then(h=>h||caches.match("./index.html")))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then(hit=>hit||fetch(req).then(res=>{
      const copy=res.clone();
      if(res.ok && req.url.startsWith(self.location.origin)){
        caches.open(CACHE).then(c=>c.put(req, copy));
      }
      return res;
    }).catch(()=>caches.match("./index.html")))
  );
});
