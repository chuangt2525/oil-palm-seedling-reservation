(function(){
const $=s=>document.querySelector(s);
const S={varieties:[],ponds:[],plantings:[],bookings:[]};
const COLLS=Object.keys(S);
const CFG=window.APP_CONFIG||{};
let sb=null, session=null, chan=null, canWrite=true, live=false;
const STATUS={reserved:"จอง",confirmed:"ยืนยัน",delivered:"ส่งมอบแล้ว",cancelled:"ยกเลิก"};

/* ---------- utils ---------- */
const pad=n=>String(n).padStart(2,"0");
const iso=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const today=()=>iso(new Date());
const addDays=(s,n)=>{const d=new Date(s+"T00:00:00");d.setDate(d.getDate()+n);return iso(d)};
const thDate=(s,long)=>{if(!s)return"-";const d=new Date(s+"T00:00:00");return d.toLocaleDateString("th-TH",long?{weekday:"short",day:"numeric",month:"short",year:"numeric"}:{day:"numeric",month:"short",year:"2-digit"})};
const fmt=n=>(Number(n)||0).toLocaleString("th-TH");
const pct=(a,b)=>b>0?(a/b*100):0;
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid=()=>crypto.randomUUID?crypto.randomUUID():"10000000-1000-4000-8000-100000000000".replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
const vName=id=>(S.varieties.find(v=>v.id===id)||{}).name||"(ไม่ระบุ)";
const pName=id=>(S.ponds.find(p=>p.id===id)||{}).name||"(ไม่ระบุ)";
const sortVar=a=>[...a].sort((x,y)=>(x.name||"").localeCompare(y.name||"","th"));
const sortPond=a=>[...a].sort((x,y)=>(x.name||"").localeCompare(y.name||"","th",{numeric:true}));

/* ---------- core calculation ---------- */
function calc(){
  const byVar={};
  const blank=()=>({adjust:0,planted:0,culled:0,net:0,booked:0,delivered:0,pending:0,available:0,rate:0});
  S.varieties.forEach(v=>{byVar[v.id]=blank();byVar[v.id].adjust=+v.adjust||0});
  S.plantings.forEach(p=>{const r=byVar[p.varietyId]||(byVar[p.varietyId]=blank());r.planted+=+p.qty||0;r.culled+=+p.culled||0});
  S.bookings.forEach(b=>{if(b.status==="cancelled")return;const r=byVar[b.varietyId]||(byVar[b.varietyId]=blank());
    r.booked+=+b.qty||0; if(b.status==="delivered")r.delivered+=+b.qty||0; else r.pending+=+b.qty||0});
  const tot=blank();
  for(const k in byVar){const r=byVar[k];r.net=Math.max(0,r.planted-r.culled+r.adjust);r.available=r.net-r.booked;r.rate=pct(r.booked,r.net);
    ["planted","culled","net","booked","delivered","pending","available"].forEach(f=>tot[f]+=r[f])}
  tot.rate=pct(tot.booked,tot.net);
  const byPond={};
  S.ponds.forEach(p=>byPond[p.id]={planted:0,culled:0,net:0,cap:+p.capacity||0,vars:new Set()});
  S.plantings.forEach(p=>{const r=byPond[p.pondId]||(byPond[p.pondId]={planted:0,culled:0,net:0,cap:0,vars:new Set()});
    r.planted+=+p.qty||0;r.culled+=+p.culled||0;r.vars.add(p.varietyId)});
  for(const k in byPond){const r=byPond[k];r.net=Math.max(0,r.planted-r.culled)}
  const byBucket={};const bb=(lot,v)=>{const k=lot+"|"+v;return byBucket[k]||(byBucket[k]={key:k,lot,varietyId:v,planted:0,culled:0,net:0,booked:0,delivered:0,pending:0,available:0,rate:0})};
  S.plantings.forEach(p=>{const r=bb(lotKey(p),p.varietyId);r.planted+=+p.qty||0;r.culled+=+p.culled||0});
  S.bookings.forEach(b=>{if(b.status==="cancelled"||!b.lot)return;const r=bb(b.lot,b.varietyId);r.booked+=+b.qty||0;if(b.status==="delivered")r.delivered+=+b.qty||0;else r.pending+=+b.qty||0});
  for(const k in byBucket){const r=byBucket[k];r.net=Math.max(0,r.planted-r.culled);r.available=r.net-r.booked;r.rate=pct(r.booked,r.net)}
  return {byVar,tot,byPond,byBucket};
}
/* check: how many can be booked for a variety, excluding a booking id */
function bucketList(C){return Object.values(C.byBucket).sort((a,b)=>a.lot.localeCompare(b.lot)||vName(a.varietyId).localeCompare(vName(b.varietyId),"th"))}
function bucketLabel(key){const [lot,v]=key.split("|");const [y,l]=lot.split("-L");return `Lot${l}/${vName(v)} · ปี ${(+y)+543} (${l==="1"?"ต้นปี":"กลางปี"})`}
function checkAvail(key,qty){
  const C=calc();const r=C.byBucket[key];const v=r&&C.byVar[r.varietyId];const avail=r?Math.min(r.available,v?v.available:r.available):0;
  return {avail, ok:qty>0&&qty<=avail, after:avail-(qty||0), short:Math.max(0,(qty||0)-avail)};
}

/* ---------- persistence (Supabase; in-memory when in demo mode) ---------- */
// app objects use camelCase, tables use snake_case; "" in an *Id / *Date field means null
const snake=k=>k.replace(/[A-Z]/g,c=>"_"+c.toLowerCase());
const camel=k=>k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
function toDb(data){const o={};for(const k in data){if(k==="createdAt"||k==="updatedAt")continue;const v=data[k];o[snake(k)]=v===""&&/(Id|Date)$/.test(k)?null:v}return o}
function fromDb(row){const o={};for(const k in row)o[camel(k)]=row[k];return o}
async function load(coll){const {data,error}=await sb.from(coll).select("*");if(error)throw error;S[coll]=data.map(fromDb)}
async function reload(coll){await load(coll);render()}
async function save(coll,id,data){
  if(!canWrite)throw new Error("บัญชีนี้ดูได้อย่างเดียว ไม่สามารถบันทึกข้อมูลได้");
  id=id||uid();
  if(sb){const {error}=await sb.from(coll).upsert({id,...toDb(data)});if(error)throw error;await reload(coll)}
  else{data={...data,updatedAt:new Date().toISOString()};const a=S[coll];const i=a.findIndex(x=>x.id===id);const row={id,...data};i>=0?a.splice(i,1,row):a.push(row);render();}
  return id;
}
async function patch(coll,id,data){
  if(!canWrite)throw new Error("บัญชีนี้ดูได้อย่างเดียว");
  if(sb){const {error}=await sb.from(coll).update(toDb(data)).eq("id",id);if(error)throw error;await reload(coll)}
  else{const r=S[coll].find(x=>x.id===id);Object.assign(r,data);render();}
}
async function remove(coll,id){
  if(!canWrite)throw new Error("บัญชีนี้ดูได้อย่างเดียว");
  if(sb){const {error}=await sb.from(coll).delete().eq("id",id);if(error)throw error;await reload(coll)}
  else{S[coll]=S[coll].filter(x=>x.id!==id);render();}
}
function errText(e){
  const c=e&&e.code;
  if(c==="23505")return"มีข้อมูลนี้อยู่แล้ว (ชื่อหรือเลขที่ซ้ำ)";
  if(c==="23503")return"ข้อมูลนี้ถูกใช้งานอยู่ จึงลบหรือแก้ไขไม่ได้";
  if(c==="23514"||c==="23502"||c==="22P02")return"ข้อมูลไม่ถูกต้อง ตรวจสอบจำนวนและวันที่อีกครั้ง";
  if(c==="42501")return"บัญชีนี้ไม่มีสิทธิ์บันทึกข้อมูล";
  if(c==="PGRST301"||c==="PGRST303")return"หมดเวลาเข้าสู่ระบบ กรุณาออกจากระบบแล้วเข้าใหม่";
  if(e instanceof TypeError||/failed to fetch|network/i.test((e&&e.message)||""))return"เชื่อมต่อฐานข้อมูลไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง";
  return (e&&e.message)||"บันทึกไม่สำเร็จ";
}
function flash(el,text,ok){el.textContent=text;el.className="msg "+(ok?"ok":"err");if(ok)setTimeout(()=>{if(el.textContent===text)el.textContent=""},3000)}

/* ---------- demo data (used only when the database is unavailable) ---------- */
function demo(){
  const t=today();
  S.varieties=[{id:"v2",name:"KB4"},{id:"v3",name:"S1"}];
  S.ponds=[{id:"o1",name:"Lot1/KB4",lot:"L1",capacity:6000,varietyId:"v2"},{id:"o2",name:"Lot2/KB4",lot:"L2",capacity:6000,varietyId:"v2"},{id:"o3",name:"Lot2/S1",lot:"L2",capacity:4000,varietyId:"v3"},{id:"o4",name:"Lot1/S1",lot:"L1",capacity:4000,varietyId:"v3"}];
  const pl=[[-12,"o2","v2",2000,80],[-10,"o3","v3",1500,60],[-6,"o2","v2",2500,110],[-4,"o3","v3",1200,40]];
  S.plantings=pl.map((r,i)=>({id:"p"+i,date:addDays(t,r[0]),pondId:r[1],varietyId:r[2],qty:r[3],culled:r[4]}));
  const bk=[[-9,"v2",1200,"ลูกค้าตัวอย่าง B","delivered"],[-5,"v3",600,"ลูกค้าตัวอย่าง D","confirmed"],[-3,"v2",900,"ลูกค้าตัวอย่าง E","reserved"],[0,"v3",500,"ลูกค้าตัวอย่าง F","reserved"]];
  S.bookings=bk.map((r,i)=>({id:"b"+i,date:addDays(t,r[0]),varietyId:r[1],qty:r[2],customer:r[3],status:r[4],phone:"",pickupDate:addDays(t,r[0]+30)}));
}

/* ---------- render ---------- */
function render(){
  const C=calc();
  fillSelects();syncFromPond();
  renderDash(C); renderBookCheck(C); renderList(); renderPlant(C); renderSetup(C); cardify();
}
function optList(arr,sel,blankLabel){
  return (blankLabel!=null?`<option value="">${esc(blankLabel)}</option>`:"")+arr.map(x=>`<option value="${esc(x.id)}"${x.id===sel?" selected":""}>${esc(x.name)}</option>`).join("");
}
function fillSelects(){
  const vs=sortVar(S.varieties), ps=sortPond(S.ponds);
  [["#p_var",null],["#o_var",null],["#l_var","ทั้งหมด"]].forEach(([s,bl])=>{const el=$(s);const v=el.value;el.innerHTML=optList(vs,v,bl);if(v)el.value=v});
  {const be=$("#b_var");const bv=be.value;be.innerHTML=`<option value="">— เลือก Lot / สายพันธุ์ —</option>`+(()=>{const C=calc();const av=b=>Math.min(b.available,(C.byVar[b.varietyId]||b).available);const open=bucketList(C).filter(b=>av(b)>0);return open.length?open.map(b=>`<option value="${esc(b.key)}">${esc(bucketLabel(b.key))} — เหลือ ${fmt(av(b))} ต้น</option>`).join(""):`<option value="" disabled>ไม่มี Lot ที่ยังจองได้</option>`})();be.value=bv;if(be.value!==bv)be.value=""}
  const pe=$("#p_pond");const pv=pe.value;pe.innerHTML=optList(ps,pv);if(pv)pe.value=pv;
}
function renderDash(C){
  const t=C.tot;
  $("#kpis").innerHTML=[
    ["ยอดเพาะทั้งหมด",fmt(t.planted),"ต้น · คัดทิ้ง "+fmt(t.culled)],
    ["ยอดที่ขายได้",fmt(t.net),"ต้น พร้อมจำหน่าย"],
    ["จองแล้ว",fmt(t.booked),"ส่งมอบ "+fmt(t.delivered)+" · รอส่ง "+fmt(t.pending)],
    ["คงเหลือจองได้",fmt(t.available),"ต้น",true],
    ["อัตราการจอง",pct(t.booked,t.net).toFixed(1)+"%","ของยอดที่ขายได้"],
  ].map(([l,v,s,h])=>`<div class="kpi${h?" hl":""}"><div class="lbl">${l}</div><div class="val">${v}</div><div class="sub">${s}</div></div>`).join("");
  const vs=sortVar(S.varieties);
  $("#varBars").innerHTML=vs.length?vs.map(v=>{const r=C.byVar[v.id];const n=Math.max(r.net,1);
    const over=r.available<0;
    return `<div class="vrow"><div class="nm">${esc(v.name)}</div><div class="num">${r.rate.toFixed(1)}%</div>
    <div class="bar" title="ส่งมอบ ${fmt(r.delivered)} / รอส่ง ${fmt(r.pending)} / คงเหลือ ${fmt(r.available)}"><i class="d" style="width:${Math.min(100,pct(r.delivered,n))}%"></i><i class="b" style="width:${Math.min(100,pct(r.pending,n))}%"></i></div>
    <div class="small muted" style="grid-column:1/-1">ยอดที่ขายได้ <span class="num">${fmt(r.net)}</span> · จอง <span class="num">${fmt(r.booked)}</span> · <b style="color:var(${over?"--bad":"--ok"})">${over?"จองเกิน "+fmt(-r.available):"จองได้อีก "+fmt(r.available)}</b> ต้น</div></div>`}).join(""):`<div class="empty">ยังไม่มีสายพันธุ์ — เพิ่มที่แท็บ “สายพันธุ์ &amp; แปลงเพาะปลูก”</div>`;
  $("#daily").innerHTML=dailyChart();
  $("#sumTbl").innerHTML=vs.length?`<table><thead><tr><th>สายพันธุ์</th><th class="r">ยอดที่ขายได้</th><th class="r">จองแล้ว</th><th class="r">จองได้อีก</th><th class="r">อัตรา</th></tr></thead><tbody>${vs.map(v=>{const r=C.byVar[v.id];return `<tr><td>${esc(v.name)}</td><td class="r num">${fmt(r.net)}</td><td class="r num">${fmt(r.booked)}</td><td class="r num" style="color:var(${r.available<0?"--bad":"--ok"});font-weight:600">${fmt(r.available)}</td><td class="r num">${r.rate.toFixed(1)}%</td></tr>`}).join("")}<tr><td><b>รวม</b></td><td class="r num"><b>${fmt(t.net)}</b></td><td class="r num"><b>${fmt(t.booked)}</b></td><td class="r num"><b>${fmt(t.available)}</b></td><td class="r num"><b>${t.rate.toFixed(1)}%</b></td></tr></tbody></table>`:`<div class="empty">ไม่มีข้อมูล</div>`;
  $("#pondTbl").innerHTML=pondTable(C);
  $("#lotDash").innerHTML=lotTable();
}
function pondTable(C){
  const ps=sortPond(S.ponds);
  if(!ps.length)return `<div class="empty">ยังไม่มีแปลง — เพิ่มที่แท็บ “สายพันธุ์ &amp; แปลงเพาะปลูก”</div>`;
  return `<table><thead><tr><th>แปลง</th><th>สายพันธุ์ที่เพาะ</th><th class="r">เพาะ</th><th class="r">คัดทิ้ง</th><th class="r">ขายได้</th><th class="r">ความจุ</th><th class="r">ใช้พื้นที่</th></tr></thead><tbody>${ps.map(p=>{const r=C.byPond[p.id];const u=r.cap?pct(r.net,r.cap):0;
    return `<tr><td>${esc(p.name)}</td><td class="small">${[...r.vars].map(vName).map(esc).join(", ")||"-"}</td><td class="r num">${fmt(r.planted)}</td><td class="r num">${fmt(r.culled)}</td><td class="r num">${fmt(r.net)}</td><td class="r num">${r.cap?fmt(r.cap):"-"}</td><td class="r num" style="color:var(${u>100?"--bad":u>85?"--warn":"--ink"})">${r.cap?u.toFixed(0)+"%":"-"}</td></tr>`}).join("")}</tbody></table>`;
}
function dailyChart(){
  const end=today(), days=[];for(let i=13;i>=0;i--)days.push(addDays(end,-i));
  const plant={},book={};days.forEach(d=>{plant[d]=0;book[d]=0});
  S.plantings.forEach(p=>{if(p.date in plant)plant[p.date]+=Math.max(0,(+p.qty||0)-(+p.culled||0))});
  S.bookings.forEach(b=>{if(b.status!=="cancelled"&&b.date in book)book[b.date]+=+b.qty||0});
  // cumulative rate up to each day (all history)
  const cum=days.map(d=>{let n=0,k=0;S.plantings.forEach(p=>{if(p.date<=d)n+=Math.max(0,(+p.qty||0)-(+p.culled||0))});S.bookings.forEach(b=>{if(b.status!=="cancelled"&&b.date<=d)k+=+b.qty||0});return n?Math.min(150,k/n*100):0});
  const mx=Math.max(1,...days.map(d=>Math.max(plant[d],book[d])));
  const step=Math.pow(10,Math.floor(Math.log10(mx)));const top=Math.ceil(mx/step)*step;
  const W=560,H=240,L=44,R=40,T=14,B=34,cw=(W-L-R)/days.length,ih=H-T-B;
  const y=v=>T+ih-v/top*ih, yr=v=>T+ih-Math.min(v,100)/100*ih;
  let s=`<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:480px" role="img" aria-label="กราฟยอดเพาะและยอดจองรายวัน">`;
  for(let i=0;i<=4;i++){const v=top/4*i,yy=y(v);s+=`<line class="g" x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}"/><text x="${L-6}" y="${yy+4}" text-anchor="end">${fmt(v)}</text><text x="${W-R+6}" y="${yy+4}">${25*i}%</text>`}
  days.forEach((d,i)=>{const x=L+i*cw,bw=cw*0.36;
    if(plant[d])s+=`<rect class="pl" x="${x+cw*0.12}" y="${y(plant[d])}" width="${bw}" height="${ih-(y(plant[d])-T)}" rx="2"><title>${thDate(d)} ยอดที่ขายได้ ${fmt(plant[d])}</title></rect>`;
    if(book[d])s+=`<rect class="bk" x="${x+cw*0.12+bw}" y="${y(book[d])}" width="${bw}" height="${ih-(y(book[d])-T)}" rx="2"><title>${thDate(d)} จอง ${fmt(book[d])}</title></rect>`;
    if(i%2===0||i===13){const dd=new Date(d+"T00:00:00");s+=`<text x="${x+cw/2}" y="${H-B+16}" text-anchor="middle">${dd.getDate()}/${dd.getMonth()+1}</text>`}});
  s+=`<polyline class="ln" points="${cum.map((v,i)=>`${L+i*cw+cw/2},${yr(v)}`).join(" ")}"/>`;
  const li=cum.length-1;s+=`<circle class="dot" cx="${L+li*cw+cw/2}" cy="${yr(cum[li])}" r="4"/>`;
  return s+"</svg>";
}
function renderLotPick(C){
  const sel=$("#b_var").value;const bl=bucketList(C);const av=b=>Math.min(b.available,(C.byVar[b.varietyId]||b).available);
  $("#lotPick").innerHTML=bl.length?bl.map(b=>{const a=av(b),[y,l]=b.lot.split("-L");return `<button type="button" class="lot" role="radio" aria-checked="${b.key===sel}" data-key="${esc(b.key)}"${a<=0?" disabled":""}>
    <span class="t">Lot${l}/${esc(vName(b.varietyId))}</span><span class="y">ปี ${(+y)+543} · ${l==="1"?"ต้นปี":"กลางปี"}</span>
    <span class="r">${a>0?fmt(a)+' <span class="small muted">ต้น</span>':'<span class="small" style="color:var(--bad)">หมดแล้ว</span>'}</span>
    <span class="bar"><i class="d" style="width:${Math.min(100,b.rate)}%"></i></span></button>`}).join(""):`<div class="empty full">ยังไม่มียอดเพาะ — บันทึกการเพาะลงแปลงก่อนจึงจองได้</div>`;
}
function renderBookCheck(C){
  renderLotPick(C);
  const vid=$("#b_var").value, q=parseInt($("#b_qty").value,10)||0, box=$("#checkBox"), btn=$("#b_submit");
  if(!vid){box.className="full check";box.innerHTML=`<div class="muted">แตะเลือก Lot / สายพันธุ์ด้านบน แล้วระบุจำนวน</div>`;btn.disabled=true}
  else{const c=checkAvail(vid,q);
    if(!q){box.className="full check";box.innerHTML=`<div class="small muted">${esc(bucketLabel(vid))}</div><div class="verdict">สามารถจองได้สูงสุด</div><div class="big">${fmt(Math.max(0,c.avail))} <span class="small">ต้น</span></div><div class="qbtns"><button class="btn sm ghost" type="button" id="useMax">จองทั้งหมดที่เหลือ</button></div>`;btn.disabled=true}
    else if(c.ok){box.className="full check yes";box.innerHTML=`<div class="small muted">${esc(bucketLabel(vid))} · ขอจอง <span class="num">${fmt(q)}</span> ต้น</div><div class="verdict">✓ จองได้</div><div class="big">${fmt(c.after)} <span class="small">ต้น</span></div><div class="small muted">คงเหลือหลังจองครั้งนี้ (จากยอดคงเหลือ ${fmt(c.avail)})</div>`;btn.disabled=!canWrite}
    else{box.className="full check no";box.innerHTML=`<div class="small muted">${esc(bucketLabel(vid))} · ขอจอง <span class="num">${fmt(q)}</span> ต้น</div><div class="verdict">✗ ยอดไม่พอ ขาดอีก ${fmt(c.short)} ต้น</div><div class="big">${fmt(Math.max(0,c.avail))} <span class="small">ต้น</span></div><div class="small">จองได้สูงสุดเท่านี้ ${c.avail>0?`<button class="btn sm ghost" type="button" id="useMax">ใช้จำนวนสูงสุด</button>`:""}</div>`;btn.disabled=true}}
  const bl=bucketList(C);
  $("#availMini").innerHTML=bl.length?`<table><thead><tr><th>Lot / สายพันธุ์</th><th class="r">ขายได้</th><th class="r">จองแล้ว</th><th class="r">คงเหลือจองได้</th><th class="r">อัตราจอง</th></tr></thead><tbody>${bl.map(r=>`<tr><td>${esc(bucketLabel(r.key))}</td><td class="r num">${fmt(r.net)}</td><td class="r num">${fmt(r.booked)}</td><td class="r num" style="font-weight:600;color:var(${r.available>0?"--ok":"--bad"})">${fmt(r.available)}</td><td class="r num">${r.rate.toFixed(1)}%</td></tr>`).join("")}</tbody></table>`:`<div class="empty">ยังไม่มียอดเพาะ — บันทึกการเพาะลงแปลงก่อนจึงจองได้</div>`;
  cardify();
}
function renderList(){
  const fd=$("#l_date").value,fv=$("#l_var").value,fs=$("#l_st").value,fq=$("#l_q").value.trim().toLowerCase();
  const rows=S.bookings.filter(b=>(!fd||b.date===fd)&&(!fv||b.varietyId===fv)&&(!fs||b.status===fs)&&(!fq||((b.docNo||"")+" "+(b.customer||"")+" "+(b.phone||"")).toLowerCase().includes(fq)))
    .sort((a,b)=>(b.date||"").localeCompare(a.date||"")||(b.updatedAt||"").localeCompare(a.updatedAt||""));
  $("#l_count").textContent=`${fmt(rows.length)} รายการ`;
  if(!rows.length){$("#bookList").innerHTML=`<div class="empty" style="margin-top:12px">${S.bookings.length?"ไม่พบรายการตามตัวกรอง":"ยังไม่มีการจอง — บันทึกการจองแรกได้ที่แท็บ “ตรวจสอบ &amp; จอง”"}</div>`;return}
  const groups={};rows.forEach(b=>(groups[b.date]=groups[b.date]||[]).push(b));
  $("#bookList").innerHTML=Object.keys(groups).sort().reverse().map(d=>{const g=groups[d];const act=g.filter(b=>b.status!=="cancelled");
    return `<div class="dayhead"><b>${thDate(d,true)}</b><span>${fmt(g.length)} รายการ · จองรวม <span class="num">${fmt(act.reduce((s,b)=>s+(+b.qty||0),0))}</span> ต้น</span></div>
    <div class="tblwrap"><table><thead><tr><th>ผู้จอง</th><th>Lot / สายพันธุ์</th><th class="r">จำนวน</th><th>นัดรับ</th><th>สถานะ</th><th>จัดการ</th></tr></thead><tbody>${g.map(b=>`<tr>
      <td>${esc(b.customer)}${b.docNo?`<div class="small" style="color:var(--primary);font-weight:600">${esc(b.docNo)}${b.printCount?` · พิมพ์ ${fmt(b.printCount)} ครั้ง`:""}</div>`:""}${b.phone?`<div class="small muted">${esc(b.phone)}</div>`:""}${b.note?`<div class="small muted">${esc(b.note)}</div>`:""}</td>
      <td>${b.lot?esc(bucketLabel(b.lot+"|"+b.varietyId)):esc(vName(b.varietyId))+` <span class="small muted">(ไม่ระบุ Lot)</span>`}</td><td class="r num">${fmt(b.qty)}</td><td>${thDate(b.pickupDate)}</td>
      <td><span class="pill st-${b.status}">${STATUS[b.status]||b.status}</span></td>
      <td><div class="actions"><button class="btn sm ghost" data-bpdf="${esc(b.id)}" type="button">${b.docNo?"พิมพ์ซ้ำ (เลขเดิม)":"พิมพ์ใบจอง PDF"}</button>${canWrite?statusButtons(b):""}</div></td></tr>`).join("")}</tbody></table></div>`}).join("");
  cardify();renderDocResult();
}
function statusButtons(b){
  const btn=(st,l,cls)=>`<button class="btn sm ${cls||"ghost"}" data-bst="${st}" data-id="${esc(b.id)}" type="button">${l}</button>`;
  if(b.status==="reserved")return btn("confirmed","ยืนยัน")+btn("cancelled","ยกเลิก","danger");
  if(b.status==="confirmed")return btn("delivered","ส่งมอบ")+btn("cancelled","ยกเลิก","danger");
  if(b.status==="cancelled")return btn("reserved","คืนสถานะ")+`<button class="btn sm danger" data-bdel="${esc(b.id)}" type="button">ลบ</button>`;
  return "";
}
function renderPlant(C){
  $("#pondSum").innerHTML=pondTable(C);
  $("#lotSum").innerHTML=lotTable();
  const rows=[...S.plantings].sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  if(!rows.length){$("#plantList").innerHTML=`<div class="empty">ยังไม่มีบันทึกการเพาะ — บันทึกการเพาะลงแปลงครั้งแรกด้านบน</div>`;return}
  const groups={};rows.forEach(p=>{const k=lotKey(p);(groups[k]=groups[k]||[]).push(p)});
  $("#plantList").innerHTML=Object.keys(groups).sort().reverse().map(k=>{const g=groups[k];const n=g.reduce((s,p)=>s+(+p.qty||0),0),c=g.reduce((s,p)=>s+(+p.culled||0),0);
    return `<div class="dayhead"><b>${lotLabel(k)}</b><span>${fmt(g.length)} รายการ · เพาะ <span class="num">${fmt(n)}</span> · คัดทิ้ง <span class="num">${fmt(c)}</span> · ขายได้ <span class="num">${fmt(n-c)}</span> ต้น</span></div>
    <div class="tblwrap"><table><thead><tr><th>วันที่เพาะ</th><th>แปลง</th><th>สายพันธุ์</th><th class="r">เพาะ</th><th class="r">คัดทิ้ง</th><th class="r">ขายได้</th><th>หมายเหตุ</th><th>จัดการ</th></tr></thead><tbody>${g.map(p=>`<tr><td>${thDate(p.date)}</td><td>${esc(pName(p.pondId))}</td><td>${esc(vName(p.varietyId))}</td><td class="r num">${fmt(p.qty)}</td><td class="r num">${fmt(p.culled)}</td><td class="r num">${fmt((+p.qty||0)-(+p.culled||0))}</td><td class="small">${esc(p.note||"")}</td>
      <td>${canWrite?`<div class="actions"><button class="btn sm ghost" data-pedit="${esc(p.id)}" type="button">แก้ไข</button><button class="btn sm danger" data-pdel="${esc(p.id)}" type="button">ลบ</button></div>`:""}</td></tr>`).join("")}</tbody></table></div>`}).join("");
}
/* ---------- Lot ---------- */
function lotOfDate(d){if(!d)return "";const y=+d.slice(0,4),m=+d.slice(5,7);return y+"-L"+(m<=6?1:2)}
function lotKey(p){return p.lot||lotOfDate(p.date)}
function lotLabel(k){if(!k)return "-";const [y,l]=k.split("-L");return `Lot${l} / ${(+y)+543} (${l==="1"?"ต้นปี":"กลางปี"})`}
function lotOptions(sel){const y=new Date().getFullYear();let o="";for(let yy=y-1;yy<=y+1;yy++)for(const l of [1,2]){const k=yy+"-L"+l;o+=`<option value="${k}"${k===sel?" selected":""}>${lotLabel(k)}</option>`}
  if(sel&&!o.includes(`"${sel}"`))o=`<option value="${sel}" selected>${lotLabel(sel)}</option>`+o;return o}
function lotTable(){
  const C=calc();const rows=Object.values(C.byBucket).sort((a,b)=>b.lot.localeCompare(a.lot)||vName(a.varietyId).localeCompare(vName(b.varietyId),"th"));
  if(!rows.length)return `<div class="empty">ยังไม่มีบันทึกการเพาะ</div>`;
  const pondsOf=r=>[...new Set(S.plantings.filter(p=>lotKey(p)===r.lot&&p.varietyId===r.varietyId).map(p=>p.pondId))].map(pName).map(esc).join(", ");
  const lots={};rows.forEach(r=>{const t=lots[r.lot]||(lots[r.lot]={q:0,c:0,n:0,b:0,a:0});t.q+=r.planted;t.c+=r.culled;t.n+=r.net;t.b+=r.booked;t.a+=r.available});
  const sub=k=>{const t=lots[k];return `<tr><td colspan="3"><b>รวม ${lotLabel(k).split(" (")[0]}</b></td><td class="r num"><b>${fmt(t.q)}</b></td><td class="r num"><b>${fmt(t.c)}</b></td><td class="r num"><b>${fmt(t.n)}</b></td><td class="r num"><b>${fmt(t.b)}</b></td><td class="r num"><b>${fmt(t.a)}</b></td><td class="r num"><b>${pct(t.b,t.n).toFixed(1)}%</b></td></tr>`};
  let html=`<table><thead><tr><th>Lot</th><th>สายพันธุ์</th><th>แปลง</th><th class="r">เพาะ</th><th class="r">คัดทิ้ง</th><th class="r">ขายได้</th><th class="r">จองแล้ว</th><th class="r">คงเหลือ</th><th class="r">อัตราจอง</th></tr></thead><tbody>`;let last="";
  rows.forEach(r=>{if(r.lot!==last&&last)html+=sub(last);
    html+=`<tr><td>${r.lot!==last?lotLabel(r.lot):""}</td><td>${esc(vName(r.varietyId))}</td><td class="small">${pondsOf(r)}</td><td class="r num">${fmt(r.planted)}</td><td class="r num">${fmt(r.culled)}</td><td class="r num">${fmt(r.net)}</td><td class="r num">${fmt(r.booked)}</td><td class="r num" style="font-weight:600;color:var(${r.available<0?"--bad":"--ok"})">${fmt(r.available)}</td><td class="r num">${r.rate.toFixed(1)}%</td></tr>`;last=r.lot});
  return html+sub(last)+"</tbody></table>";
}
function renderSetup(C){
  const used=id=>S.plantings.some(p=>p.varietyId===id)||S.bookings.some(b=>b.varietyId===id);
  const vs=sortVar(S.varieties);
  $("#varList").innerHTML=vs.length?`<table><thead><tr><th>สายพันธุ์</th><th class="r">ยอดที่ขายได้</th><th>จัดการ</th></tr></thead><tbody>${vs.map(v=>`<tr><td>${esc(v.name)}${v.note?`<div class="small muted">${esc(v.note)}</div>`:""}</td><td class="r num">${fmt(C.byVar[v.id].net)}${C.byVar[v.id].adjust?`<div class="small muted">ยอดปรับ ${C.byVar[v.id].adjust>0?"+":""}${fmt(C.byVar[v.id].adjust)}</div>`:""}</td><td>${canWrite?`<div class="actions"><button class="btn sm ghost" data-vedit="${esc(v.id)}" type="button">แก้ไข</button>${used(v.id)?`<span class="small muted">มีข้อมูลใช้งาน</span>`:`<button class="btn sm danger" data-vdel="${esc(v.id)}" type="button">ลบ</button>`}</div>`:""}</td></tr>`).join("")}</tbody></table>`:`<div class="empty">ยังไม่มีสายพันธุ์ — เพิ่มสายพันธุ์แรกด้านบน</div>`;
  const ps=sortPond(S.ponds);const pused=id=>S.plantings.some(p=>p.pondId===id);
  $("#pondList").innerHTML=ps.length?`<table><thead><tr><th>แปลง</th><th>Lot</th><th>สายพันธุ์</th><th class="r">ความจุ</th><th>จัดการ</th></tr></thead><tbody>${ps.map(p=>`<tr><td>${esc(p.name)}${p.note?`<div class="small muted">${esc(p.note)}</div>`:""}</td><td>${p.lot?(p.lot==="L1"?"Lot1 (ต้นปี)":"Lot2 (กลางปี)"):"-"}</td><td>${p.varietyId?esc(vName(p.varietyId)):"-"}</td><td class="r num">${p.capacity?fmt(p.capacity):"-"}</td><td>${canWrite?`<div class="actions"><button class="btn sm ghost" data-oedit="${esc(p.id)}" type="button">แก้ไข</button>${pused(p.id)?`<span class="small muted">มีข้อมูลใช้งาน</span>`:`<button class="btn sm danger" data-odel="${esc(p.id)}" type="button">ลบ</button>`}</div>`:""}</td></tr>`).join("")}</tbody></table>`:`<div class="empty">ยังไม่มีแปลง — เพิ่มแปลงแรกด้านบน</div>`;
}

/* ---------- events ---------- */
document.querySelectorAll("nav.tabs button").forEach(b=>b.addEventListener("click",()=>{
  document.querySelectorAll("nav.tabs button").forEach(x=>x.setAttribute("aria-selected",x===b));
  document.querySelectorAll("section[id^=tab-]").forEach(s=>s.hidden=s.id!=="tab-"+b.dataset.tab);
  try{localStorage.setItem("palmTab",b.dataset.tab)}catch(e){}
  window.scrollTo({top:0});
}));
try{const t=localStorage.getItem("palmTab");if(t){const b=document.querySelector(`nav.tabs button[data-tab="${t}"]`);b&&b.click()}}catch(e){}

["#b_var","#b_qty"].forEach(s=>$(s).addEventListener("input",()=>renderBookCheck(calc())));
$("#lotPick").addEventListener("click",e=>{const b=e.target.closest(".lot");if(!b||b.disabled)return;$("#b_var").value=b.dataset.key;renderBookCheck(calc());$("#b_qty").focus({preventScroll:true})});
$("#b_lastpdf").addEventListener("click",()=>{if(lastBooked)bookingPdf(lastBooked,$("#b_msg"))});
$("#checkBox").addEventListener("click",e=>{if(e.target.id==="useMax"){$("#b_qty").value=Math.max(0,checkAvail($("#b_var").value,0).avail);renderBookCheck(calc())}});
$("#bookForm").addEventListener("submit",async e=>{e.preventDefault();const m=$("#b_msg");
  const vid=$("#b_var").value,q=parseInt($("#b_qty").value,10)||0;if(!vid){flash(m,"แตะเลือก Lot / สายพันธุ์ก่อน");return}const c=checkAvail(vid,q);const [bLot,bVar]=vid.split("|");
  if(!c.ok){flash(m,`ยอดไม่พอ จองได้สูงสุด ${fmt(Math.max(0,c.avail))} ต้น`);return}
  try{const nid=uid();await save("bookings",nid,{date:$("#b_date").value,lot:bLot,varietyId:bVar,qty:q,customer:$("#b_cust").value.trim(),phone:$("#b_phone").value.trim(),pickupDate:$("#b_pick").value,note:$("#b_note").value.trim(),status:"reserved",createdAt:new Date().toISOString()});
    flash(m,`บันทึกการจอง ${fmt(q)} ต้นแล้ว`,true);lastBooked=nid;$("#b_lastpdf").hidden=false;["#b_qty","#b_cust","#b_phone","#b_note","#b_pick"].forEach(s=>$(s).value="");renderBookCheck(calc())}
  catch(err){flash(m,errText(err))}});

["#l_date","#l_var","#l_st","#l_q"].forEach(s=>$(s).addEventListener("input",renderList));
$("#l_clear").addEventListener("click",()=>{["#l_date","#l_var","#l_st","#l_q","#d_no"].forEach(s=>$(s).value="");$("#docResult").innerHTML="";renderList()});
let docQuery="";
function renderDocResult(){
  const box=$("#docResult");if(!docQuery){box.innerHTML="";return}
  const q=docQuery.toUpperCase().replace(/\s+/g,"");
  const exact=S.bookings.find(b=>(b.docNo||"").toUpperCase()===q);
  const hits=exact?[exact]:S.bookings.filter(b=>(b.docNo||"").toUpperCase().includes(q));
  if(!hits.length){box.innerHTML=`<div class="docres none"><b>ไม่พบเลขที่ใบจอง “${esc(docQuery)}”</b><div class="small muted">ตรวจสอบตัวสะกดอีกครั้ง หรือรายการนี้อาจยังไม่เคยพิมพ์ใบจอง จึงยังไม่มีเลขที่</div></div>`;return}
  if(hits.length>1){box.innerHTML=`<div class="docres"><b>พบ ${fmt(hits.length)} ใบจองที่ตรงบางส่วน</b><div class="actions" style="margin-top:8px">${hits.slice(0,12).map(b=>`<button class="btn sm ghost" type="button" data-dpick="${esc(b.docNo)}">${esc(b.docNo)}</button>`).join("")}</div></div>`;return}
  const b=hits[0],C=calc(),bk=b.lot&&C.byBucket[b.lot+"|"+b.varietyId];
  const dt=v=>v?new Date(v).toLocaleString("th-TH",{dateStyle:"medium",timeStyle:"short"}):"-";
  const row=(k,v)=>`<div class="kv"><span>${k}</span><b>${v}</b></div>`;
  box.innerHTML=`<div class="docres found">
    <div class="drhead"><div><div class="small muted">เลขที่ใบจอง</div><div class="drno">${esc(b.docNo)}</div></div><span class="pill st-${b.status}">${STATUS[b.status]||b.status}</span></div>
    <div class="kvgrid">
      ${row("ผู้จอง",esc(b.customer||"-"))}${row("เบอร์โทร",esc(b.phone||"-"))}
      ${row("Lot / สายพันธุ์",b.lot?esc(bucketLabel(b.lot+"|"+b.varietyId)):esc(vName(b.varietyId)))}${row("จำนวน",fmt(b.qty)+" ต้น")}
      ${row("วันที่จอง",thDate(b.date,true))}${row("วันที่นัดรับ",b.pickupDate?thDate(b.pickupDate,true):"-")}
      ${row("พิมพ์ใบจอง",fmt(b.printCount||0)+" ครั้ง")}${row("พิมพ์ครั้งแรก / ล่าสุด",dt(b.firstPrintedAt)+" / "+dt(b.lastPrintedAt))}
      ${bk?row("คงเหลือใน Lot นี้",fmt(bk.available)+" ต้น"):""}${row("หมายเหตุ",esc(b.note||"-"))}
    </div>
    <div class="actions" style="margin-top:12px"><button class="btn sm ghost" type="button" data-bpdf="${esc(b.id)}">พิมพ์ซ้ำ (เลขเดิม)</button>${canWrite?statusButtons(b):""}</div>
  </div>`;
}
$("#docSearch").addEventListener("submit",e=>{e.preventDefault();docQuery=$("#d_no").value.trim();renderDocResult()});
$("#d_no").addEventListener("input",()=>{if(!$("#d_no").value.trim()){docQuery="";renderDocResult()}});
$("#docResult").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;
  if(b.dataset.dpick){$("#d_no").value=b.dataset.dpick;docQuery=b.dataset.dpick;renderDocResult();return}
  $("#bookList").dispatchEvent(new CustomEvent("docaction",{detail:b}))});
