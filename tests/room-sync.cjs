const { chromium } = require('playwright');
const fs = require('node:fs');
const http = require('node:http');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'..');
const source=fs.readFileSync(root+'/worker/src/index.js','utf8')
  .replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject {}')
  .replace('export default {','const worker = {').replace('export class Room','class Room');
const sandbox={Response,Date,TextDecoder,crypto:require('node:crypto').webcrypto};
vm.runInNewContext(source+'\nglobalThis.Room=Room;',sandbox);
const sockets=[], messages=[];
const ctx={blockConcurrencyWhile:fn=>fn(),storage:{get:async()=>null,put:async()=>{},setAlarm:async()=>{}},getWebSockets:()=>sockets};
const room=new sandbox.Room(ctx,{});
const server=http.createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  const file=root+(path==='/'?'/index.html':path);
  try {res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}
  catch {res.statusCode=404;res.end();}
});
(async()=>{
 await room.ready;
 Object.assign(room.room,{created:true,owner:'test-owner',open:[1,2,3],controlMode:'anyone'});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});
 try {
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:430,height:932}});
 await context.route(/https:\/\//,route=>route.fulfill({status:200,body:''}));
 await context.routeWebSocket(/workers\.dev/,ws=>{
   let attachment={uid:'',viewer:false};
   const socket={send:body=>ws.send(body),deserializeAttachment:()=>attachment,serializeAttachment:a=>attachment=a};
   sockets.push(socket);
   let pending=Promise.resolve();
   ws.onMessage(body=>{messages.push(JSON.parse(body));pending=pending.then(()=>room.webSocketMessage(socket,body));});
   ws.send(JSON.stringify(room.stateMessage()));
 });
 const errors=[];
 const player=await context.newPage();player.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:'+server.address().port;
 await player.goto(url);
 await player.evaluate(()=>{
   party={size:2,active:1,lead:0,tall:true,slots:[emptySlot(),emptySlot()]};
   applyInvToSlot(party.slots[0],INV.find(i=>i.id==='zoey'));
   applyInvToSlot(party.slots[1],INV.find(i=>i.id==='akachi'));save();
   document.getElementById('roomCode').value='TEST';joinRoom();
 });
 await player.waitForFunction(()=>net.openSeats.length===3);
 await player.evaluate(()=>{save();});
 assert.equal(messages.filter(m=>m.type==='snap').length,0,'no phantom snapshot before choosing a seat');
 await player.evaluate(()=>{clickSeat(1);finishJoinWithPicks();});
 await player.waitForFunction(()=>net.claimed&&net.board[0]?.invId==='akachi');
 assert.equal(await player.evaluate(()=>net.pick[1]),1);
 assert.equal(room.room.board[0].invId,'akachi');
 // Let asynchronous ACKs settle; a loop would keep adding snapshots.
 await new Promise(r=>setTimeout(r,300));
 assert.equal(messages.filter(m=>m.type==='snap').length,1,'snapshot ACK must not send another snapshot');
 const viewer=await context.newPage();viewer.on('pageerror',e=>errors.push(e.message));
 await viewer.goto(url);
 await viewer.evaluate(()=>{document.getElementById('roomCode').value='TEST';openSharedBoard();});
 await viewer.waitForFunction(()=>net.board[0]?.invId==='akachi');
 // Open and roll through the real dice UI's long press interaction.
 await player.locator('.skill[data-skill="lore"] .cell[data-part="val"]').first().dispatchEvent('pointerdown',{pointerId:1,clientX:100,clientY:300});
 await player.waitForFunction(()=>!document.getElementById('diceModal').hidden);
 await player.locator('#diceStage').click();
 await viewer.waitForFunction(()=>net.board[0]?.dice?.eventId&&!net.board[0].dice.rolling);
 assert.equal(await viewer.evaluate(()=>net.board[0].name),'아카치 오넬레');
 assert.ok(await viewer.locator('#boardDiceOverlay').isVisible());
 assert.ok(room.room.diceHistory.length>=1,'relay stored the roll');
 const result=await viewer.evaluate(()=>({name:net.board[0].name,values:net.board[0].dice.values,successes:net.board[0].dice.successes}));
 await player.locator('#diceClose').click();
 await viewer.waitForFunction(()=>net.board[0].dice===null);
 assert.equal(await player.evaluate(()=>net.board[0].dice),null);
 // Adding another investigator must not remap the existing seat.
 await player.evaluate(()=>{net.pickMode='join';clickSeat(2);finishJoinWithPicks();});
 await player.waitForFunction(()=>net.board[1]?.invId==='zoey');
 assert.equal(room.room.board[0].invId,'akachi');
 assert.equal(room.room.board[1].invId,'zoey');
 const settled=messages.filter(m=>m.type==='snap').length;
 await new Promise(r=>setTimeout(r,300));
 assert.equal(messages.filter(m=>m.type==='snap').length,settled);
 assert.deepEqual(errors,[]);
 console.log('PASS: active investigator joins, no pre-claim snapshot, no ACK loop, viewer receives real dice roll and close, relay history; '+JSON.stringify(result));
 await context.close();
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
