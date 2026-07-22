// Generator for pipeline-delivery.json — full delivery state machine.
// 2026-07-22: extended with WS11 tails — A) bounded revise loop on client changes_requested,
// B) production deploy gate (staging sign-off -> prod approval -> deploy.production -> production stage).
import { writeFileSync } from "node:fs";

const OUT = "c:/Users/Hansel/Documents/Hansel/Projects/gaiada-system/gaiada-system/automation/workflows/pipeline-delivery.json";
const HUB_HEADERS = [
  { name: "Authorization", value: "=Bearer {{ $env.HUB_SERVICE_TOKEN }}" },
  { name: "Content-Type", value: "application/json" },
  { name: "Accept", value: "application/json, text/event-stream" },
  { name: "x-obo-provider", value: "n8n" },
  { name: "x-obo-external-id", value: "wf:delivery" },
];
const nodes = [];
const conn = {};
const link = (from, to, outIdx = 0) => {
  conn[from] = conn[from] || { main: [] };
  while (conn[from].main.length <= outIdx) conn[from].main.push([]);
  conn[from].main[outIdx].push({ node: to, type: "main", index: 0 });
};
const pos = (x, y) => [x, y];
function mcp(name, id, argsExpr, x, y, opts = {}) {
  const node = {
    parameters: {
      method: "POST", url: "http://mcp-hub:3003/mcp", sendHeaders: true,
      headerParameters: { parameters: HUB_HEADERS },
      sendBody: true, specifyBody: "json",
      jsonBody: `={{ JSON.stringify({ jsonrpc: "2.0", id: ${id}, method: "tools/call", params: { name: "${name}", arguments: ${argsExpr} } }) }}`,
      options: { response: { response: { responseFormat: "text" } } },
    },
    name: opts.label || `MCP ${name}`, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos(x, y),
  };
  if (opts.continueOnFail) node.onError = "continueRegularOutput";
  nodes.push(node);
  return node.name;
}
function code(label, js, x, y) {
  nodes.push({ parameters: { jsCode: js }, name: label, type: "n8n-nodes-base.code", typeVersion: 2, position: pos(x, y) });
  return label;
}
function ifEq(label, field, value, x, y) {
  nodes.push({
    parameters: { conditions: { options: { caseSensitive: true, typeValidation: "loose", version: 2 }, conditions: [{ id: label, leftValue: `={{ ${field} }}`, rightValue: value, operator: { type: "string", operation: "equals" } }], combinator: "and" }, options: {} },
    name: label, type: "n8n-nodes-base.if", typeVersion: 2.2, position: pos(x, y),
  });
  return label;
}
function respond(label, bodyExpr, x, y) {
  nodes.push({ parameters: { respondWith: "json", responseBody: `=${bodyExpr}` }, name: label, type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: pos(x, y) });
  return label;
}
function webhook(label, path, x, y, wid) {
  nodes.push({ parameters: { httpMethod: "POST", path, responseMode: "responseNode" }, name: label, type: "n8n-nodes-base.webhook", typeVersion: 2, position: pos(x, y), webhookId: wid });
  return label;
}

const SSE = `const raw = $input.first().json.data ?? $input.first().json.body ?? '';\nconst line = String(raw).split('\\n').find((l) => l.startsWith('data:')) ?? '';\nconst rpc = JSON.parse(line.slice(5).trim());`;
const verify = `const got = $input.first().json.headers?.['x-gaiada-bridge-secret'];\nif (!got || got !== $env.N8N_BRIDGE_SECRET) throw new Error('bad bridge secret');\nconst e = $input.first().json.body ?? {};\nif (e.v !== 1) throw new Error('bad envelope v');\nconst runId = e.payload?.runId ?? e.entityId;\nconst store = $getWorkflowStaticData('global'); store.seen = store.seen || {};\nconst dup = Object.prototype.hasOwnProperty.call(store.seen, e.id);\nif (!dup) { store.seen[e.id] = Date.now(); const ids = Object.keys(store.seen); if (ids.length > 1000) for (const k of ids.slice(0, ids.length - 1000)) delete store.seen[k]; }\nreturn [{ json: { dup, tenantId: e.tenantId, runId } }];`;