const armed=new Set();
function twoStep(btn,key){if(armed.has(key))return true;armed.add(key);const t=btn.textContent;btn.textContent="ยืนยันลบ?";setTimeout(()=>{armed.delete(key);if(btn.isConnected)btn.textContent=t},3000);return false}
async function bookAction(b){if(!b)return;
  if(b.dataset.bpdf){bookingPdf(b.dataset.bpdf,b);return}
  try{if(b.dataset.bst){const bk=S.bookings.find(x=>x.id===b.dataset.id);
      if(b.dataset.bst==="reserved"&&bk){const c=bk.lot?checkAvail(bk.lot+"|"+bk.varietyId,+bk.qty):{ok:+bk.qty<=calc().byVar[bk.varietyId].available};if(!c.ok){b.textContent="ยอดไม่พอ";return}}
      await patch("bookings",b.dataset.id,{status:b.dataset.bst})}
    else if(b.dataset.bdel&&twoStep(b,"b"+b.dataset.bdel))await remove("bookings",b.dataset.bdel)}
  catch(err){b.textContent="ไม่สำเร็จ";b.title=errText(err)}}
$("#bookList").addEventListener("click",e=>bookAction(e.target.closest("button")));
$("#bookList").addEventListener("docaction",e=>bookAction(e.detail));

