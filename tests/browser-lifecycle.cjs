const { chromium }=require('playwright');
const fs=require('node:fs'),http=require('node:http'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'..');
const source=fs.readFileSync(root+'/worker/src/index.js','utf8')
 .replace('import { DurableObject } from "cloudflare:workers";','class DurableObject {}')
 .replace('export default {','const worker = {').replace('export class Room','class Room');
const sandbox={Response,Date,TextDecoder,crypto:require('node:crypto').webcrypto};
vm.runInNewContext(source+'\nglobalThis.Room=Room;',sandbox);
const sockets=[],connections=[],errors=[];let queue=Promise.resolve(),snapshots=0;
const storage=new Map();
const room=new sandbox.Room({blockConcurrencyWhile:fn=>fn(),getWebSockets:()=>sockets,
 storage:{get:async k=>storage.get(k),put:async(k,v)=>storage.set(k,structuredClone(v)),setAlarm:async()=>{}}},{});
const server=http.createServer((req,res)=>{
 const file=root+(new URL(req.url,'http://localhost').pathname==='/'?'/index.html':new URL(req.url,'http://localhost').pathname);
 try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}
 catch{res.statusCode=404;res.end();}
});
(async()=>{
 await room.ready;Object.assign(room.room,{created:true,owner:'test-owner',open:[1,2,3,4,5,6,7,8]});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});
 try{
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:430,height:932}});
 context.setDefaultTimeout(15000);
 await context.route(/https:\/\//,r=>r.fulfill({status:200,body:''}));
 await context.routeWebSocket(/workers\.dev/,ws=>{
  let attachment={uid:'',viewer:false},closed=false;
  const socket={send:body=>{if(!closed)ws.send(body);},deserializeAttachment:()=>attachment,serializeAttachment:a=>attachment=a};
  sockets.push(socket);
  const disconnect=()=>{if(closed)return;closed=true;sockets.splice(sockets.indexOf(socket),1);queue=queue.then(()=>room.webSocketClose(socket));};
  connections.push({socket,disconnect:()=>{disconnect();ws.close({code:1001,reason:'simulated network interruption'});}});
  ws.onMessage(body=>{if(JSON.parse(body).type==='snap')snapshots++;queue=queue.then(()=>room.webSocketMessage(socket,body));});
  ws.onClose(disconnect);
  ws.send(JSON.stringify(room.stateMessage()));
 });
 const pages=await Promise.all(Array.from({length:8},()=>context.newPage()));
 const url='http://127.0.0.1:'+server.address().port;
 await Promise.all(pages.map(p=>{p.on('pageerror',e=>errors.push(e.message));return p.goto(url);}));
 await Promise.all(pages.map((p,i)=>p.evaluate(i=>{
  party={size:1,active:0,lead:0,tall:true,slots:[emptySlot()]};applyInvToSlot(state(),INV[i]);
  save();document.getElementById('roomCode').value='TEST';joinRoom();
 },i)));
 await Promise.all(pages.map(p=>p.waitForFunction(()=>net.openSeats.length===8)));
 const ids=await Promise.all(pages.map(p=>p.evaluate(()=>net.uid)));
 assert.equal(new Set(ids).size,8,'tabs must not share player identities');
 await Promise.all(pages.map((p,i)=>p.evaluate(i=>{clickSeat(i+1);finishJoinWithPicks();},i)));
 await Promise.all(pages.map(p=>p.waitForFunction(()=>net.claimed&&Object.keys(net.board).length===8)));
 const viewer=await context.newPage();viewer.on('pageerror',e=>errors.push(e.message));await viewer.goto(url);
 await viewer.evaluate(()=>{document.getElementById('roomCode').value='TEST';openSharedBoard();});
 await viewer.waitForFunction(()=>Object.keys(net.board).length===8);
 for(let round=0;round<20;round++){
  await Promise.all(pages.map((p,i)=>p.evaluate(({i,round})=>{state().loc='round-'+round+'-player-'+i;save();},{i,round})));
  await viewer.waitForFunction(round=>Object.values(net.board).every(p=>p.loc?.startsWith('round-'+round+'-')),round);
 }
 // Leave and immediately rejoin: the previous delayed leave must not eject us.
 await pages[0].evaluate(()=>document.getElementById('roomLeave').onclick());
 await viewer.waitForFunction(()=>Object.keys(net.board).length===7);
 await pages[0].evaluate(()=>{document.getElementById('roomCode').value='TEST';joinRoom();});
 await pages[0].waitForFunction(()=>!net.taken[1]);
 await pages[0].evaluate(()=>{clickSeat(1);finishJoinWithPicks();});
 await viewer.waitForFunction(()=>Object.keys(net.board).length===8);
 await new Promise(r=>setTimeout(r,1100));
 assert.equal(await pages[0].evaluate(()=>net.role),'player');
 assert.equal(Object.keys(room.room.board).length,8);
 // Reconnection must preserve the occupied seat and re-publish fresh state.
 const original=connections.find(c=>c.socket.deserializeAttachment().uid===ids[1]);
 await pages[1].evaluate(()=>window.oldRoomSocket=net.cfws);
 original.disconnect();await queue;
 assert.equal(room.room.board[1].uid,ids[1]);
 await viewer.waitForFunction(()=>Object.keys(net.board).length===8);
 await pages[1].waitForFunction(()=>net.cfws?.readyState===1&&net.cfws!==window.oldRoomSocket&&net.claimed);
 await pages[1].evaluate(()=>{state().loc='after-reconnect';save();window.oldRoomSocket.onmessage({data:JSON.stringify({type:'roomState',created:true,board:{},open:[],taken:{}})});});
 await viewer.waitForFunction(()=>net.board[1]?.loc==='after-reconnect');
 assert.equal(await pages[1].evaluate(()=>Object.keys(net.board).length),8,'stale socket must not overwrite current room');
 const before=snapshots;await new Promise(r=>setTimeout(r,300));
 assert.equal(snapshots,before,'no ACK resend loop at 8 players');
 // Exercise the 8 -> 6 -> 8 range as well as single-person churn.
 await Promise.all(pages.slice(6).map(p=>p.evaluate(()=>document.getElementById('roomLeave').onclick())));
 await viewer.waitForFunction(()=>Object.keys(net.board).length===6);
 for(let i=0;i<6;i++)assert.equal(room.room.board[i].uid,ids[i]);
 await Promise.all(pages.slice(6).map(p=>p.evaluate(()=>{document.getElementById('roomCode').value='TEST';joinRoom();})));
 await Promise.all(pages.slice(6).map(p=>p.waitForFunction(()=>!net.taken[7]&&!net.taken[8])));
 await Promise.all(pages.slice(6).map((p,i)=>p.evaluate(i=>{clickSeat(i+7);finishJoinWithPicks();},i)));
 await viewer.waitForFunction(()=>Object.keys(net.board).length===8);
 await Promise.all(pages.map(p=>p.evaluate(()=>document.getElementById('roomLeave').onclick())));
 await viewer.waitForFunction(()=>Object.keys(net.board).length===0);
 assert.equal(Object.keys(room.room.board).length,0);
 assert.deepEqual(errors,[]);
 console.log('PASS: 8 browser tabs + viewer, 160 updates, 8->6->8 participants, isolated identities, immediate leave/rejoin, network interruption/reconnect, stale socket ignored, no ACK loop, all departures reflected');
 await context.close();
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