// ---- triggers + load ----
webhook("Trigger: gate.decided", "ev/pipeline.gate.decided", 0, -120, "e4b7c3d2-delivery-gate-decided-001");
code("Verify (gate)", verify, 200, -120);
webhook("Trigger: scope.signed", "ev/scope.signed", 0, 100, "e4b7c3d2-delivery-scope-signed-001");
code("Verify (scope)", verify, 200, 100);
mcp("pipeline.getRun", 1, "{ tenantId: $json.tenantId, runId: $json.runId }", 420, -10, { label: "MCP getRun" });
link("Trigger: gate.decided", "Verify (gate)"); link("Verify (gate)", "MCP getRun");
link("Trigger: scope.signed", "Verify (scope)"); link("Verify (scope)", "MCP getRun");

// Load + decide: derive the next action from run state.
// `design` = the LATEST claude_design stage (so a bounded revise loop can add revisions and the
// existence-based beat checks operate per-stage). Prod tail is a forward pass keyed by staging.id.
const decide = `${SSE}\nif (rpc.result?.isError) throw new Error(rpc.result.content?.[0]?.text ?? 'getRun failed');\nconst run = JSON.parse(rpc.result?.content?.[0]?.text ?? '{}');\nconst stages = run.stages||[], gates = run.gates||[], signoffs = run.scopeSignoffs||[];\nconst prdSigned = gates.some(g=>g.kind==='prd_sign'&&g.decision==='signed');\nconst scopeSigned = (signoffs.some(s=>s.party==='provider')&&signoffs.some(s=>s.party==='client'))||gates.some(g=>g.kind==='scope_signoff'&&g.decision==='signed');\nconst designs = stages.filter(s=>s.name==='claude_design'); const design = designs[designs.length-1];\nconst code = stages.find(s=>s.name==='claude_code'); const staging = stages.find(s=>s.name==='staging'); const prodStage = stages.find(s=>s.name==='production');\nconst MAX_DESIGNS = 3;\nconst gof=(kind,sid)=>gates.filter(g=>g.kind===kind&&g.stage_id===sid).sort((a,b)=>a.created_at<b.created_at?-1:1).pop();\nconst ok=g=>g&&g.status==='decided'&&g.decision==='approved';\nconst has=(kind,sid)=>gates.some(g=>g.kind===kind&&g.stage_id===sid);\nconst prd=(stages.find(s=>s.name==='prd_extract')||{}).artifact_ref||'';\nconst slug=String(run.title||('run-'+run.id)).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);\nlet action='noop',nextKind='',nextActor='',stageId='',note='';\nif(prdSigned&&scopeSigned){\n  if(!design){action='release_design';}\n  else {\n    const cfd=gof('customer_feedback',design.id);\n    if(ok(gof('pm_review',design.id))&&!has('customer_feedback',design.id)){action='open_gate';nextKind='customer_feedback';nextActor='client';stageId=design.id;note='Submission beat 2 — client feedback';}\n    else if(cfd&&cfd.status==='decided'&&cfd.decision==='changes_requested'){ if(designs.length<MAX_DESIGNS){action='revise_design';note=cfd.note||'';} else {action='escalate_revise';note=cfd.note||'';} }\n    else if(ok(cfd)&&!has('pm_approval',design.id)){action='open_gate';nextKind='pm_approval';nextActor='internal';stageId=design.id;note='Submission beat 3 — PM approval';}\n    else if(ok(gof('pm_approval',design.id))&&!code){action='release_code';}\n    else if(code&&ok(gof('pm_review',code.id))&&!staging){action='deploy';}\n    else if(staging&&ok(gof('customer_feedback',staging.id))&&!has('pm_approval',staging.id)){action='open_gate';nextKind='pm_approval';nextActor='internal';stageId=staging.id;note='Production approval';}\n    else if(staging&&ok(gof('pm_approval',staging.id))&&!prodStage){action='deploy_prod';}\n  }\n}\nconst proto=(design||{}).artifact_ref||'';\nreturn [{ json: { tenantId: run.tenant_id, runId: run.id, action, nextKind, nextActor, stageId, note, prd, proto, slug } }];`;
code("Load + decide", decide, 640, -10);
link("MCP getRun", "Load + decide");

// ---- routing IF-chain ----
ifEq("Release design?", "$json.action", "release_design", 860, -10);
link("Load + decide", "Release design?");

