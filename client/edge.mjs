// settlement with 1, 2, 3, 4 entrants (20 covered by arena20.mjs): exact payouts, double-op guards, cleanup refund
import * as L from "./lib.mjs"; import * as F from "./flows.mjs"; import fs from "fs";
const {K,ixp,O}=L; const log=L.logger(L.EV+"edge.txt"); const c=await F.ctx(); const st=c.st; const names=st.names; const FEE=10;
log("\n== EDGE CASES",new Date().toISOString());
let k=0; for(const n of [1,2,3,4]){ const sid=st.sid+1800+k++; const entries=[0,1,2,3,4].slice(0,n).map(i=>[i,i+1]); const hub0=await F.hubLamports(c); const b0=[]; for(let o=0;o<5;o++) b0.push(await F.bal(c,o));
  await F.createSeason(c,sid,{neps:2,fee:FEE}); await F.initPool(c,sid); await F.awaitPoolReady(c,sid,0,1); const en=await F.enter(c,sid,entries); await L.sendTee(c.URL,[F.lockIx(sid)],[O]); await L.sendTee(c.URL,[F.seedIx(sid)],[O]);
  const d=await F.drive(c,sid,60); const early=await L.sendTee(c.URL,[F.publishIx(c,sid,0,0,1)],[O]); const s=await L.sendTee(c.URL,[F.settleIx(c,sid,entries)],[O]); const s2=await L.sendTee(c.URL,[F.settleIx(c,sid,entries)],[O]);
  for(let i=0;i<n;i++) await L.sendTee(c.URL,[F.publishIx(c,sid,i,entries[i][0],entries[i][1])],[O]); await L.sleep(1200);
  const rec=[]; for(const [o,id] of entries) rec.push(await F.ownerRec(c,o,id)); const b1=[]; for(let o=0;o<5;o++) b1.push(await F.bal(c,o));
  const shares=n===1?[100]:n===2?[60,40]:[50,30,20]; const pot=FEE*n; const exp=b0.slice(); let paid=0; const byRank=rec.map((r,i)=>[r.rank,i]).sort((a,b)=>a[0]-b[0]);
  for(let o=0;o<n;o++) exp[o]-=FEE; byRank.slice(0,shares.length).forEach(([r,i],kk,arr)=>{ const amt=kk===arr.length-1?pot-paid:Math.floor(pot*shares[kk]/100); paid+=amt; exp[entries[i][0]]+=amt; });
  const ok=b1.every((v,i)=>v===exp[i]); log(`\n${n} ENTRANT(S): entered ${en.filter(x=>!x.err).length}, driver ${d.ok} txs; ranks ${rec.map((r,i)=>names[i]+"="+r.rank).join(" ")}`); log(`  Settle: ${s.sig} ${s.err?"FAILED "+JSON.stringify(s.err):"ok"} | second Settle ${s2.err?"REJECTED":"ACCEPTED (BAD)"} | Publish-before-Settle was ${early.err?"REJECTED":"ACCEPTED (BAD)"}`);
  log(`  balances before ${b0.join(",")} -> after ${b1.join(",")} | expected ${exp.join(",")} | ${ok?"EXACT MATCH":"MISMATCH"} (pot ${pot}, shares ${shares.join("/")}%)`);
  const h1=await F.hubLamports(c); const cl=await L.sendTee(c.URL,[F.cleanupIx(c,sid)],[O]); const h2=await F.hubLamports(c); log(`  Cleanup ${cl.sig} ${cl.err?"FAILED "+JSON.stringify(cl.err):"ok"}: hub lamports ${hub0} -> ${h1} (arena rent ${hub0-h1}) -> ${h2} after cleanup (refunded ${h2-h1}); arena readable after: ${(await L.readAcct(c.URL,L.arenaPda(sid)))===null?"null":"non-null"}`); }
