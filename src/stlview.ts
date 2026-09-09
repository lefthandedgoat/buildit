// Self-contained browser STL viewer (zero dependencies, works from file://).
//
// front.ts embeds the ASCII STL directly into the page, so there is no
// fetch (blocked under file://) and no CDN: double-click view-bench.html,
// drag to rotate, wheel to zoom. Pure Canvas 2D software renderer —
// rotate normals + vertices, Lambert shade, painter-sort, fill.
//
// Shift+click part inspection (optional 3rd arg `boxes`): the STL itself
// carries no part identity, but boxesToStl emits boxes in order at 12
// facets per box, so facet index // 12 recovers the source box. The page
// embeds the Box list as JSON, hit-tests the projected triangles
// topmost-first on shift+click, and shows a details panel (dims, position,
// process, note + a dimensioned mini-SVG (longest-face elevation, wide flats drawn rotated) while highlighting every
// identical part (same partId + same dx/dy/dz). A left parts tree groups identical boxes with show/hide checkboxes and click-to-select; the right panel is drag-resizable.

import type { Box } from "./assembly.ts";

/** Escape for embedding inside <script> (blocks </script> breakouts). */
function jsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

/** Stable identity for "identical parts": same partId + same dimensions. */
export function boxKey(b: Pick<Box, "partId" | "dx" | "dy" | "dz">): string {
  const r = (n: number): string => String(Math.round(n * 1000) / 1000);
  return `${b.partId}|${r(b.dx)}x${r(b.dy)}x${r(b.dz)}`;
}

/** Indices of all boxes identical to boxes[idx] (includes idx itself). */
export function identicalBoxes(
  boxes: Pick<Box, "partId" | "dx" | "dy" | "dz">[],
  idx: number,
): number[] {
  if (idx < 0 || idx >= boxes.length) return [];
  const key = boxKey(boxes[idx]);
  const out: number[] = [];
  for (let i = 0; i < boxes.length; i++)
    if (boxKey(boxes[i]) === key) out.push(i);
  return out;
}

/** Scale fitting two stacked rects (widths <= wMax, heights summing to hSum) into availW x maxH. */
export function fitScale(
  wMax: number,
  hSum: number,
  availW: number,
  maxH: number,
): number {
  const sw = (availW - 52) / Math.max(wMax, 1);
  const sh = (maxH - 92) / Math.max(hSum, 1);
  return Math.max(0.01, Math.min(sw, sh));
}

/** Drawn detail views for one box: longest-face elevation (+90deg rotation for wide flats) and plan. */
export interface DetailViews {
  ew: number;
  eh: number;
  pw: number;
  ph: number;
  eLabel: string;
  pLabel: string;
}

export function detailViews(
  b: Pick<Box, "partId" | "dx" | "dy" | "dz">,
): DetailViews {
  const r = (n: number): string => String(Math.round(n * 1000) / 1000);
  const alongY = b.dy > b.dx;
  const longH = Math.max(b.dx, b.dy);
  const eName = alongY ? "side" : "front";
  let ew = longH;
  let eh = b.dz;
  const eRot = ew / Math.max(eh, 1e-9) > 3;
  let pw = b.dx;
  let ph = b.dy;
  const pRot = pw / Math.max(ph, 1e-9) > 3;
  const eLabel = `${eName} ${r(longH)} x ${r(b.dz)}mm${eRot ? " (shown rotated)" : ""}`;
  const pLabel = `top ${r(b.dx)} x ${r(b.dy)}mm${pRot ? " (shown rotated)" : ""}`;
  if (eRot) [ew, eh] = [eh, ew];
  if (pRot) [pw, ph] = [ph, pw];
  return { ew, eh, pw, ph, eLabel, pLabel };
}

/** One row of the viewer parts tree: identical boxes grouped under a count. */
export interface BoxGroup {
  key: string;
  partId: string;
  dims: string;
  indices: number[];
}

/** Group box indices by identity (same partId + dims), first-seen order. */
export function groupBoxes(
  boxes: Pick<Box, "partId" | "dx" | "dy" | "dz">[],
): BoxGroup[] {
  const groups: BoxGroup[] = [];
  const byKey = new Map<string, BoxGroup>();
  const r = (n: number): string => String(Math.round(n * 1000) / 1000);
  boxes.forEach((b, i) => {
    const key = boxKey(b);
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        partId: b.partId,
        dims: `${r(b.dx)} x ${r(b.dy)} x ${r(b.dz)}`,
        indices: [],
      };
      byKey.set(key, g);
      groups.push(g);
    }
    g.indices.push(i);
  });
  return groups;
}