// A) release_design chain
mcp("design.prototype", 2, "{ prd: $json.prd }", 1080, -260, { label: "MCP design.prototype" });
code("Parse prototype", `${SSE}\nif (rpc.result?.isError) throw new Error(rpc.result.content?.[0]?.text ?? 'design failed');\nlet p={};try{p=JSON.parse(rpc.result?.content?.[0]?.text??'{}')}catch{}\nconst d=$('Load + decide').first().json;\nreturn [{ json: { tenantId:d.tenantId, runId:d.runId, doc:p.content??'' } }];`, 1300, -260);
mcp("pipeline.createStage", 3, '{ tenantId: $json.tenantId, runId: $json.runId, track: "delivery", name: "claude_design", status: "awaiting_gate", artifactRef: $json.doc }', 1520, -260, { label: "MCP createStage design" });
code("Parse design stage", `${SSE}\nif (rpc.result?.isError) throw new Error(rpc.result.content?.[0]?.text ?? 'createStage failed');\nconst s=JSON.parse(rpc.result?.content?.[0]?.text??'{}');\nconst d=$('Load + decide').first().json;\nreturn [{ json: { tenantId:d.tenantId, runId:d.runId, stageId:s.id } }];`, 1740, -260);
mcp("pipeline.openGate", 4, '{ tenantId: $json.tenantId, runId: $json.runId, stageId: $json.stageId, kind: "pm_review", actorSide: "internal", note: "Prototype ready — Submission beat 1 (PM/UI review)" }', 1960, -260, { label: "MCP openGate pm_review(design)" });
respond("Respond (released)", `{{ JSON.stringify({ ok:true, action:'released_design', runId:$('Load + decide').first().json.runId }) }}`, 2180, -260);
link("Release design?", "MCP design.prototype", 0);
link("MCP design.prototype", "Parse prototype"); link("Parse prototype", "MCP createStage design");
link("MCP createStage design", "Parse design stage"); link("Parse design stage", "MCP openGate pm_review(design)");
link("MCP openGate pm_review(design)", "Respond (released)");

// B) open_gate (next beat: design beat2/beat3 OR prod approval) — note carried from decide
ifEq("Open next gate?", "$json.action", "open_gate", 1080, -10);
link("Release design?", "Open next gate?", 1);
mcp("pipeline.openGate", 5, '{ tenantId: $json.tenantId, runId: $json.runId, stageId: $json.stageId, kind: $json.nextKind, actorSide: $json.nextActor, note: ($json.note || "Submission beat") }', 1300, -60, { label: "MCP openGate next" });
respond("Respond (opened)", `{{ JSON.stringify({ ok:true, action:'opened_'+$('Load + decide').first().json.nextKind }) }}`, 1520, -60);
link("Open next gate?", "MCP openGate next", 0); link("MCP openGate next", "Respond (opened)");