function syncFromPond(){const p=S.ponds.find(x=>x.id===$("#p_pond").value);const d=$("#p_date").value||today();
  if(p&&p.varietyId){$("#p_var").value=p.varietyId;$("#p_var").disabled=true}else $("#p_var").disabled=false;
  const k=p&&p.lot?d.slice(0,4)+"-"+p.lot:lotOfDate(d);$("#p_lot").innerHTML=lotOptions(k);$("#p_lot").disabled=!!(p&&p.lot)}
$("#p_pond").addEventListener("change",syncFromPond);
function resetPlant(){$("#p_id").value="";["#p_qty","#p_note"].forEach(s=>$(s).value="");$("#p_cull").value=0;$("#p_cancel").hidden=true;$("#p_title").textContent="บันทึกการเพาะรายวัน";$("#p_submit").textContent="บันทึก"}
$("#p_cancel").addEventListener("click",resetPlant);
$("#plantForm").addEventListener("submit",async e=>{e.preventDefault();const m=$("#p_msg");
  const q=parseInt($("#p_qty").value,10)||0,c=parseInt($("#p_cull").value,10)||0;
  if(c>q){flash(m,"จำนวนคัดทิ้งต้องไม่มากกว่าจำนวนเพาะ");return}
  const id=$("#p_id").value||null;const prev=id&&S.plantings.find(x=>x.id===id);
  try{await save("plantings",id,{lot:$("#p_lot").value,date:$("#p_date").value,pondId:$("#p_pond").value,varietyId:$("#p_var").value,qty:q,culled:c,note:$("#p_note").value.trim(),createdAt:prev?.createdAt||new Date().toISOString()});
    flash(m,id?"แก้ไขแล้ว":`บันทึกการเพาะ ${fmt(q)} ต้นลง${pName($("#p_pond").value)}แล้ว`,true);resetPlant()}catch(err){flash(m,errText(err))}});
