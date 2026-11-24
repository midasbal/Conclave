import * as L from "./lib.mjs"; import fs from "fs"; import {execFileSync} from "child_process";
const {K,ixp,u64,u32,O,PublicKey,Keypair,SystemProgram}=L; const log=L.logger(L.EV+"season2.txt");
const st=JSON.parse(fs.readFileSync(L.ROOT+"/client/state.json")); const mint=new PublicKey(st.mint); const players=JSON.parse(fs.readFileSync(L.KEYS+"/players.json")).map(a=>Keypair.fromSecretKey(Uint8Array.from(a))); const codes=L.loadPool(); const names=st.names;
const validator=new PublicKey((await L.rpc(L.TEE,"getIdentity")).result.identity); const NEPS=+process.env.NEPS||30, FEE=10; const sid=st.sid+100; const arena=L.arenaPda(sid), pool=L.poolPda(sid), hub=L.hubPda(); const ata=o=>L.getAssociatedTokenAddressSync(mint,o,true);
const URL=`${L.TEE}?token=${await L.tokenFor(L.TEE,O)}`; const ptok=[]; for(const p of players) ptok.push(`${L.TEE}?token=${await L.tokenFor(L.TEE,p)}`);
const send=async(label,ixs,signers,cu)=>{ const r=await L.sendTee(URL,ixs,signers,cu?{cu}:{}); log(`SIG TEE ${label}: ${r.sig} ${r.err?"FAILED "+JSON.stringify(r.err):"ok"} (${r.ms}ms)`); return r; };
const expectFail=async(label,ixs,signers)=>{ const r=await L.sendTee(URL,ixs,signers); log(`GATING ${label}: ${r.err?"REJECTED "+JSON.stringify(r.err):"ACCEPTED (BAD)"}${r.sig?" sig "+r.sig:""}`); return !!r.err; };
const hubLamports=async()=>{ const d=(await L.rpc(URL,"getAccountInfo",[hub.toBase58(),{encoding:"base64"}])).result?.value; return d?d.lamports:null; };
log("\n== SEASON 2 (30 episodes) + cost measurement + gating",new Date().toISOString(),"season",sid);
const bal0=await L.base.getBalance(O.publicKey), hub0=await hubLamports(); log("payer lamports before:",bal0,"| hub (ER sponsor) lamports before:",hub0);
// base: pool eATA + base ATA
const a=L.delegAccts(L.eataOf(pool,mint)); const pe=L.eataOf(pool,mint); const buf=L.pda([Buffer.from("buffer"),pe.toBuffer()],L.ESPL);
log("SIG base InitPool:",await L.sendBase([ixp(13,[K(O.publicKey,true,true),K(pe,true),K(pool),K(mint),K(SystemProgram.programId),K(L.ESPL),K(buf,true),K(L.pda([Buffer.from("delegation"),pe.toBuffer()],L.DLP),true),K(L.pda([Buffer.from("delegation-metadata"),pe.toBuffer()],L.DLP),true),K(L.DLP),K(validator)],u64(sid))],[O]));
await L.createAssociatedTokenAccountIdempotent(L.base,O,mint,pool,undefined,undefined,undefined,true); for(let i=0;i<40;i++){ if(await L.readAcct(URL,pe)) break; await L.sleep(1000); }
const r0=await send(`CreateSeason ${sid} (neps ${NEPS}, spt 1, fee ${FEE}, maxslots 16)`,[ixp(5,[K(O.publicKey,true,true),K(hub,true),K(arena,true),K(L.permissionPdaFromAccount(arena),true),K(L.EPHEMERAL_VAULT_ID,true),K(L.MAGIC),K(L.PERMISSION_PROGRAM_ID)],Buffer.concat([u64(sid),u32(NEPS),u32(1),u64(FEE),mint.toBuffer(),Buffer.from([16])]))],[O]);
const enterIx=(i,id=i+1,signer=players[i])=>ixp(6,[K(signer.publicKey,false,true),K(L.stratPda(players[i].publicKey,id)),K(arena,true),K(ata(signer.publicKey),true),K(ata(pool),true),K(L.TOKEN)]);
// gating attempts before entering
const att=players[1], vic=players[0];
await expectFail("G1 attacker signs Enter for VICTIM's sealed strategy",[ixp(6,[K(att.publicKey,false,true),K(L.stratPda(vic.publicKey,1)),K(arena,true),K(ata(att.publicKey),true),K(ata(pool),true),K(L.TOKEN)])],[O,att]);
await expectFail("G2 attacker seals with VICTIM's registry under attacker's PDA",[ixp(3,[K(att.publicKey,false,true),K(hub,true),K(L.stratPda(att.publicKey,1),true),K(L.permissionPdaFromAccount(L.stratPda(att.publicKey,1)),true),K(L.EPHEMERAL_VAULT_ID,true),K(L.MAGIC),K(L.PERMISSION_PROGRAM_ID),K(L.regPda(vic.publicKey,1))],Buffer.concat([u64(1),codes[names[0]].code]))],[O,att]);
await expectFail("G3 attacker seals victim's PDA without victim's signature (attacker signs as 'owner' of victim's accounts)",[ixp(3,[K(att.publicKey,false,true),K(hub,true),K(L.stratPda(vic.publicKey,1),true),K(L.permissionPdaFromAccount(L.stratPda(vic.publicKey,1)),true),K(L.EPHEMERAL_VAULT_ID,true),K(L.MAGIC),K(L.PERMISSION_PROGRAM_ID),K(L.regPda(vic.publicKey,1))],Buffer.concat([u64(1),codes[names[0]].code]))],[O,att]);
await expectFail("G4 owner re-seals an existing id (overwrite attempt)",[ixp(3,[K(vic.publicKey,false,true),K(hub,true),K(L.stratPda(vic.publicKey,1),true),K(L.permissionPdaFromAccount(L.stratPda(vic.publicKey,1)),true),K(L.EPHEMERAL_VAULT_ID,true),K(L.MAGIC),K(L.PERMISSION_PROGRAM_ID),K(L.regPda(vic.publicKey,1))],Buffer.concat([u64(1),codes[names[0]].code]))],[O,vic]);
await expectFail("G5 non-authority (player 2) calls Lock",[ixp(7,[K(att.publicKey,true,true),K(arena,true)])],[att]);
await expectFail("G6 RequestSeed before lock",[ixp(8,[K(O.publicKey,true,true),K(arena,true),K(L.identityPda()),K(L.EQUEUE,true),K(SystemProgram.programId),K(L.SLOTH),K(L.VRF)])],[O]);
await expectFail("G7 Advance before seed",[ixp(9,[K(arena,true)],Buffer.from([60,0]))],[O]);
// enter (retry: pool ATA materialisation on the TEE can lag)
for(let i=0;i<5;i++){ let r; for(let t=0;t<12;t++){ r=await L.sendTee(URL,[enterIx(i)],[O,players[i]]); if(!r.err) break; await L.sleep(2500); } log(`SIG TEE Enter ${names[i]}: ${r.sig} ${r.err?"FAILED "+JSON.stringify(r.err):"ok"} (attempts until ok: ${r.err?"gave up":"see timing"})`); }
await expectFail("G8 Settle before the season is done",[ixp(10,[K(O.publicKey,true,true),K(arena,true),K(pool),K(ata(pool),true),K(L.TOKEN),...players.map(p=>K(ata(p.publicKey),true))])],[O]);
await send("Lock",[ixp(7,[K(O.publicKey,true,true),K(arena,true)])],[O]);
await expectFail("G9 Enter after Lock (late entry)",[enterIx(1)],[O,players[1]]);
const rq=await send("RequestSeed (VRF)",[ixp(8,[K(O.publicKey,true,true),K(arena,true),K(L.identityPda()),K(L.EQUEUE,true),K(SystemProgram.programId),K(L.SLOTH),K(L.VRF)])],[O]); const tReq=Date.now();
log("arena read (outsider/payer/owner1):",(await L.readAcct(L.TEE,arena))===null?"null":"NON-NULL",(await L.readAcct(URL,arena))===null?"null":"NON-NULL",(await L.readAcct(ptok[0],arena))===null?"null":"NON-NULL");
// driver: tune N to the CU budget; 5 mixed seats
let ok=0,fail=0,N=60,done=false,seeded=false,tSeed=null; const t0=Date.now(); let ticksTx=[];
for(let i=0;i<600&&!done;i++){ const r=await L.sendTee(URL,[ixp(9,[K(arena,true)],Buffer.from([N&255,N>>8]))],[O]); if(!r.err){ ok++; if(!seeded){seeded=true; tSeed=Date.now(); log(`  first Advance accepted ${tSeed-tReq} ms after RequestSeed was sent`);} }
  else if(JSON.stringify(r.err).includes("Custom")){ if(ok>0){ done=true; } else await L.sleep(300); } else { fail++; log("  Advance error:",JSON.stringify(r.err)); N=Math.max(5,N>>1); } }