// C) release_code
ifEq("Release code?", "$json.action", "release_code", 1080, 180);
link("Open next gate?", "Release code?", 1);
mcp("github.repoStatus", 6, "{ repo: $('Load + decide').first().json.slug }", 1300, 120, { label: "MCP github.repoStatus", continueOnFail: true });
code("Repo ready?", `${SSE.replace("const raw","let raw")}\nlet ready=false, reason='';\ntry{ if(rpc.result?.isError){reason=rpc.result.content?.[0]?.text||'repo check failed';} else { const r=JSON.parse(rpc.result?.content?.[0]?.text??'{}'); ready=!!r.exists; if(!ready) reason='repo does not exist yet'; } }catch(e){ reason='github not configured'; }\nconst d=$('Load + decide').first().json;\nreturn [{ json: { tenantId:d.tenantId, runId:d.runId, prd:d.prd, proto:d.proto, slug:d.slug, ready, reason } }];`, 1520, 120);
ifEq("Repo exists?", "$json.ready", "true", 1740, 120);
mcp("code.scaffold", 7, "{ prd: $json.prd, prototype: $json.proto, repo: $json.slug }", 1960, 60, { label: "MCP code.scaffold" });
code("Parse code", `${SSE}\nif (rpc.result?.isError) throw new Error(rpc.result.content?.[0]?.text ?? 'code.scaffold failed');\nlet p={};try{p=JSON.parse(rpc.result?.content?.[0]?.text??'{}')}catch{}\nconst d=$('Load + decide').first().json;\nreturn [{ json: { tenantId:d.tenantId, runId:d.runId, doc:p.content??'' } }];`, 2180, 60);
mcp("pipeline.createStage", 8, '{ tenantId: $json.tenantId, runId: $json.runId, track: "delivery", name: "claude_code", status: "awaiting_gate", artifactRef: $json.doc }', 2400, 60, { label: "MCP createStage code" });
code("Parse code stage", `${SSE}\nif (rpc.result?.isError) throw new Error(rpc.result.content?.[0]?.text ?? 'createStage failed');\nconst s=JSON.parse(rpc.result?.content?.[0]?.text??'{}');\nconst d=$('Load + decide').first().json;\nreturn [{ json: { tenantId:d.tenantId, runId:d.runId, stageId:s.id } }];`, 2620, 60);
mcp("pipeline.openGate", 9, '{ tenantId: $json.tenantId, runId: $json.runId, stageId: $json.stageId, kind: "pm_review", actorSide: "internal", note: "Code ready to stage — Web Dev review" }', 2840, 60, { label: "MCP openGate web-dev" });
respond("Respond (code)", `{{ JSON.stringify({ ok:true, action:'released_code', runId:$('Load + decide').first().json.runId }) }}`, 3060, 60);
link("Release code?", "MCP github.repoStatus", 0);
link("MCP github.repoStatus", "Repo ready?"); link("Repo ready?", "Repo exists?");
link("Repo exists?", "MCP code.scaffold", 0);
link("MCP code.scaffold", "Parse code"); link("Parse code", "MCP createStage code");
link("MCP createStage code", "Parse code stage"); link("Parse code stage", "MCP openGate web-dev");
link("MCP openGate web-dev", "Respond (code)");
mcp("notify", 10, '{ tenantId: $json.tenantId, recipientId: $env.NOTIFY_USER_ID, type: "repo_needed", payload: { runId: $json.runId, repo: $json.slug, reason: $json.reason } }', 1960, 220, { label: "MCP notify repo_needed" });
respond("Respond (repo needed)", `{{ JSON.stringify({ ok:true, action:'repo_needed', reason:$json.reason }) }}`, 2180, 220);
link("Repo exists?", "MCP notify repo_needed", 1); link("MCP notify repo_needed", "Respond (repo needed)");

// D) deploy (staging): deploy.staging (fail-soft) -> staging stage -> notify -> (if deployed) open client staging sign-off gate
ifEq("Deploy?", "$json.action", "deploy", 1080, 400);
link("Release code?", "Deploy?", 1);
mcp("deploy.staging", 11, "{ repo: $('Load + decide').first().json.slug, ref: 'main', runId: $('Load + decide').first().json.runId }", 1300, 400, { label: "MCP deploy.staging", continueOnFail: true });
code("Deploy result", `${SSE.replace("const raw","let raw")}\nlet ok2=false, reason='';\ntry{ if(rpc.result?.isError){reason=rpc.result.content?.[0]?.text||'deploy failed';} else { ok2=true; } }catch(e){ reason='deploy not configured'; }\nconst d=$('Load + decide').first().json;\nreturn [{ json: { tenantId:d.tenantId, runId:d.runId, ok2, reason, status: ok2?'done':'failed' } }];`, 1520, 400);
mcp("pipeline.createStage", 12, '{ tenantId: $json.tenantId, runId: $json.runId, track: "delivery", name: "staging", status: $json.status, artifactRef: ($json.ok2 ? "deployed to staging" : $json.reason) }', 1740, 400, { label: "MCP createStage staging" });
code("After staging", `${SSE}\nif (rpc.result?.isError) throw new Error(rpc.result.content?.[0]?.text ?? 'createStage staging failed');\nconst s=JSON.parse(rpc.result?.content?.[0]?.text??'{}');\nconst dr=$('Deploy result').first().json;\nreturn [{ json: { tenantId:dr.tenantId, runId:dr.runId, ok2:dr.ok2, reason:dr.reason, stagingStageId:s.id, ok2str:String(!!dr.ok2) } }];`, 1960, 400);
mcp("notify", 13, '{ tenantId: $json.tenantId, recipientId: $env.NOTIFY_USER_ID, type: ($json.ok2 ? "staging_deployed" : "staging_deploy_failed"), payload: { runId: $json.runId, reason: $json.reason } }', 2180, 400, { label: "MCP notify staging" });
ifEq("Staging deployed?", "$('After staging').first().json.ok2str", "true", 2400, 400);
mcp("pipeline.openGate", 14, '{ tenantId: $(\'After staging\').first().json.tenantId, runId: $(\'After staging\').first().json.runId, stageId: $(\'After staging\').first().json.stagingStageId, kind: "customer_feedback", actorSide: "client", note: "Staging is live — client sign-off before production" }', 2620, 320, { label: "MCP openGate staging-signoff" });
respond("Respond (deploy)", `{{ JSON.stringify({ ok:true, action:'deploy', deployed:$('Deploy result').first().json.ok2 }) }}`, 2840, 400);
link("Deploy?", "MCP deploy.staging", 0);
link("MCP deploy.staging", "Deploy result"); link("Deploy result", "MCP createStage staging");
link("MCP createStage staging", "After staging"); link("After staging", "MCP notify staging");
link("MCP notify staging", "Staging deployed?");
link("Staging deployed?", "MCP openGate staging-signoff", 0); link("MCP openGate staging-signoff", "Respond (deploy)");
link("Staging deployed?", "Respond (deploy)", 1);

