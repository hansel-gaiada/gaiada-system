// Local control UI + JSON API for the capture-helper. Loopback-only. The single embedded page gives
// the operator the two record buttons and a live list of recordings with their pipeline + Drive state.
import { createServer } from "node:http";
import { config, driveConfigured } from "./config.mjs";
import * as jobs from "./jobs.mjs";

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
}

export function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${config.uiHost}`);
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGE); }
      if (req.method === "GET" && p === "/api/jobs") {
        return json(res, 200, { recording: jobs.isRecording(), driveConfigured: driveConfigured(), jobs: jobs.list() });
      }
      if (req.method === "POST" && p === "/api/record/start") {
        const b = await readBody(req);
        const job = await jobs.startRecord({ title: b.title, kind: b.kind === "video" ? "video" : "audio", clientId: b.clientId, projectId: b.projectId });
        return json(res, 201, job);
      }
      if (req.method === "POST" && p === "/api/record/stop") {
        return json(res, 200, await jobs.stopRecord());
      }
      const drive = p.match(/^\/api\/jobs\/([^/]+)\/drive$/);
      if (req.method === "POST" && drive) return json(res, 200, await jobs.uploadDrive(drive[1]));
      const ing = p.match(/^\/api\/jobs\/([^/]+)\/ingest$/);
      if (req.method === "POST" && ing) return json(res, 200, await jobs.reingest(ing[1]));
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 400, { error: String(e?.message ?? e) });
    }
  });
  server.listen(config.uiPort, config.uiHost);
  return server;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Gaiada Capture</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#faf9f7;color:#1a1916}
 header{padding:18px 22px;border-bottom:1px solid #0001}
 h1{font-size:18px;margin:0}
 main{padding:22px;max-width:820px}
 .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
 input{padding:9px 11px;border:1px solid #0002;border-radius:9px;font:inherit;min-width:260px}
 button{padding:9px 14px;border:1px solid #0002;border-radius:9px;background:#fff;font:inherit;cursor:pointer}
 button.pri{background:#1a1916;color:#fff;border-color:#1a1916}
 button:disabled{opacity:.5;cursor:default}
 .card{border:1px solid #0001;border-radius:12px;padding:13px 15px;margin-bottom:10px;background:#fff}
 .chip{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#0000000d;margin-left:6px}
 .muted{color:#00000088;font-size:12px}
 code{background:#0000000a;padding:1px 5px;border-radius:5px}
</style></head><body>
<header><h1>🎙️ Gaiada Capture Helper</h1><div class="muted" id="rec"></div></header>
<main>
 <div class="row">
  <input id="title" placeholder="Meeting title (e.g. Northwind — kickoff)">
 </div>
 <div class="row">
  <button class="pri" id="bAudio">🎙️ Record Audio</button>
  <button id="bVideo">🎥 Record Audio + Video</button>
  <button id="bStop" disabled>⏹ Stop</button>
 </div>
 <p class="muted">Local-first: saved on this machine, transcribed locally, only the transcript goes to the pipeline. Media syncs to Drive after.</p>
 <div id="list"></div>
</main>
<script>
const $=s=>document.querySelector(s);
async function api(m,u,b){const r=await fetch(u,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j;}
async function refresh(){
 try{const s=await api('GET','/api/jobs');
  $('#bStop').disabled=!s.recording;$('#bAudio').disabled=s.recording;$('#bVideo').disabled=s.recording;
  $('#rec').textContent=(s.recording?'● recording…':'idle')+(s.driveConfigured?'':' · Drive not configured (reminders only)');
  $('#list').innerHTML=s.jobs.map(j=>\`<div class="card"><b>\${j.title||j.meetingId}</b>
   <span class="chip">\${j.status}</span><span class="chip">drive: \${j.driveStatus}</span>
   \${j.runId?'<span class="chip">run '+j.runId.slice(0,8)+'</span>':''}
   <div class="muted">\${(j.log||[]).slice(-1)[0]||''}</div>
   <div style="margin-top:8px">
    \${j.file?'<button data-ing="'+j.id+'">Re-ingest</button> <button data-drv="'+j.id+'">Upload to Drive</button>':''}
    \${j.error?'<span class="muted" style="color:#b00">'+j.error+'</span>':''}
   </div></div>\`).join('')||'<p class="muted">No recordings yet.</p>';
 }catch(e){$('#rec').textContent='backend error: '+e.message;}
}
$('#bAudio').onclick=()=>api('POST','/api/record/start',{title:$('#title').value,kind:'audio'}).then(refresh).catch(e=>alert(e.message));
$('#bVideo').onclick=()=>api('POST','/api/record/start',{title:$('#title').value,kind:'video'}).then(refresh).catch(e=>alert(e.message));
$('#bStop').onclick=()=>api('POST','/api/record/stop').then(refresh).catch(e=>alert(e.message));
document.addEventListener('click',e=>{const d=e.target.dataset;if(d.drv)api('POST','/api/jobs/'+d.drv+'/drive').then(refresh).catch(x=>alert(x.message));if(d.ing)api('POST','/api/jobs/'+d.ing+'/ingest').then(refresh).catch(x=>alert(x.message));});
setInterval(refresh,2000);refresh();
</script></body></html>`;