$("#plantList").addEventListener("click",async e=>{const b=e.target.closest("button");if(!b)return;
  if(b.dataset.pedit){const p=S.plantings.find(x=>x.id===b.dataset.pedit);if(!p)return;$("#p_id").value=p.id;$("#p_lot").innerHTML=lotOptions(lotKey(p));$("#p_date").value=p.date;$("#p_pond").value=p.pondId;syncFromPond();$("#p_var").value=p.varietyId;$("#p_qty").value=p.qty;$("#p_cull").value=p.culled||0;$("#p_note").value=p.note||"";$("#p_cancel").hidden=false;$("#p_title").textContent="แก้ไขบันทึกการเพาะ";$("#p_submit").textContent="บันทึกการแก้ไข";$("#plantForm").scrollIntoView({behavior:"smooth",block:"center"})}
  else if(b.dataset.pdel&&twoStep(b,"p"+b.dataset.pdel)){try{await remove("plantings",b.dataset.pdel)}catch(err){b.textContent="ไม่สำเร็จ"}}});

function netAdjust(id){const prev=id?(+(S.varieties.find(x=>x.id===id)||{}).adjust||0):0;const raw=$("#v_net").value;if(raw==="")return prev;
  let base=0;S.plantings.forEach(p=>{if(p.varietyId===id)base+=(+p.qty||0)-(+p.culled||0)});return Math.max(0,parseInt(raw,10)||0)-base}