// E) revise_design (Tail A, bounded): regenerate the prototype from the client feedback note,
// add a NEW claude_design revision stage, reopen the PM/UI review beat.
ifEq("Revise design?", "$json.action", "revise_design", 1080, 620);
link("Deploy?", "Revise design?", 1);
mcp("design.prototype", 15, "{ prd: $('Load + decide').first().json.prd, notes: $('Load + decide').first().json.note }", 1300, 620, { label: "MCP design.prototype (revise)" });
code("Parse revise", `${SSE}\nif (rpc.result?.isError) throw new Error(rpc.result.content?.[0]?.text ?? 'design revise failed');\nlet p={};try{p=JSON.parse(rpc.result?.content?.[0]?.text??'{}')}catch{}\nconst d=$('Load + decide').first().json;\nreturn [{ json: { tenantId:d.tenantId, runId:d.runId, doc:p.content??'' } }];`, 1520, 620);
mcp("pipeline.createStage", 16, '{ tenantId: $json.tenantId, runId: $json.runId, track: "delivery", name: "claude_design", status: "awaiting_gate", artifactRef: $json.doc }', 1740, 620, { label: "MCP createStage design (revise)" });
code("Parse revise stage", `${SSE}\nif (rpc.result?.isError) throw new Error(rpc.result.content?.[0]?.text ?? 'createStage revise failed');\nconst s=JSON.parse(rpc.result?.content?.[0]?.text??'{}');\nconst d=$('Load + decide').first().json;\nreturn [{ json: { tenantId:d.tenantId, runId:d.runId, stageId:s.id } }];`, 1960, 620);
mcp("pipeline.openGate", 17, '{ tenantId: $json.tenantId, runId: $json.runId, stageId: $json.stageId, kind: "pm_review", actorSide: "internal", note: "Revised prototype — Submission beat 1 (PM/UI review)" }', 2180, 620, { label: "MCP openGate pm_review(revise)" });
respond("Respond (revised)", `{{ JSON.stringify({ ok:true, action:'revised_design', runId:$('Load + decide').first().json.runId }) }}`, 2400, 620);
link("Revise design?", "MCP design.prototype (revise)", 0);
link("MCP design.prototype (revise)", "Parse revise"); link("Parse revise", "MCP createStage design (revise)");
link("MCP createStage design (revise)", "Parse revise stage"); link("Parse revise stage", "MCP openGate pm_review(revise)");
link("MCP openGate pm_review(revise)", "Respond (revised)");

// F) escalate_revise: revise budget exhausted -> notify PM (human takes over).
ifEq("Escalate revise?", "$json.action", "escalate_revise", 1080, 820);
link("Revise design?", "Escalate revise?", 1);
mcp("notify", 18, '{ tenantId: $json.tenantId, recipientId: $env.NOTIFY_USER_ID, type: "revise_budget_exhausted", payload: { runId: $json.runId, note: $json.note } }', 1300, 820, { label: "MCP notify revise-escalation" });
respond("Respond (escalated)", `{{ JSON.stringify({ ok:true, action:'escalated_revise', runId:$('Load + decide').first().json.runId }) }}`, 1520, 820);
link("Escalate revise?", "MCP notify revise-escalation", 0); link("MCP notify revise-escalation", "Respond (escalated)");

