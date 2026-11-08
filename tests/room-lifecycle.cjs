const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname,'../worker/src/index.js'),'utf8')
  .replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject {}')
  .replace('export default {', 'const worker = {').replace('export class Room', 'class Room');
let now=Date.now();
class Clock extends Date { static now(){return now;} }
const sandbox={Response,TextDecoder,Date:Clock,crypto:webcrypto};
vm.runInNewContext(source+'\nglobalThis.Room=Room;',sandbox);
async function setup(){
 const sockets=[],storage=new Map();
 const ctx={blockConcurrencyWhile:f=>f(),getWebSockets:()=>sockets,
 storage:{get:async k=>storage.get(k),put:async(k,v)=>storage.set(k,structuredClone(v)),setAlarm:async()=>{},deleteAll:async()=>storage.clear()}};
 const room=new sandbox.Room(ctx,{});await room.ready;
 Object.assign(room.room,{created:true,owner:'owner',open:[1,2,3,4,5,6,7,8]});
 const connect=(uid,viewer=false)=>{
  let attachment={uid,viewer};const messages=[];
  const socket={messages,send:s=>messages.push(JSON.parse(s)),deserializeAttachment:()=>attachment,serializeAttachment:a=>attachment=a};
  sockets.push(socket);return socket;
 };
 const send=(s,type,extra={})=>room.webSocketMessage(s,JSON.stringify({type,uid:s.deserializeAttachment().uid,...extra}));
 const claim=async(s,seat)=>{await send(s,'claim',{seats:[seat]});};
 const snap=async(s,seat,n=0)=>send(s,'snap',{data:{seat,uid:s.deserializeAttachment().uid,name:s.deserializeAttachment().uid,invId:'akachi',skills:{lore:n},t:now,dice:null}});
 const close=async s=>{sockets.splice(sockets.indexOf(s),1);await room.webSocketClose(s);};
 return {room,connect,send,claim,snap,close,storage,ctx};
}
const cases=[];const test=(name,fn)=>cases.push([name,fn]);
test('8 participants: 100 rounds of concurrent state updates and leave/rejoin',async()=>{
 const t=await setup();const players=Array.from({length:8},(_,i)=>t.connect('p'+i));
 await Promise.all(players.map((s,i)=>t.claim(s,i+1)));
 for(let round=0;round<100;round++){
  await Promise.all(players.map((s,i)=>t.snap(s,i+1,round)));
  assert.equal(Object.keys(t.room.room.board).length,8);
  const ix=round%8;await t.send(players[ix],'leave',{seats:[ix+1]});
  assert.equal(t.room.room.board[ix],undefined);
  assert.equal(Object.keys(t.room.room.board).length,7);
  await t.claim(players[ix],ix+1);await t.snap(players[ix],ix+1,round);
  for(let i=0;i<8;i++)assert.equal(t.room.room.board[i].uid,'p'+i);
 }
});
test('8 simultaneous claims on one empty seat: exactly one accepted',async()=>{
 const t=await setup();const players=Array.from({length:8},(_,i)=>t.connect('race'+i));
 await Promise.all(players.map(s=>t.claim(s,1)));
 assert.equal(players.filter(s=>s.messages.some(m=>m.type==='ok')).length,1);
 assert.equal(players.filter(s=>s.messages.some(m=>m.type==='deny'&&m.reason==='busy')).length,7);
});
test('occupied seat rejects another participant snapshot',async()=>{
 const t=await setup(),a=t.connect('a'),b=t.connect('b');
 await t.claim(a,1);await t.snap(a,1);await t.claim(b,1);await t.snap(b,1);
 assert.equal(t.room.room.board[0].uid,'a');
});
test('a viewer / another player leaving cannot delete occupied seats',async()=>{
 const t=await setup(),a=t.connect('a'),viewer=t.connect('viewer',true);
 await t.claim(a,1);await t.snap(a,1);await t.send(viewer,'leave',{seats:[1]});
 assert.equal(t.room.room.board[0]?.uid,'a');
});
test('closing an older connection cannot remove its replacement',async()=>{
 const t=await setup(),old=t.connect('a');await t.claim(old,1);await t.snap(old,1);
 const replacement=t.connect('a');await t.claim(replacement,1);await t.snap(replacement,1,2);
 await t.close(old);assert.equal(t.room.room.board[0]?.uid,'a');
});
test('temporary disconnection reserves seat, rejoin retains it',async()=>{
 const t=await setup(),a=t.connect('a');await t.claim(a,1);await t.snap(a,1);
 await t.close(a);assert.equal(t.room.room.board[0]?.uid,'a');
 const b=t.connect('b');await t.send(b,'hello');await t.claim(b,1);
 assert.ok(b.messages.some(m=>m.type==='deny'&&m.reason==='busy'));
 const back=t.connect('a');await t.claim(back,1);await t.snap(back,1);
 assert.equal(t.room.room.board[0]?.uid,'a');
});
test('explicit leave is immediate; late snapshot cannot resurrect it',async()=>{
 const t=await setup(),a=t.connect('a');await t.claim(a,1);await t.snap(a,1);
 await t.send(a,'leave',{seats:[1]});await t.snap(a,1);
 assert.equal(t.room.room.board[0],undefined);
});
test('abandoned connection expires and frees its seat',async()=>{
 const t=await setup(),a=t.connect('a');await t.claim(a,1);await t.snap(a,1);await t.close(a);
 now+=91_000;await t.room.alarm();assert.equal(t.room.room.board[0],undefined);
 const b=t.connect('b');await t.claim(b,1);await t.snap(b,1);assert.equal(t.room.room.board[0].uid,'b');
});
test('invalid seat and unclaimed snapshots cannot enter the board',async()=>{
 const t=await setup(),a=t.connect('a');await t.snap(a,1);await t.snap(a,NaN);
 assert.equal(Object.keys(t.room.room.board).length,0);
});
test('persisted room restoration retains live socket ownership',async()=>{
 const t=await setup(),a=t.connect('a');await t.claim(a,1);await t.snap(a,1);
 const restored=new sandbox.Room(t.ctx,{});await restored.ready;
 await restored.webSocketMessage(a,JSON.stringify({type:'hello',uid:'a'}));
 assert.equal(restored.room.board[0]?.uid,'a');
 await restored.webSocketMessage(a,JSON.stringify({type:'snap',uid:'a',data:{seat:1,name:'restored',skills:{},dice:null}}));
 assert.equal(restored.room.board[0]?.name,'restored');
});
(async()=>{let failed=0;for(const [name,fn]of cases){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+'\n'+e.message);}}
 console.log(`${cases.length-failed}/${cases.length} scenarios passed`);process.exitCode=failed?1:0;})();
