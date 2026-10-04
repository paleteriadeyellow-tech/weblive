const q=new URLSearchParams(location.search),$=id=>document.getElementById(id),clean=q.has('clean');
if(clean)document.body.classList.add('clean');
// Livecoins: arrancar en 0/pausado (el bridge + WS ponen el tiempo real). Evita flash 01:16 del demo.
const START=q.has('start')?(+q.get('start')||0):0;
let rem=START,pending=0,run=false,last='';
const pill=$('pill'),dg=$('dg'),hand=$('hand'),fx=$('fx'),zone=$('zone'),alertEl=$('alert');
let S=1;
function fit(){S=Math.min(innerWidth/700,(innerHeight-(clean?20:110))/290,2.6);alertEl.style.top=clean?'50%':'46%';alertEl.style.transform=`translate(-50%,-50%) scale(${S})`}
addEventListener('resize',fit);fit();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/* dígitos */
function render(){
  const v=Math.max(0,Math.ceil(rem)),str=String(Math.floor(v/60)).padStart(2,'0')+':'+String(v%60).padStart(2,'0');
  if(str!==last){
    if(str.length!==last.length){dg.innerHTML='';[...str].forEach((c)=>{const e=document.createElement('span');if(c===':')e.className='co';dg.appendChild(e)})}
    // Sin flip WAAPI mientras pending sube/baja: en Live Studio se trababa al sumar.
    const soft=Math.abs(pending)>.05;
    [...str].forEach((c,i)=>{const e=dg.children[i];if(e.textContent!==c){e.textContent=c;if(!soft&&c!==':')e.animate([{transform:'translateY(-30%)',opacity:.35},{transform:'none',opacity:1}],{duration:150,easing:'ease-out'})}});
    last=str;
  }
  pill.classList.toggle('low',rem>0&&rem<10&&Math.abs(pending)<.05);pill.classList.toggle('end',rem<=0&&Math.abs(pending)<.05);
}
let tp=performance.now();
function loop(now){
  const dt=Math.min(.25,(now-tp)/1000);tp=now;
  if(run&&rem>0)rem=Math.max(0,rem-dt);
  if(Math.abs(pending)>.01){
    const mag=Math.min(Math.abs(pending),Math.max(Math.abs(pending)*(1-Math.exp(-dt*5)),14*dt));
    const s=pending>0?1:-1;
    rem=Math.max(0,rem+s*mag);pending-=s*mag;
    pill.classList.add('adding');
    pill.classList.toggle('removing',pending<0||s<0);
  }else{
    if(pending){rem=Math.max(0,rem+pending);pending=0}
    pill.classList.remove('adding','removing');
  }
  // #hand se recrea al cambiar skin (pixel↔normal)
  const h=document.getElementById('hand');
  if(h)h.style.transform=`rotate(${(rem%60)*6}deg)`;
  render();requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* efectos */
function center(el){const r=el.getBoundingClientRect();return[r.left+r.width/2,r.top+r.height/2]}
function burst(x,y,sub){
  const cols=sub?['#ff4d6d','#ff2bd6','#fff','#ff9f1c']:['#19e6ff','#ff2bd6','#fff','#a98bff'];
  for(let i=0;i<12;i++){const e=document.createElement('i');e.className='sp';const c=cols[i%4];e.style.background=c;e.style.boxShadow=`0 0 8px ${c}`;fx.appendChild(e);
    const a=Math.random()*6.28,d=(50+Math.random()*80)*S;
    e.animate([{transform:`translate(${x}px,${y}px) scale(1)`,opacity:1},{transform:`translate(${x+Math.cos(a)*d}px,${y+Math.sin(a)*d}px) scale(.2)`,opacity:0}],{duration:600+Math.random()*300,easing:'cubic-bezier(.1,.7,.3,1)'}).onfinish=()=>e.remove()}
}
function arrive(chunk){
  if(window.TimerFX&&typeof TimerFX.onChunk==='function')TimerFX.onChunk(chunk);
  pending+=chunk;const[x,y]=center(pill);const sub=chunk<0;burst(x,y,sub);
  // Pulsar el wrap (no el pill): evita pelear con transform/skew/rotación de skins
  const wrap=pill.parentElement||pill;
  try{
    if(wrap.getAnimations)wrap.getAnimations().forEach((a)=>{try{a.cancel()}catch{}});
    wrap.animate([{transform:'scale(1)'},{transform:'scale(1.04)'},{transform:'scale(1)'}],{duration:200,easing:'ease-out'});
  }catch{}
  const f=document.createElement('div');f.className='fl'+(sub?' fl-sub':'');f.textContent=(chunk>0?'+':'')+Math.round(chunk)+'s';f.style.fontSize=30*S+'px';fx.appendChild(f);
  const fx0=x+60*S+Math.random()*60*S,fy0=y-30*S;
  f.animate([{transform:`translate(${fx0}px,${fy0}px) scale(.6)`,opacity:0},{transform:`translate(${fx0}px,${fy0-26*S}px) scale(1.1)`,opacity:1,offset:.25},{transform:`translate(${fx0}px,${fy0-90*S}px) scale(1)`,opacity:0}],{duration:1100,easing:'ease-out'}).onfinish=()=>f.remove();
}
function orb(from,chunk,i){
  const[x0,y0]=from,[x1,y1]=center(pill),sz=22*S,mx=(x0+x1)/2+(i%2?1:-1)*(60+Math.random()*60)*S,my=(y0+y1)/2-20*S;
  const e=document.createElement('i');e.className='orb'+(chunk<0?' orb-sub':'');e.style.width=e.style.height=sz+'px';fx.appendChild(e);
  const t=(x,y,s)=>`translate(${x-sz/2}px,${y-sz/2}px) scale(${s})`;
  e.animate([{transform:t(x0,y0,.5),opacity:0},{transform:t(x0,y0,1),opacity:1,offset:.12},{transform:t(mx,my,1.15),offset:.55},{transform:t(x1,y1,.45),opacity:.9}],{duration:680,easing:'cubic-bezier(.45,0,.75,.5)'}).onfinish=()=>{e.remove();arrive(chunk)};
}

/* tarjetas de regalo (cola) */
const Q=[];let busy=false;
function hue(s){let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))%360;return h}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function giftSym(n){const k=({rosa:'rosa',rose:'rosa','corazón':'corazon',corazon:'corazon',heart:'corazon',dona:'dona',donut:'dona',universo:'universo',universe:'universo'})[String(n).toLowerCase()];return k?'g-'+k:'g-star'}
function setAmt(el,v,anim,sub){
  const mag=Math.abs(Math.round(v));
  const str=(sub?'-':'+')+mag+'s';el.innerHTML='';
  el.classList.toggle('amt-sub',!!sub);
  [...str].forEach((c,i)=>{const e=document.createElement('i');e.textContent=c;if(anim){e.className='ch';e.style.animationDelay=(.45+i*.07)+'s'}el.appendChild(e)});
  if(!anim)el.animate([{transform:'scale(1.12)'},{transform:'scale(1)'}],{duration:200});
}
function card(j){
  const el=document.createElement('div');el.className='card';const user=j.user||'Usuario',h=hue(user);
  const signed=Number(j.seconds)||0;const sub=signed<0;const sec=Math.abs(Math.round(signed));
  const n=j.count>1?` ×${j.count}`:'';
  const verb=sub?'restó':'envió';
  el.innerHTML=`<div class="ag"><div class="pf" style="background:linear-gradient(135deg,hsl(${h} 85% 60%),hsl(${h+60} 75% 32%))">${j.img?`<img src="${esc(j.img)}" alt="" referrerpolicy="no-referrer">`:esc(user[0].toUpperCase())}</div>
  ${j.giftImg?`<img class="gf" src="${esc(j.giftImg)}" alt="" referrerpolicy="no-referrer">`:`<svg class="gf" viewBox="0 0 64 64"><use href="#${giftSym(j.gift)}"/></svg>`}</div>
  <div class="who"><b>${esc(user)}</b><span>${verb} <em>${esc(j.gift||'un regalo')}${n}</em></span></div><div class="amt"></div>`;
  setAmt(el.querySelector('.amt'),sec,true,sub);
  const im=el.querySelector('.pf img');if(im)im.onerror=()=>{im.parentNode.textContent=user[0].toUpperCase()};
  const gi=el.querySelector('img.gf');if(gi)gi.onerror=()=>{gi.outerHTML=`<svg class="gf" viewBox="0 0 64 64"><use href="#g-star"/></svg>`};
  el._sub=sub;el._sec=sec;el._signed=signed;
  return el;
}
async function next(){
  if(!Q.length){busy=false;return}busy=true;
  const j=Q.shift(),fast=Q.length>1?.55:1,el=card(j);zone.appendChild(el);el.classList.add('in');
  await sleep(1150*fast);
  const amt=el.querySelector('.amt'),sec=el._sec,sub=el._sub;
  const n=Math.min(6,Math.max(1,Math.ceil(sec/15))),chunkAbs=sec/n;let left=sec;
  const chunk=sub?-chunkAbs:chunkAbs;
  for(let i=0;i<n;i++){orb(center(amt),chunk,i);left-=chunkAbs;if(i<n-1)setAmt(amt,left,false,sub);await sleep(120*fast)}
  amt.style.opacity=0;
  await sleep(800*fast);el.classList.replace('in','out');await sleep(450);el.remove();next();
}
window.addTime=j=>{j.seconds=+j.seconds||0;if(!j.seconds)return;Q.push(j);if(!busy)next()};
window.setTime=s=>{rem=+s||0;pending=0};
window.pause=()=>{run=false;const b=$('pz');if(b)b.textContent='Reanudar'};window.resume=()=>{run=true;const b=$('pz');if(b)b.textContent='Pausar'};

/* API pública para la app */
window.TimerFX={addTime:window.addTime,setTime:window.setTime,pause:window.pause,resume:window.resume,onChunk:null};