// G) deploy_prod (Tail B): deploy.production (fail-soft) -> production stage -> notify.
ifEq("Deploy prod?", "$json.action", "deploy_prod", 1080, 1020);
link("Escalate revise?", "Deploy prod?", 1);
mcp("deploy.production", 19, "{ repo: $('Load + decide').first().json.slug, ref: 'main', runId: $('Load + decide').first().json.runId }", 1300, 1020, { label: "MCP deploy.production", continueOnFail: true });
code("Prod result", `${SSE.replace("const raw","let raw")}\nlet ok3=false, reason='';\ntry{ if(rpc.result?.isError){reason=rpc.result.content?.[0]?.text||'prod deploy failed';} else { ok3=true; } }catch(e){ reason='prod deploy not configured'; }\nconst d=$('Load + decide').first().json;\nreturn [{ json: { tenantId:d.tenantId, runId:d.runId, ok3, reason, status: ok3?'done':'failed' } }];`, 1520, 1020);
mcp("pipeline.createStage", 20, '{ tenantId: $json.tenantId, runId: $json.runId, track: "delivery", name: "production", status: $json.status, artifactRef: ($json.ok3 ? "deployed to production" : $json.reason) }', 1740, 1020, { label: "MCP createStage production" });
code("After prod", `${SSE}\nif (rpc.result?.isError) throw new Error(rpc.result.content?.[0]?.text ?? 'createStage production failed');\nconst pr=$('Prod result').first().json;\nreturn [{ json: { tenantId:pr.tenantId, runId:pr.runId, ok3:pr.ok3, reason:pr.reason } }];`, 1960, 1020);
mcp("notify", 21, '{ tenantId: $json.tenantId, recipientId: $env.NOTIFY_USER_ID, type: ($json.ok3 ? "production_deployed" : "production_deploy_failed"), payload: { runId: $json.runId, reason: $json.reason } }', 2180, 1020, { label: "MCP notify production" });
respond("Respond (prod)", `{{ JSON.stringify({ ok:true, action:'deploy_prod', deployed:$('Prod result').first().json.ok3 }) }}`, 2400, 1020);
link("Deploy prod?", "MCP deploy.production", 0);
link("MCP deploy.production", "Prod result"); link("Prod result", "MCP createStage production");
link("MCP createStage production", "After prod"); link("After prod", "MCP notify production");
link("MCP notify production", "Respond (prod)");

// noop
respond("Respond (noop)", `{{ JSON.stringify({ ok:true, action:'noop' }) }}`, 1300, 1220);
link("Deploy prod?", "Respond (noop)", 1);

const wf = {
  id: "ws11delivery0001",
  name: "WS11 delivery track (hard gate -> design -> 3-beat -> revise loop -> Claude Code -> staging -> prod)",
  meta: { description: "WS11 build item 8 (full) + tails. Stateless event-driven delivery state machine; state lives in the DB. Triggers ev/pipeline.gate.decided + ev/scope.signed. Path: hard gate (prd_sign+scope) -> design.prototype -> claude_design -> pm_review(b1) -> customer_feedback(b2) -> [changes_requested => BOUNDED REVISE LOOP: regenerate prototype from feedback -> new claude_design revision -> reopen b1, up to 3 designs then escalate to PM] -> pm_approval(b3) -> release_code (repoStatus gate) -> web-dev review -> deploy.staging -> staging stage + notify -> client staging sign-off (customer_feedback on staging) -> pm_approval (prod) -> deploy.production -> production stage + notify. github.repoStatus/deploy.staging/deploy.production fail SOFT. All actions OBO as wf:delivery. Env: N8N_BRIDGE_SECRET, HUB_SERVICE_TOKEN, NOTIFY_USER_ID; hub creds GITHUB_TOKEN/GITHUB_ORG/DEPLOY_STAGING_URL/DEPLOY_PRODUCTION_URL." },
  nodes, connections: conn, settings: {}, pinData: {},
};
writeFileSync(OUT, JSON.stringify(wf, null, 2));
const names = new Set(nodes.map((n) => n.name));
let bad = 0;
for (const [s, c] of Object.entries(conn)) { if (!names.has(s)) { console.log("MISS SRC", s); bad++; } for (const g of c.main) for (const x of g) if (!names.has(x.node)) { console.log("MISS TGT", x.node, "from", s); bad++; } }
// every non-terminal node should have an outgoing link (except respond/noop terminals)
console.log(nodes.length, "nodes,", bad ? "BROKEN " + bad : "refs OK");