function resetVar(){["#v_id","#v_name","#v_net","#v_note"].forEach(s=>$(s).value="");$("#v_cancel").hidden=true}
$("#v_cancel").addEventListener("click",resetVar);
$("#varForm").addEventListener("submit",async e=>{e.preventDefault();const m=$("#v_msg");const name=$("#v_name").value.trim();const id=$("#v_id").value||null;
  if(S.varieties.some(v=>v.id!==id&&v.name.trim()===name)){flash(m,"มีสายพันธุ์ชื่อนี้แล้ว");return}
  try{await save("varieties",id,{name,note:$("#v_note").value.trim(),adjust:netAdjust(id)});flash(m,"บันทึกสายพันธุ์แล้ว",true);resetVar()}catch(err){flash(m,errText(err))}});
$("#varList").addEventListener("click",async e=>{const b=e.target.closest("button");if(!b)return;
  if(b.dataset.vedit){const v=S.varieties.find(x=>x.id===b.dataset.vedit);$("#v_id").value=v.id;$("#v_name").value=v.name;$("#v_net").value=calc().byVar[v.id].net;{let base=0;S.plantings.forEach(p=>{if(p.varietyId===v.id)base+=(+p.qty||0)-(+p.culled||0)});const m=$("#v_msg");m.className="msg";m.textContent=`ยอดจากบันทึกการเพาะ ${fmt(base)} ต้น · ใส่ยอดที่ขายได้รวมทั้งหมด ไม่ใช่ยอดเพิ่ม`}$("#v_note").value=v.note||"";$("#v_cancel").hidden=false}
  else if(b.dataset.vdel&&twoStep(b,"v"+b.dataset.vdel)){try{await remove("varieties",b.dataset.vdel)}catch(err){b.textContent="ไม่สำเร็จ"}}});