/** Distinct stations in first-seen order ("" = unstationed boxes, e.g.
 * bench). The viewer tree renders one collapsible section per station. */
export function stationsOf(boxes: Pick<Box, "station">[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const b of boxes) {
    const s = b.station ?? "";
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export function stlViewerHtml(
  stlText: string,
  title: string,
  boxes?: Box[],
): string {
  const escTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const boxJson = JSON.stringify(boxes ?? []).replace(/</g, "\\x3c");
  const picking = boxes !== undefined;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${escTitle}</title>
<style>
  html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#111;color:#eee}
  #wrap{display:flex;height:calc(100vh - 42px)}
  #c{display:block;flex:1;min-width:0;height:100%;touch-action:none;cursor:grab}
  #bar{height:42px;display:flex;align-items:center;gap:12px;padding:0 12px;background:#1c1c1c;font-size:13px}
  #bar b{font-weight:600}
  #bar .hint{opacity:.65}
  button{background:#333;color:#eee;border:1px solid #555;border-radius:6px;padding:4px 10px;cursor:pointer}
  button[aria-pressed="true"]{background:#0a5dc2;border-color:#0a5dc2}
  #panel{display:none;width:300px;flex:none;overflow:auto;background:#1c1c1c;border-left:1px solid #333;padding:12px;font-size:13px}
  #panel.show{display:block}
  #panel h2{margin:0 0 4px;font-size:15px}
  #panel .meta{opacity:.8;margin:2px 0}
  #panel .meta b{color:#fff;font-weight:600}
  #panel svg{background:#fff;border-radius:6px;margin:8px auto 0;display:block;max-width:100%;height:auto}
  #panel .row{display:flex;gap:8px;margin-top:10px}
  #sel{opacity:.8}
  #tree{width:232px;flex:none;overflow:auto;background:#1c1c1c;border-right:1px solid #333;padding:8px 4px;font-size:13px}
  #tree .thead{padding:2px 8px 6px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #tree ul{list-style:none;margin:0;padding:0}
  #tree ul ul{padding-left:16px}
  #tree .trow{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:5px;cursor:pointer;white-space:nowrap}
  #tree .trow:hover{background:#2a2a2a}
  #tree .trow.sel{background:#0a5dc2}
  #tree .trow .lbl{flex:1;overflow:hidden;text-overflow:ellipsis}
  #tree .trow.off .lbl{opacity:.45;text-decoration:line-through}
  #tree .twisty{width:14px;flex:none;opacity:.7;user-select:none}
  #tree input{accent-color:#0a5dc2;flex:none}
  #grip{width:8px;flex:none;cursor:col-resize;display:none;touch-action:none}
  #grip:hover,#grip.on{background:#0a5dc2}
</style></head>
<body>
<div id="bar"><b>${escTitle}</b><span class="hint">drag to rotate · wheel to zoom${picking ? " · shift+click a part for details" : ""}</span><button id="spin" aria-pressed="true">spin</button><span id="count"></span><span id="sel"></span></div>
<div id="wrap">${picking ? '<aside id="tree"></aside>' : ""}<canvas id="c"></canvas>${picking ? '<div id="grip" title="drag to resize panel"></div>' : ""}<aside id="panel"></aside></div>
<script>
"use strict";
const STL = \`${jsEscape(stlText)}\`;
const BOXES = ${boxJson};
function parseAscii(stl){
  const f=[]; const re=/facet normal ([-\\d.e+]+) ([-\\d.e+]+) ([-\\d.e+]+)\\s+outer loop\\s+vertex ([-\\d.e+]+) ([-\\d.e+]+) ([-\\d.e+]+)\\s+vertex ([-\\d.e+]+) ([-\\d.e+]+) ([-\\d.e+]+)\\s+vertex ([-\\d.e+]+) ([-\\d.e+]+) ([-\\d.e+]+)\\s+endloop\\s+endfacet/g;
  let m; while((m=re.exec(stl))!==null){
    f.push({n:[+m[1],+m[2],+m[3]],
      v:[[+m[4],+m[5],+m[6]],[+m[7],+m[8],+m[9]],[+m[10],+m[11],+m[12]]]});
  }
  return f;
}
const facets=parseAscii(STL);
document.getElementById("count").textContent=facets.length+" triangles";
// Part picking is valid only when the STL facet order matches the boxes:
// boxesToStl emits boxes in order at 12 facets per box.
const PICK_OK = BOXES.length>0 && facets.length===BOXES.length*12;
const keyOf=i=>BOXES[i].partId+"|"+BOXES[i].dx+"x"+BOXES[i].dy+"x"+BOXES[i].dz;
let selected=-1; // box index, -1 = none
let selectedStation=-1; // station index, -1 = none (exclusive with selected)
const cv=document.getElementById("c"), ctx=cv.getContext("2d");
const panel=document.getElementById("panel"), selEl=document.getElementById("sel");
function identicalTo(idx){
  if(idx<0||idx>=BOXES.length)return [];
  // Kin by DIMENSIONS, not partId: corner-suffixed parts (stop-w-post-fl
  // vs -fr) are the same cut in different positions and must light up
  // together. Rounded to 0.001mm: mirrored/offset arithmetic leaves
  // float dust on otherwise identical cuts. (The TS identicalBoxes stays
  // partId-strict for cut lists.)
  const r3=v=>Math.round(v*1000)/1000;
  const b=BOXES[idx], k=r3(b.dx)+"x"+r3(b.dy)+"x"+r3(b.dz), out=[];
  for(let i=0;i<BOXES.length;i++){ const o=BOXES[i];
    if(r3(o.dx)+"x"+r3(o.dy)+"x"+r3(o.dz)===k) out.push(i); }
  return out;
}
const tree=document.getElementById("tree"), grip=document.getElementById("grip");
// Groups in first-seen order (mirrors groupBoxes on the TS side).
const GROUPS=[]; const gmap={};
if(PICK_OK) for(let i=0;i<BOXES.length;i++){ const k=keyOf(i);
  if(!gmap[k]){ gmap[k]={key:k,partId:BOXES[i].partId,dims:BOXES[i].dx+" x "+BOXES[i].dy+" x "+BOXES[i].dz,station:BOXES[i].station||"",idx:[]}; GROUPS.push(gmap[k]); }
  gmap[k].idx.push(i); }
// Station sections in first-seen order (mirrors stationsOf on the TS side).
// Unstationed models (bench) collapse to one "" section: the tree below
// renders exactly the flat list it always did.
const STATIONS=[]; const smap={};
GROUPS.forEach((g,gi)=>{ const s=g.station;
  if(!smap[s]){ smap[s]={name:s,members:[]}; STATIONS.push(smap[s]); }
  smap[s].members.push(gi); });
const STATIONED=STATIONS.length>1||(STATIONS.length===1&&STATIONS[0].name!=="");
function stationBoxes(si){ const out=[]; STATIONS[si].members.forEach(gi=>{ GROUPS[gi].idx.forEach(i=>out.push(i)); }); return out; }
// Dims multiset per station: identical stations (same cuts, e.g. stop-w
// vs stop-e) highlight as kin when one is selected.
const STATIONKEYS={};
STATIONS.forEach(st=>{ const ks=[];
  st.members.forEach(gi=>{ GROUPS[gi].idx.forEach(i=>{ const o=BOXES[i];
    ks.push(Math.round(o.dx*1000)/1000+"x"+Math.round(o.dy*1000)/1000+"x"+Math.round(o.dz*1000)/1000); }); });
  ks.sort(); STATIONKEYS[st.name]=ks.join(";"); });
function stationKin(si){ const out=[]; const ref=STATIONKEYS[STATIONS[si].name];
  STATIONS.forEach((st,i)=>{ if(i!==si&&STATIONKEYS[st.name]===ref) out.push(i); });
  return out; }
const hidden=new Set();
function syncTree(){
  if(!tree||!PICK_OK) return;
  const rows=tree.querySelectorAll("[data-box]");
  for(const r of rows){ const i=+r.getAttribute("data-box");
    r.classList.toggle("sel",i===selected);
    r.classList.toggle("off",hidden.has(i));
    const c=r.querySelector("input"); if(c) c.checked=!hidden.has(i); }
  const grows=tree.querySelectorAll("[data-group]");
  for(const gr of grows){ const g=GROUPS[+gr.getAttribute("data-group")];
    const vis=g.idx.filter(i=>!hidden.has(i)).length;
    gr.classList.toggle("sel",g.idx.includes(selected));
    gr.classList.toggle("off",vis===0);
    const gc=gr.querySelector("input");
    if(gc){ gc.checked=vis>0; gc.indeterminate=vis>0&&vis<g.idx.length; } }
  const allC=document.getElementById("tall");
  if(allC){ allC.checked=hidden.size===0; allC.indeterminate=hidden.size>0&&hidden.size<BOXES.length; }
  const srows=tree.querySelectorAll("[data-station]");
  for(const sr of srows){ const si=+sr.getAttribute("data-station"); const box=stationBoxes(si);
    const vis=box.filter(i=>!hidden.has(i)).length;
    sr.classList.toggle("sel",box.includes(selected)||selectedStation===si);
    sr.classList.toggle("off",vis===0);
    const sc=sr.querySelector("input");
    if(sc){ sc.checked=vis>0; sc.indeterminate=vis>0&&vis<box.length; } }
}
function clearIfHidden(){ if(hidden.has(selected)){ selected=-1; updatePanel(); } else syncTree(); }
function buildTree(){
  if(!tree||!PICK_OK) return;
  tree.replaceChildren();
  const PROJ=(document.title||"project").split(" \u2014 ")[0];
  const head=document.createElement("div"); head.className="thead";
  head.textContent=PROJ+" \u2014 "+BOXES.length+" parts"; tree.appendChild(head);
  const root=document.createElement("div"); root.className="trow";
  const allC=document.createElement("input"); allC.type="checkbox"; allC.id="tall";
  allC.checked=true; allC.title="show/hide all parts";
  allC.onchange=()=>{ hidden.clear(); if(!allC.checked) for(let i=0;i<BOXES.length;i++) hidden.add(i); clearIfHidden(); };
  root.appendChild(allC);
  const rl=document.createElement("span"); rl.className="lbl"; rl.textContent="all parts";
  rl.setAttribute("data-clear","1");
  root.appendChild(rl); tree.appendChild(root);
  const ul=document.createElement("ul"); tree.appendChild(ul);
  // One group row (identical parts + expandable copies), shared by the
  // flat list and the station sections below.
  function groupLi(g,gi){
    const li=document.createElement("li");
    const row=document.createElement("div"); row.className="trow"; row.setAttribute("data-group",String(gi));
    const tw=document.createElement("span"); tw.className="twisty"; tw.textContent="\u25b8";
    tw.title="expand/collapse";
    const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=true;
    cb.title="show/hide "+g.partId;
    cb.onchange=()=>{ if(cb.checked) g.idx.forEach(i=>hidden.delete(i)); else g.idx.forEach(i=>hidden.add(i)); clearIfHidden(); };
    const lb=document.createElement("span"); lb.className="lbl";
    lb.textContent=g.idx.length+"\u00d7 "+g.partId+" \u2014 "+g.dims;
    const sub=document.createElement("ul"); sub.style.display="none";
    g.idx.forEach(i=>{
      const sli=document.createElement("li");
      const srow=document.createElement("div"); srow.className="trow"; srow.setAttribute("data-box",String(i));
      const ics=document.createElement("input"); ics.type="checkbox"; ics.checked=true;
      ics.title="show/hide this copy";
      ics.onchange=()=>{ if(ics.checked) hidden.delete(i); else hidden.add(i); clearIfHidden(); };
      const ilb=document.createElement("span"); ilb.className="lbl"; ilb.textContent=BOXES[i].label;
      srow.appendChild(ics); srow.appendChild(ilb); sli.appendChild(srow); sub.appendChild(sli);
    });
    tw.onclick=()=>{ const open=sub.style.display!=="none"; sub.style.display=open?"none":""; tw.textContent=open?"\u25b8":"\u25be"; };
    row.appendChild(tw); row.appendChild(cb); row.appendChild(lb);
    li.appendChild(row); li.appendChild(sub);
    return li;
  }
  if(!STATIONED){ GROUPS.forEach((g,gi)=>ul.appendChild(groupLi(g,gi))); }
  else STATIONS.forEach((st,si)=>{
    const sli=document.createElement("li");
    const srow=document.createElement("div"); srow.className="trow"; srow.setAttribute("data-station",String(si));
    const stw=document.createElement("span"); stw.className="twisty"; stw.textContent="\u25b8";
    stw.title="expand/collapse station";
    const scb=document.createElement("input"); scb.type="checkbox"; scb.checked=true;
    scb.title="show/hide "+(st.name||"all")+" station";
    scb.onchange=()=>{ const box=stationBoxes(si); if(scb.checked) box.forEach(i=>hidden.delete(i)); else box.forEach(i=>hidden.add(i)); clearIfHidden(); };
    const slb=document.createElement("span"); slb.className="lbl";
    const count=stationBoxes(si).length;
    slb.textContent=(st.name||"parts")+" \u2014 "+count+" part"+(count===1?"":"s");
    const ssub=document.createElement("ul"); ssub.style.display="none";
    st.members.forEach(gi=>ssub.appendChild(groupLi(GROUPS[gi],gi)));
    stw.onclick=()=>{ const open=ssub.style.display!=="none"; ssub.style.display=open?"none":""; stw.textContent=open?"\u25b8":"\u25be"; };
    srow.appendChild(stw); srow.appendChild(scb); srow.appendChild(slb);
    sli.appendChild(srow); sli.appendChild(ssub); ul.appendChild(sli);
  });
  tree.addEventListener("click",e=>{
    const t=e.target;
    if(t.tagName==="INPUT"||t.className==="twisty") return;
    const rb=t.closest("[data-box]");
    if(rb){ selected=+rb.getAttribute("data-box"); selectedStation=-1; updatePanel(); return; }
    const rg=t.closest("[data-group]");
    if(rg){ const gg=GROUPS[+rg.getAttribute("data-group")];
      const first=gg.idx.find(i=>!hidden.has(i)); selected=(first===undefined?-1:first); selectedStation=-1; updatePanel(); return; }
    const rs=t.closest("[data-station]");
    if(rs){ const si=+rs.getAttribute("data-station");
      // Station select: whole module highlights, members unhidden and
      // revealed; identical stations light up as kin. Click again to clear.
      selected=-1; selectedStation=(selectedStation===si?-1:si);
      if(selectedStation>=0){ const box=stationBoxes(si);
        box.forEach(i=>hidden.delete(i));
        const sli=rs.parentElement, ssub=sli&&sli.querySelector("ul");
        if(ssub){ ssub.style.display=""; const stw=rs.querySelector(".twisty"); if(stw) stw.textContent="\u25be"; }
      }
      updatePanel(); return; }
    if(t.closest("[data-clear]")){ selected=-1; selectedStation=-1; updatePanel(); }
  });
  syncTree();
}
buildTree();
// Resizable details panel (width persists per browser).
let panelW=300;
try{ const w=+localStorage.getItem("buildit-panel-w"); if(w>=200&&w<=700) panelW=w; }catch(_){}
panel.style.width=panelW+"px";
if(grip){
  let gd=null;
  grip.addEventListener("pointerdown",e=>{ gd={x:e.clientX,w:parseFloat(panel.style.width)||panel.offsetWidth}; grip.classList.add("on"); try{ grip.setPointerCapture(e.pointerId); }catch(_){} e.preventDefault(); });
  grip.addEventListener("pointermove",e=>{ if(!gd)return; const w=Math.max(200,Math.min(700,gd.w+(gd.x-e.clientX))); panel.style.width=w+"px"; resize(); });
  const end=()=>{ if(!gd)return; gd=null; grip.classList.remove("on"); try{ localStorage.setItem("buildit-panel-w",String(Math.round(parseFloat(panel.style.width)||panel.offsetWidth))); }catch(_){} };
  grip.addEventListener("pointerup",end); grip.addEventListener("pointercancel",end);
}
// Dimensioned mini-SVG for one box: front (dx x dz) + top (dx x dy).
// Built with DOM APIs only, so labels/notes can never inject markup.
function detailSvgEl(b,availW,maxH){
  const NS="http://www.w3.org/2000/svg";
  const pad=26;
  // Informative elevation: the longest horizontal face (front for X-running
  // parts, side for Y-running ones — short aprons read edge-on from the
  // front, so they get the side view). Wide flats draw rotated to use the
  // panel height; labels always state true dims.
  const alongY=b.dy>b.dx, longH=Math.max(b.dx,b.dy);
  const eName=alongY?"side":"front";
  let ew=longH, eh=b.dz;
  const eRot=ew/Math.max(eh,1e-9)>3;
  let pw=b.dx, ph=b.dy;
  const pRot=pw/Math.max(ph,1e-9)>3;
  const eLabel=eName+" "+longH+" x "+b.dz+"mm"+(eRot?" (shown rotated)":"");
  const pLabel="top "+b.dx+" x "+b.dy+"mm"+(pRot?" (shown rotated)":"");
  if(eRot){ const t=ew; ew=eh; eh=t; }
  if(pRot){ const t=pw; pw=ph; ph=t; }
  const sw=(availW-2*pad)/Math.max(Math.max(ew,pw),1);
  const sh=(maxH-(3*pad+14))/Math.max(eh+ph,1);
  const s=Math.max(0.01,Math.min(sw,sh));
  const fw=ew*s, fh=eh*s, tw=pw*s, th=ph*s;
  const W=Math.max(fw,tw)+pad*2, H=fh+th+pad*3+14;
  const y0=pad, y1=pad+fh+pad+14;
  const svg=document.createElementNS(NS,"svg");
  svg.setAttribute("width",W.toFixed(1));
  svg.setAttribute("height",H.toFixed(1));
  svg.setAttribute("viewBox","0 0 "+W.toFixed(1)+" "+H.toFixed(1));
  const txt=(x,y,str,size)=>{
    const t=document.createElementNS(NS,"text");
    t.setAttribute("x",String(x)); t.setAttribute("y",String(y));
    t.setAttribute("font-size",String(size)); t.setAttribute("fill","#111");
    t.textContent=str; svg.appendChild(t); };
  const rbox=(x,y,w,h)=>{
    const r=document.createElementNS(NS,"rect");
    r.setAttribute("x",String(x)); r.setAttribute("y",String(y));
    r.setAttribute("width",w.toFixed(1)); r.setAttribute("height",h.toFixed(1));
    r.setAttribute("fill","none"); r.setAttribute("stroke","#111");
    r.setAttribute("stroke-width","0.6"); svg.appendChild(r); };
  const ebW=eRot?b.dz:longH, ebH=eRot?longH:b.dz;
  const pbW=pRot?b.dy:b.dx, pbH=pRot?b.dx:b.dy;
  txt(pad,12,eLabel,7);
  rbox(pad,y0,fw,fh);
  txt(pad+fw/2-14,y0+fh+10,ebW+"mm",6);
  txt(2,y0+fh/2,String(ebH),6);
  txt(pad,y1-4,pLabel,7);
  rbox(pad,y1,tw,th);
  txt(pad+tw/2-14,y1+th+10,pbW+"mm",6);
  txt(2,y1+th/2,String(pbH),6);
  return svg;
}


function metaLine(labelText,valueText){
  const d=document.createElement("div"); d.className="meta";
  d.appendChild(document.createTextNode(labelText));
  if(valueText!==undefined&&valueText!==null&&valueText!=="")
    d.appendChild(document.createTextNode(valueText));
  return d;
}
function updatePanel(){
  if(!PICK_OK||(selected<0&&selectedStation<0)){ panel.classList.remove("show"); selEl.textContent=""; if(grip) grip.style.display="none"; syncTree(); return; }
  if(selectedStation>=0){
    const st=STATIONS[selectedStation], box=stationBoxes(selectedStation);
    const kin=stationKin(selectedStation);
    selEl.textContent=" \u00b7 "+(st.name||"model")+" ("+box.length+" parts)";
    panel.replaceChildren();
    const h=document.createElement("h2"); h.textContent=(st.name||"model")+" station"; panel.appendChild(h);
    panel.appendChild(metaLine("parts ",String(box.length)));
    panel.appendChild(metaLine("groups ",String(st.members.length)));
    panel.appendChild(metaLine("identical stations ",kin.length?kin.map(i=>STATIONS[i].name).join(", "):"none — unique"));
    panel.classList.add("show");
    if(grip) grip.style.display="block";
    const row=document.createElement("div"); row.className="row";
    const btn=document.createElement("button"); btn.id="clear";
    btn.textContent="clear (click station again)";
    btn.onclick=()=>{ selected=-1; selectedStation=-1; updatePanel(); };
    row.appendChild(btn); panel.appendChild(row);
    syncTree();
    return;
  }
  const b=BOXES[selected], sibs=identicalTo(selected);
  selEl.textContent=" \u00b7 "+b.label+" ("+sibs.length+"\u00d7 "+b.partId+")";
  panel.replaceChildren();
  const h=document.createElement("h2"); h.textContent=b.label; panel.appendChild(h);
  const m1=document.createElement("div"); m1.className="meta";
  m1.appendChild(document.createTextNode("part "));
  const pb=document.createElement("b"); pb.textContent=b.partId; m1.appendChild(pb);
  m1.appendChild(document.createTextNode(" \u00b7 "+sibs.length+" identical")); panel.appendChild(m1);
  const m2=document.createElement("div"); m2.className="meta";
  m2.appendChild(document.createTextNode("size "));
  const sb=document.createElement("b"); sb.textContent=b.dx+" x "+b.dy+" x "+b.dz+"mm"; m2.appendChild(sb);
  panel.appendChild(m2);
  panel.appendChild(metaLine("origin (",b.x+", "+b.y+", "+b.z+")"));
  const m3=document.createElement("div"); m3.className="meta";
  m3.appendChild(document.createTextNode("process "));
  const pr=document.createElement("b"); pr.textContent=b.process; m3.appendChild(pr);
  panel.appendChild(m3);
  panel.appendChild(metaLine("",String(b.note)));
  if(b.qtyNote) panel.appendChild(metaLine("",String(b.qtyNote)));
  panel.appendChild(metaLine("copies: ",sibs.map(i=>"#"+(i+1)).join(", ")));
  panel.classList.add("show");
  if(grip) grip.style.display="block";
  const wrapH=(document.getElementById("wrap").clientHeight||window.innerHeight);
  let textH=24; for(const k of panel.children) textH+=k.getBoundingClientRect().height+4;
  const maxH=Math.max(120,wrapH-textH-80);
  const availW=Math.max(120,(parseFloat(panel.style.width)||300)-26);
  panel.appendChild(detailSvgEl(b,availW,maxH));
  const row=document.createElement("div"); row.className="row";
  const btn=document.createElement("button"); btn.id="clear";
  btn.textContent="clear (shift+click empty space)";
  btn.onclick=()=>{ selected=-1; selectedStation=-1; updatePanel(); };
  row.appendChild(btn); panel.appendChild(row);
  syncTree();
}
// Center + uniform scale into view.
let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9,minZ=1e9,maxZ=-1e9;
for(const f of facets) for(const v of f.v){
  if(v[0]<minX)minX=v[0]; if(v[0]>maxX)maxX=v[0];
  if(v[1]<minY)minY=v[1]; if(v[1]>maxY)maxY=v[1];
  if(v[2]<minZ)minZ=v[2]; if(v[2]>maxZ)maxZ=v[2];
}
const cx=(minX+maxX)/2, cy=(minY+maxY)/2, cz=(minZ+maxZ)/2;
const span=Math.max(maxX-minX,maxY-minY,maxZ-minZ)||1;
let yaw=0.7, pitch=-0.5, dist=1.0, spinning=true;
function resize(){ cv.width=cv.clientWidth*devicePixelRatio; cv.height=cv.clientHeight*devicePixelRatio; }
addEventListener("resize",resize); resize();
addEventListener("resize",()=>{ if(PICK_OK&&selected>=0) updatePanel(); });
const spinBtn=document.getElementById("spin");
spinBtn.onclick=()=>{ spinning=!spinning; spinBtn.setAttribute("aria-pressed",String(spinning)); };
let drag=null, downPos=null;
cv.addEventListener("pointerdown",e=>{ drag={x:e.clientX,y:e.clientY}; downPos={x:e.clientX,y:e.clientY}; try{ cv.setPointerCapture(e.pointerId); }catch(_){} cv.style.cursor="grabbing"; });
cv.addEventListener("pointermove",e=>{ if(!drag)return;
  yaw+=(e.clientX-drag.x)*0.008; pitch+=(e.clientY-drag.y)*0.008;
  pitch=Math.max(-1.4,Math.min(1.4,pitch)); drag={x:e.clientX,y:e.clientY}; });
cv.addEventListener("pointerup",e=>{ drag=null; cv.style.cursor="grab";
  if(PICK_OK&&e.shiftKey&&downPos&&Math.hypot(e.clientX-downPos.x,e.clientY-downPos.y)<5){
    const r=cv.getBoundingClientRect();
    pick(e.clientX-r.left, e.clientY-r.top);
  }
  downPos=null; });
cv.addEventListener("wheel",e=>{ e.preventDefault(); dist*=e.deltaY>0?1.1:0.9;
  dist=Math.max(0.3,Math.min(5,dist)); },{passive:false});
function ptInTri(px,py,a,b,c){
  const d=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
  if(Math.abs(d)<1e-12)return false;
  const u=((b[1]-c[1])*(px-c[0])+(c[0]-b[0])*(py-c[1]))/d;
  const v=((c[1]-a[1])*(px-c[0])+(a[0]-c[0])*(py-c[1]))/d;
  return u>=0&&v>=0&&(u+v)<=1;
}
// Screen-space triangles of the last frame (back-to-front) for picking.
let screenTris=[];
function pick(px,py){
  const dpr=devicePixelRatio||1;
  const sx=px*dpr, sy=py*dpr;
  for(let i=screenTris.length-1;i>=0;i--){
    const t=screenTris[i], p=t.p;
    if(ptInTri(sx,sy,p[0],p[1],p[2])){ selected=t.box; updatePanel(); return; }
  }
  selected=-1; updatePanel();
}
const LIGHT=[0.35,0.5,0.79];
function frame(t){
  if(spinning && !drag) yaw+=0.004;
  const cy1=Math.cos(yaw), sy1=Math.sin(yaw), cx1=Math.cos(pitch), sx1=Math.sin(pitch);
  const rot=p=>{
    const x=p[0]-cx, y=p[1]-cy, z=p[2]-cz;
    const x1=x*cy1-y*sy1, y1=x*sy1+y*cy1;       // yaw about Z
    const y2=y1*cx1-z*sx1, z2=y1*sx1+z*cx1;      // pitch about X
    return [x1,y2,z2];
  };
  const W=cv.width, H=cv.height;
  const scale=Math.min(W,H)/(span*dist*1.35);
  ctx.fillStyle="#111"; ctx.fillRect(0,0,W,H);
  const selKey=(PICK_OK&&selected>=0)?keyOf(selected):null;
  const sibSet=new Set(selKey?identicalTo(selected):[]);
  const selSt=(PICK_OK&&selectedStation>=0)?STATIONS[selectedStation].name:null;
  const kinSt=new Set();
  if(selectedStation>=0) stationKin(selectedStation).forEach(i=>kinSt.add(STATIONS[i].name));
  const tris=[];
  for(let fi=0;fi<facets.length;fi++){
    const f=facets[fi];
    const v=f.v.map(rot), n=rot([f.n[0]+cx,f.n[1]+cy,f.n[2]+cz]);
    const nx=n[0]-rot([cx,cy,cz])[0], ny=n[1]-rot([cx,cy,cz])[1], nz=n[2]-rot([cx,cy,cz])[2];
    if(nz<=0.001)continue; // backface cull: closed boxes, kills coplanar bleed-through
    const shade=Math.max(0.12,(nx*LIGHT[0]+ny*LIGHT[1]+nz*LIGHT[2]));
    const bi=PICK_OK?(fi/12|0):-1;
    if(bi>=0&&hidden.has(bi))continue;
    tris.push({v,z:(v[0][2]+v[1][2]+v[2][2])/3,s:shade,box:bi});
  }
  tris.sort((a,b)=>a.z-b.z);
  screenTris=[];
  for(const t2 of tris){
    const pts=[];
    ctx.beginPath();
    for(let i=0;i<3;i++){
      const sx=W/2+t2.v[i][0]*scale, sy=H/2-t2.v[i][1]*scale;
      pts.push([sx,sy]);
      if(i===0)ctx.moveTo(sx,sy); else ctx.lineTo(sx,sy);
    }
    ctx.closePath();
    screenTris.push({p:pts,box:t2.box});
    const isSel=PICK_OK&&t2.box===selected;
    const isSib=PICK_OK&&selKey&&sibSet.has(t2.box);
    const stOfBox=(PICK_OK&&t2.box>=0)?(BOXES[t2.box].station||""):null;
    const isStSel=selSt!==null&&stOfBox===selSt;
    const isStKin=selSt!==null&&kinSt.has(stOfBox);
    const g=Math.round(40+t2.s*170);
    // Selection reads teal, kin orange — parts and stations alike.
    if(isSel||isStSel) ctx.fillStyle="rgb(45,212,191)";
    else if(isSib||isStKin) ctx.fillStyle="rgb(245,158,11)";
    else ctx.fillStyle="rgb("+g+","+Math.round(g*0.93)+","+Math.round(g*0.78)+")";
    ctx.fill();
    ctx.strokeStyle=(isSel||isSib||isStSel||isStKin)?"rgba(255,255,255,.9)":"rgba(0,0,0,.25)";
    ctx.lineWidth=(isSel||isSib||isStSel||isStKin)?2:1; ctx.stroke();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script></body></html>
`;
}