log(`driver: ${ok} Advance txs ok, ${fail} CU-failures, wall ${(Date.now()-t0)/1000}s for ${NEPS*150} ticks`);
await expectFail("G10 Publish before Settle",[ixp(11,[K(O.publicKey,true,true),K(arena),K(L.stratPda(players[0].publicKey,1),true),K(L.regPda(players[0].publicKey,1),true)],Buffer.from([0]))],[O]);
const s=await send("Settle",[ixp(10,[K(O.publicKey,true,true),K(arena,true),K(pool),K(ata(pool),true),K(L.TOKEN),...players.map(p=>K(ata(p.publicKey),true))])],[O]);
await expectFail("G11 Settle a second time (double pay)",[ixp(10,[K(O.publicKey,true,true),K(arena,true),K(pool),K(ata(pool),true),K(L.TOKEN),...players.map(p=>K(ata(p.publicKey),true))])],[O]);
for(let i=0;i<5;i++) await send(`Publish slot ${i}`,[ixp(11,[K(O.publicKey,true,true),K(arena),K(L.stratPda(players[i].publicKey,i+1),true),K(L.regPda(players[i].publicKey,i+1),true)],Buffer.from([i]))],[O]);
await expectFail("G12 Publish slot 0 a second time",[ixp(11,[K(O.publicKey,true,true),K(arena),K(L.stratPda(players[0].publicKey,1),true),K(L.regPda(players[0].publicKey,1),true)],Buffer.from([0]))],[O]);
await send("Commit registries → base",[ixp(12,[K(O.publicKey,true,true),K(L.MAGIC),K(L.MCTX,true),...players.map((p,i)=>K(L.regPda(p.publicKey,i+1),true))])],[O]);
const bal1=await L.base.getBalance(O.publicKey), hub1=await hubLamports(); log("payer lamports after:",bal1,"| delta (SOL):",((bal1-bal0)/1e9).toFixed(6),"| hub lamports after:",hub1,"| ER sponsor rent consumed (lamports):",hub0-hub1);
// verification: owners read, identity vs local
await L.sleep(4000); const rows=[]; for(let i=0;i<5;i++){ const d=await L.readAcct(ptok[i],L.stratPda(players[i].publicKey,i+1)); rows.push({rank:d.readUInt32LE(88),pnl:d.readBigInt64LE(96),season:Number(d.readBigUInt64LE(80))-1}); }
let regB=null; for(let t=0;t<40;t++){ const b=await L.base.getAccountInfo(L.regPda(players[0].publicKey,1)); if(b&&b.data.readBigUInt64LE(96)===BigInt(sid)){ regB=b.data; break; } await L.sleep(1500); }
if(!regB){ log("registry commit not yet visible on base"); } else { const A=regB.readBigUInt64LE(112), B=regB.readBigUInt64LE(120); const idx=names.map(n=>codes[n].i);
  const out=execFileSync(L.LAB,["season",A.toString(),B.toString(),String(NEPS),L.OUT+"/real_pool.bin",idx.join(",")]).toString().trim().split(",").map(BigInt);
  let same=0; for(let i=0;i<5;i++){ const ok=out[i]===rows[i].pnl; if(ok) same++; log(`IDENTITY ${names[i].padEnd(12)} rank ${rows[i].rank} on-chain ${rows[i].pnl} | local ${out[i]} | ${ok?"BIT-IDENTICAL":"MISMATCH"}`); } log(`identity season 2: ${same}/5 bit-identical over ${NEPS} episodes (${NEPS*150} ticks)`); }
for(let i=0;i<5;i++){ const x=await L.readAcct(ptok[i],ata(players[i].publicKey)); log(`player ${i+1} ER token balance: ${x?x.readBigUInt64LE(64):"?"}`); }