function resetPond(){["#o_id","#o_name","#o_cap","#o_note"].forEach(s=>$(s).value="");$("#o_lot").value="L1";$("#o_cancel").hidden=true}
$("#o_cancel").addEventListener("click",resetPond);
$("#pondForm").addEventListener("submit",async e=>{e.preventDefault();const m=$("#o_msg");const lotC=$("#o_lot").value,vid=$("#o_var").value;if(!vid){flash(m,"เลือกสายพันธุ์ก่อน");return}
  const name=$("#o_name").value.trim()||(lotC==="L1"?"Lot1":"Lot2")+"/"+vName(vid);const id=$("#o_id").value||null;
  if(S.ponds.some(p=>p.id!==id&&p.name.trim()===name)){flash(m,"มีแปลงชื่อนี้แล้ว");return}
  try{await save("ponds",id,{name,lot:lotC,capacity:parseInt($("#o_cap").value,10)||0,varietyId:vid,note:$("#o_note").value.trim()});flash(m,"บันทึกแปลงแล้ว",true);resetPond()}catch(err){flash(m,errText(err))}});
$("#pondList").addEventListener("click",async e=>{const b=e.target.closest("button");if(!b)return;
  if(b.dataset.oedit){const p=S.ponds.find(x=>x.id===b.dataset.oedit);$("#o_id").value=p.id;$("#o_name").value=p.name;$("#o_cap").value=p.capacity||"";$("#o_var").value=p.varietyId||"";$("#o_lot").value=p.lot||"L1";$("#o_note").value=p.note||"";$("#o_cancel").hidden=false}
  else if(b.dataset.odel&&twoStep(b,"o"+b.dataset.odel)){try{await remove("ponds",b.dataset.odel)}catch(err){b.textContent="ไม่สำเร็จ"}}});


/* ---------- mobile cards ---------- */
function cardify(){document.querySelectorAll(".tblwrap table").forEach(t=>{t.classList.add("cardify");const hs=[...t.querySelectorAll("thead th")].map(h=>h.textContent.trim());
  t.querySelectorAll("tbody tr").forEach(tr=>{let i=0;[...tr.children].forEach(td=>{const sp=+td.getAttribute("colspan")||1;if(sp>1)tr.classList.add("subtotal");td.setAttribute("data-label",sp>1||hs[i]==="จัดการ"?"":(hs[i]||""));i+=sp})})})}

