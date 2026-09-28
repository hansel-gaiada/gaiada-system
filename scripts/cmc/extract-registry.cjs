// Extracts the Client Centre registry from the CMC snapshot (docs/plans/2026-09-29-client-centre.md).
// Usage: node scripts/cmc/extract-registry.cjs cmc/origin/index.html <out.json>
// The input is GITIGNORED (it embeds real client profiles); the output is data-only.
const fs=require("fs"),vm=require("vm");
const html=fs.readFileSync(process.argv[2],"utf8").split(/\r?\n/);
const start=html.findIndex(l=>l.startsWith("const ICON = {"));
const end=html.findIndex(l=>l.startsWith("/* ---------- State & persistence"));
const src=html.slice(start,end).join("\n")+`
;({ICON,DEPARTMENTS,CONN_STATUS,CONN_METHOD,FIELD_GROUPS,F,C,SETTINGS,BUSINESS_TYPES,DEFAULT_OFF,INDUSTRY,GENERAL_FIELDS})`;
const R=vm.runInNewContext(src,{});
const norm=p=>typeof p==="string"?{name:p}:(Array.isArray(p.pages)?{id:p.id,name:p.name,...(p.items?{items:p.items}:{}),pages:p.pages.map(norm)}:{name:p.name,...(p.items?{items:p.items}:{})});
const fields={};for(const[k,[label,type,group,help]]of Object.entries(R.F))fields[k]={label,type,group,...(help?{help}:{})};
const connections={};for(const[k,[name,idLabel]]of Object.entries(R.C))connections[k]={name,idLabel};
const out={
 _comment:"GENERATED from cmc/origin/index.html (Company Management Centre, 2026-09-19) by the client-centre registry extractor. Data only: every field, connection, department, industry module and settings map CMC ships, title-cased exactly as CMC renders it. Do not hand-edit without bumping `version`.",
 version:1,
 fieldGroups:R.FIELD_GROUPS, fields, connections,
 connectionStatuses:R.CONN_STATUS, connectionMethods:R.CONN_METHOD,
 businessTypes:R.BUSINESS_TYPES.map(([id,label])=>({id,label})),
 defaultOffDepartments:R.DEFAULT_OFF,
 generalFields:R.GENERAL_FIELDS.map(([title,keys])=>({title,keys})),
 departments:R.DEPARTMENTS.map(d=>({id:d.id,name:d.name,pages:d.pages.map(norm)})),
 industryModules:Object.fromEntries(Object.entries(R.INDUSTRY).map(([t,m])=>[t,{id:m.id,name:m.name,pages:m.pages.map(norm),settings:m.settings}])),
 sectionSettings:R.SETTINGS,
 icons:R.ICON,
};
// integrity: every referenced key exists
const bad=[];
const chk=(where,s)=>{(s.fields||[]).forEach(k=>fields[k]||bad.push(where+" field "+k));(s.connections||[]).forEach(k=>connections[k]||bad.push(where+" conn "+k));};
Object.entries(R.SETTINGS).forEach(([k,s])=>chk("settings."+k,s));
Object.entries(R.INDUSTRY).forEach(([k,m])=>chk("industry."+k,m.settings));
R.GENERAL_FIELDS.forEach(([t,ks])=>ks.forEach(k=>fields[k]||bad.push("general "+k)));
fs.writeFileSync(process.argv[3],JSON.stringify(out,null,2)+"\n");
const sections=[];out.departments.forEach(d=>{sections.push(d.id);d.pages.forEach(p=>p.pages&&sections.push(p.id))});
console.log(JSON.stringify({fields:Object.keys(fields).length,connections:Object.keys(connections).length,groups:out.fieldGroups.length,departments:out.departments.length,sections:sections.length,settingsKeys:Object.keys(R.SETTINGS).length,sectionsWithoutSettings:sections.filter(s=>!R.SETTINGS[s]),industries:Object.keys(R.INDUSTRY).length,leafPages:JSON.stringify(out).match(/"name"/g).length,bad}));
