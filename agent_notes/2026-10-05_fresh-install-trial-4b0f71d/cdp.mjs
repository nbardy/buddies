// usage: node cdp.mjs <json-array of steps>. steps: {goto}|{eval}|{shot,w,h,mobile}|{sleep}|{type:selector,text}
import fs from 'node:fs';
const tabs = await (await fetch('http://localhost:9333/json')).json();
const page = tabs.find(t=>t.type==='page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);
let id=0; const pend=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}};
const send=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});
const ev=async(expr)=>{const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});return r.result?.result?.value ?? r.result?.exceptionDetails?.text};
await send('Page.enable');
for (const s of JSON.parse(process.argv[2])) {
  if (s.viewport) await send('Emulation.setDeviceMetricsOverride',{width:s.viewport[0],height:s.viewport[1],deviceScaleFactor:s.viewport[0]<500?2:1,mobile:s.viewport[0]<500});
  if (s.goto) { await send('Page.navigate',{url:s.goto}); await new Promise(r=>setTimeout(r,s.wait??2500)); }
  if (s.reload) { await send('Page.reload'); await new Promise(r=>setTimeout(r,s.wait??2500)); }
  if (s.click) for (const t of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type:t,x:s.click[0],y:s.click[1],button:'left',clickCount:1});
  if (s.eval) console.log('eval:', JSON.stringify(await ev(s.eval)));
  if (s.sleep) await new Promise(r=>setTimeout(r,s.sleep));
  if (s.shot) { const r=await send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(s.shot,Buffer.from(r.result.data,'base64')); console.log('shot',s.shot); }
}
ws.close(); process.exit(0);