/* ---------- booking document (PDF) ---------- */
let lastBooked=null;
/* เลขที่ใบจอง: ออกครั้งแรกตอนพิมพ์ แล้วบันทึกไว้กับรายการ พิมพ์ซ้ำใช้เลขเดิม · รูปแบบ BK{ปีพ.ศ.2หลัก}{เดือน}{วัน}-{ลำดับ 4 หลัก} */
function docPrefix(b){const d=b.date||today();return "BK"+String(+d.slice(0,4)+543).slice(2)+d.slice(5,7)+d.slice(8,10)+"-"}
function nextDocNo(b){const pre=docPrefix(b);let mx=0;S.bookings.forEach(x=>{if(x.docNo&&x.docNo.startsWith(pre)){const n=parseInt(x.docNo.slice(pre.length),10);if(n>mx)mx=n}});return pre+String(mx+1).padStart(4,"0")}
function docNoOf(b){return b.docNo||""}
/* หัวใบจอง: ชื่อร้าน เบอร์โทร */
const SHOP={name:"โกเพียวพันธุ์ปาล์ม",phone:"065-449-4201"};
/* โลโก้ตราประทับ โกเพียวพันธุ์ปาล์ม: วงแหวนเขียวเข้มขอบทอง ชื่อร้านโค้งตามวง ต้นกล้าปาล์มใบขนนกงอกจากผลปาล์มสุก หน้าดวงอาทิตย์ */
const SHOP_LOGO=(()=>{
  const r=n=>Math.round(n*10)/10;
  const frond=(x0,y0,cx,cy,x1,y1,n,L,cols)=>{let s=`<path d="M${x0} ${y0}Q${cx} ${cy} ${x1} ${y1}" fill="none" stroke="#2d6a1f" stroke-width="1.6" stroke-linecap="round"/>`;
    for(let i=0;i<n;i++){const t=.18+.8*i/(n-1),u=1-t,px=u*u*x0+2*u*t*cx+t*t*x1,py=u*u*y0+2*u*t*cy+t*t*y1,tx=2*u*(cx-x0)+2*t*(x1-cx),ty=2*u*(cy-y0)+2*t*(y1-cy),tl=Math.hypot(tx,ty),a=Math.atan2(ty,tx),l=L*(1-.55*t);
      [-1,1].forEach((sd,k)=>{const b=a+sd*.75,ex=px+Math.cos(b)*l,ey=py+Math.sin(b)*l,mx=(px+ex)/2,my=(py+ey)/2,nx=-Math.sin(b)*l*.22,ny=Math.cos(b)*l*.22;
        s+=`<path d="M${r(px)} ${r(py)}Q${r(mx+nx)} ${r(my+ny)} ${r(ex)} ${r(ey)}Q${r(mx-nx)} ${r(my-ny)} ${r(px)} ${r(py)}Z" fill="${cols[(i+k)%2]}"/>`})}
    return s};
  const F="font-family=\"'Noto Sans Thai','Leelawadee UI',Tahoma,sans-serif\" font-weight=\"700\" fill=\"#fdf3d0\" text-anchor=\"middle\"";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88" viewBox="0 0 120 120"><defs>
<radialGradient id="kpBg" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#fffaf0"/><stop offset="1" stop-color="#f1e6c4"/></radialGradient>
<radialGradient id="kpSun" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffd54f"/><stop offset=".6" stop-color="#ffca28" stop-opacity=".85"/><stop offset="1" stop-color="#ffca28" stop-opacity="0"/></radialGradient>
<radialGradient id="kpFruit" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#ffb74d"/><stop offset=".45" stop-color="#f4511e"/><stop offset="1" stop-color="#8e1b0e"/></radialGradient>
<clipPath id="kpIn"><circle cx="60" cy="60" r="39"/></clipPath>
<path id="kpTop" d="M17 60A43 43 0 0 1 103 60"/><path id="kpBot" d="M11 60A49 49 0 0 0 109 60"/></defs>
<circle cx="60" cy="60" r="59" fill="#d4a017"/><circle cx="60" cy="60" r="57" fill="#14532d"/>
<circle cx="60" cy="60" r="54.5" fill="none" stroke="#d4a017" stroke-width=".8"/>
<text ${F} font-size="11" letter-spacing=".3"><textPath href="#kpTop" startOffset="50%">โกเพียวพันธุ์ปาล์ม</textPath></text>
<text ${F} font-size="8.5" letter-spacing="1.2"><textPath href="#kpBot" startOffset="50%">ต้นกล้าพันธุ์ดี</textPath></text>
<path d="M12 57.5l1.6 1.6l-1.6 1.6l-1.6-1.6zM108 57.5l1.6 1.6l-1.6 1.6l-1.6-1.6z" fill="#d4a017"/>
<circle cx="60" cy="60" r="40.5" fill="#d4a017"/><circle cx="60" cy="60" r="39" fill="url(#kpBg)"/>
<g clip-path="url(#kpIn)"><circle cx="60" cy="60" r="27" fill="url(#kpSun)"/>
${[...Array(9)].map((_,i)=>{const a=Math.PI*(1+i/8);return `<path d="M${r(60+Math.cos(a)*23)} ${r(62+Math.sin(a)*23)}L${r(60+Math.cos(a)*33)} ${r(62+Math.sin(a)*33)}" stroke="#f9b233" stroke-width="2" stroke-linecap="round" opacity=".6"/>`}).join("")}
<path d="M18 86Q40 77 60 82T102 84V102H18Z" fill="#6d3f1d"/><path d="M18 91Q42 84 60 88T102 90" fill="none" stroke="#8d5a2b" stroke-width="1.6"/></g>
<path d="M60 80Q58.5 70 60 60" fill="none" stroke="#2d6a1f" stroke-width="3.2" stroke-linecap="round"/>
${frond(60,62,46,48,30,52,8,15,["#2e7d32","#43a047"])}${frond(60,62,74,48,90,52,8,15,["#43a047","#2e7d32"])}
${frond(60,61,51,42,43,30,8,13,["#4caf50","#66bb6a"])}${frond(60,61,69,42,77,30,8,13,["#66bb6a","#4caf50"])}
<path d="M60 62C55 50 56 34 60 22C64 34 65 50 60 62Z" fill="#7cb342"/><path d="M60 58V27" stroke="#c5e1a5" stroke-width=".9"/>
${[[52,83,5.2],[68,83,5.2],[56,79,5.6],[64,79,5.6],[60,84,6]].map(([x,y,s])=>`<circle cx="${x}" cy="${y}" r="${s}" fill="url(#kpFruit)" stroke="#5d1208" stroke-width=".5"/><ellipse cx="${x-1.6}" cy="${y-1.9}" rx="1.6" ry="1.1" fill="#fff3e0" opacity=".7"/>`).join("")}
</svg>`})();
function bookingDocHtml(b,copyNo){
  const lot=b.lot?bucketLabel(b.lot+"|"+b.varietyId):vName(b.varietyId);const now=new Date();
  const row=(k,v)=>`<tr><td style="padding:7px 0;color:#615d59;width:150px">${k}</td><td style="padding:7px 0;font-weight:500">${v}</td></tr>`;
  return `<div style="width:794px;min-height:1123px;padding:64px 64px 48px;background:#fff;color:#191918;font:15px/1.6 'Inter','Noto Sans Thai',sans-serif;letter-spacing:0;box-sizing:border-box;display:flex;flex-direction:column">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #191918;padding-bottom:18px">
    <div><div style="font-size:13px;color:#615d59">Oil Palm Seedling Reservation System</div><div style="font-size:30px;font-weight:700;line-height:1.2">ใบจองต้นกล้าปาล์ม</div><div style="display:flex;align-items:center;gap:14px;margin-top:10px"><div><div style="font-size:18px;font-weight:700;color:#2e7d32;line-height:1.3">${SHOP.name}</div><div style="font-size:14px;color:#615d59">โทร. ${SHOP.phone}</div></div>${SHOP_LOGO}</div></div>
    <div style="text-align:right;font-size:13px;color:#615d59"><div style="display:inline-block;margin-bottom:6px;padding:2px 10px;border-radius:5px;font-weight:600;${copyNo>1?"background:#fbecdf;color:#dd5b00":"background:#e6f1fb;color:#0075de"}">${copyNo>1?"สำเนา · พิมพ์ครั้งที่ "+copyNo:"ต้นฉบับ"}</div><br>เลขที่ใบจอง<div style="font-size:18px;font-weight:700;color:#191918">${esc(docNoOf(b))}</div>วันที่จอง ${thDate(b.date,true)}</div>
  </div>
  <div style="margin-top:28px;font-weight:700;font-size:13px;color:#615d59">ข้อมูลผู้จอง</div>
  <table style="border-collapse:collapse;width:100%">${row("ชื่อผู้จอง",esc(b.customer||"-"))}${row("เบอร์โทร",esc(b.phone||"-"))}${row("วันที่นัดรับ",b.pickupDate?thDate(b.pickupDate,true):"-")}${row("สถานะ",STATUS[b.status]||b.status)}</table>
  <div style="margin-top:24px;font-weight:700;font-size:13px;color:#615d59">รายการจอง</div>
  <table style="border-collapse:collapse;width:100%;margin-top:8px">
    <tr style="background:#f6f5f4"><th style="text-align:left;padding:10px 12px;font-size:13px">ลำดับ</th><th style="text-align:left;padding:10px 12px;font-size:13px">รายการ</th><th style="text-align:left;padding:10px 12px;font-size:13px">Lot / สายพันธุ์</th><th style="text-align:right;padding:10px 12px;font-size:13px">จำนวน (ต้น)</th></tr>
    <tr><td style="padding:12px;border-bottom:1px solid #e6e6e6">1</td><td style="padding:12px;border-bottom:1px solid #e6e6e6">ต้นกล้าปาล์มน้ำมัน สายพันธุ์ ${esc(vName(b.varietyId))}</td><td style="padding:12px;border-bottom:1px solid #e6e6e6">${esc(lot)}</td><td style="padding:12px;border-bottom:1px solid #e6e6e6;text-align:right;font-weight:600">${fmt(b.qty)}</td></tr>
    <tr><td colspan="3" style="padding:12px;text-align:right;font-weight:700">รวมทั้งสิ้น</td><td style="padding:12px;text-align:right;font-weight:700;font-size:18px">${fmt(b.qty)} ต้น</td></tr>
  </table>
  <div style="margin-top:20px;font-size:13px;color:#615d59">หมายเหตุ</div><div style="min-height:48px;border:1px solid #e6e6e6;border-radius:6px;padding:10px 12px">${esc(b.note||"-")}</div>
  <div style="flex:1"></div>
  <div style="display:flex;justify-content:space-between;gap:48px;margin-top:56px;text-align:center;font-size:14px">
    <div style="flex:1"></div>
    <div style="flex:1"><div style="border-bottom:1px dotted #615d59;height:48px"></div><div style="margin-top:8px">ผู้รับจอง</div><div style="color:#615d59;font-size:13px">(..................................................)</div><div style="color:#615d59;font-size:13px;margin-top:6px">วันที่ ......../......../........</div></div>
  </div>
  <div style="margin-top:36px;padding-top:12px;border-top:1px solid #e6e6e6;font-size:12px;color:#a39e98;display:flex;justify-content:space-between"><span>เอกสารออกจาก Oil Palm Seedling Reservation System</span><span>พิมพ์เมื่อ ${now.toLocaleString("th-TH",{dateStyle:"medium",timeStyle:"short"})}</span></div>
  </div>`;
}
async function bookingPdf(id,el){
  const b=S.bookings.find(x=>x.id===id);if(!b)return;
  const say=t=>{if(el.classList&&el.classList.contains("msg"))flash(el,t,false);else{const o=el.textContent;el.textContent=t;setTimeout(()=>{if(el.isConnected)el.textContent=o},2500)}};
  if(!window.html2canvas||!window.jspdf){say("กำลังโหลดตัวสร้าง PDF ลองอีกครั้ง");return}
  let no=b.docNo;const firstPrint=!no;
  if(firstPrint){
    if(!canWrite){say("ยังไม่มีเลขที่ใบจอง และบัญชีนี้บันทึกไม่ได้");return}
    try{
      if(sb){const {data,error}=await sb.rpc("assign_doc_no",{p_booking_id:b.id});if(error)throw error;no=data;await reload("bookings")}
      else{no=nextDocNo(b);await patch("bookings",b.id,{docNo:no,firstPrintedAt:new Date().toISOString()})}
    }catch(err){say(errText(err));return}
  }
  const copyNo=(+b.printCount||0)+1;
  const doc={...b,docNo:no};
  const orig=el.textContent;if(!el.classList.contains("msg"))el.textContent="กำลังสร้าง…";
  const host=document.createElement("div");host.style.cssText="position:fixed;left:-10000px;top:0;z-index:-1";host.innerHTML=bookingDocHtml(doc,copyNo);document.body.appendChild(host);
  try{
    try{await document.fonts.ready}catch(e){}
    const canvas=await html2canvas(host.firstElementChild,{scale:2,backgroundColor:"#ffffff",useCORS:true,logging:false});
    const pdf=new window.jspdf.jsPDF({unit:"pt",format:"a4",orientation:"portrait"});
    const W=pdf.internal.pageSize.getWidth(),H=pdf.internal.pageSize.getHeight();
    pdf.addImage(canvas.toDataURL("image/jpeg",0.92),"JPEG",0,0,W,Math.min(H,canvas.height*W/canvas.width));
    pdf.setProperties({title:"ใบจอง "+no});
    pdf.save(`ใบจอง_${no}${copyNo>1?"_สำเนา"+copyNo:""}.pdf`);
    if(canWrite){try{if(sb){const {error}=await sb.rpc("mark_printed",{p_booking_id:b.id});if(error)throw error;await reload("bookings")}else await patch("bookings",b.id,{printCount:copyNo,lastPrintedAt:new Date().toISOString()})}catch(e){}}
    if(!el.classList.contains("msg"))el.textContent=orig;else flash(el,"บันทึก PDF แล้ว",true);
  }catch(err){if(!el.classList.contains("msg"))el.textContent=orig;
    say("สร้าง PDF ไม่สำเร็จ")}
  finally{host.remove()}
}
/* ---------- boot ---------- */
$("#b_date").value=today();$("#p_date").value=today();$("#p_lot").innerHTML=lotOptions(lotOfDate(today()));
$("#p_date").addEventListener("change",syncFromPond);
render();
/* ---------- auth + live data ---------- */
function setMode(t,bad){const m=$("#mode");m.textContent=t;m.className="mode"+(bad?" demo":"")}
function show(view){$("#loginView").hidden=view!=="login";$("#appView").hidden=view!=="app"}
let rt=null;const dirty=new Set();
function refresh(c){dirty.add(c);clearTimeout(rt);rt=setTimeout(async()=>{const cs=[...dirty];dirty.clear();try{await Promise.all(cs.map(load));render()}catch(e){setMode(errText(e),true)}},80)}
function subscribe(){
  chan=sb.channel("palm-db");
  COLLS.forEach(c=>chan.on("postgres_changes",{event:"*",schema:"public",table:c},()=>refresh(c)));
  chan.subscribe(st=>{if(st==="SUBSCRIBED"){setMode(canWrite?"เชื่อมต่อฐานข้อมูลแล้ว":"ดูอย่างเดียว");COLLS.forEach(refresh)}
    else if(st==="CHANNEL_ERROR"||st==="TIMED_OUT")setMode("ขาดการเชื่อมต่อแบบเรียลไทม์ — รีโหลดหน้าเพื่ออัปเดตข้อมูล",true)});
}
async function startSession(s){
  session=s;$("#who_email").textContent=s.user.email||"";$("#who_email").hidden=false;$("#logout").hidden=false;setMode("กำลังโหลดข้อมูล…");
  const {data:me,error}=await sb.from("staff").select("role").eq("user_id",s.user.id).maybeSingle();
  if(error){setMode(errText(error),true);return}
  if(!me){const em=s.user.email;await sb.auth.signOut();flash($("#li_msg"),`บัญชี ${em} ยังไม่ได้รับสิทธิ์ใช้งาน — ติดต่อผู้ดูแลระบบ`);return}
  canWrite=me.role==="editor";live=true;
  try{await Promise.all(COLLS.map(load))}catch(e){setMode(errText(e),true);return}
  render();show("app");setMode(canWrite?"เชื่อมต่อฐานข้อมูลแล้ว":"ดูอย่างเดียว");subscribe();
}
function endSession(){
  session=null;if(chan){sb.removeChannel(chan);chan=null}
  COLLS.forEach(c=>S[c]=[]);canWrite=false;live=false;lastBooked=null;$("#b_lastpdf").hidden=true;
  $("#who_email").hidden=true;$("#logout").hidden=true;setMode("ยังไม่ได้เข้าสู่ระบบ",true);render();show("login");
}
$("#loginForm").addEventListener("submit",async e=>{e.preventDefault();const m=$("#li_msg"),btn=$("#li_submit");
  btn.disabled=true;m.className="msg";m.textContent="กำลังเข้าสู่ระบบ…";
  const {error}=await sb.auth.signInWithPassword({email:$("#li_email").value.trim(),password:$("#li_pass").value});
  btn.disabled=false;$("#li_pass").value="";
  if(error){flash(m,/invalid login credentials/i.test(error.message)?"อีเมลหรือรหัสผ่านไม่ถูกต้อง":/email not confirmed/i.test(error.message)?"อีเมลนี้ยังไม่ได้ยืนยัน":errText(error));return}
  m.textContent=""});
$("#logout").addEventListener("click",()=>sb&&sb.auth.signOut());

if(!CFG.supabaseUrl||!CFG.supabaseKey||!window.supabase){
  demo();setMode(CFG.supabaseUrl&&!window.supabase?"โหลดตัวเชื่อมต่อฐานข้อมูลไม่ได้ — แสดงข้อมูลตัวอย่าง":"โหมดตัวอย่าง — ข้อมูลไม่ถูกบันทึก",true);show("app");render();
}else{
  canWrite=false;sb=window.supabase.createClient(CFG.supabaseUrl,CFG.supabaseKey);
  // defer: calling Supabase inside this callback can deadlock the auth client
  sb.auth.onAuthStateChange((ev,s)=>setTimeout(()=>{
    if(!s){if(ev!=="TOKEN_REFRESHED")endSession();return}
    if(!session||session.user.id!==s.user.id)startSession(s);else session=s;
  },0));
}
})();
