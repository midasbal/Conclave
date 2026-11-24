import * as L from "./lib.mjs"; import fs from "fs";
const {K,ixp,u64,O,PublicKey,Keypair,SystemProgram}=L; const log=L.logger(L.EV+"setup.txt");
const stF=L.ROOT+"/client/state.json"; const st=fs.existsSync(stF)?JSON.parse(fs.readFileSync(stF)):{}; const save=()=>fs.writeFileSync(stF,JSON.stringify(st,null,1));
const validator=new PublicKey((await L.rpc(L.TEE,"getIdentity")).result.identity); log("== SETUP (base devnet)",new Date().toISOString(),"program",L.PROGRAM.toBase58(),"TEE validator",validator.toBase58());
const bal0=await L.base.getBalance(O.publicKey); log("payer balance before (lamports):",bal0);
const NP=5; const pf=L.KEYS+"/players.json"; let players; if(fs.existsSync(pf)) players=JSON.parse(fs.readFileSync(pf)).map(a=>Keypair.fromSecretKey(Uint8Array.from(a))); else { players=Array.from({length:NP},()=>Keypair.generate()); fs.writeFileSync(pf,JSON.stringify(players.map(p=>[...p.secretKey]))); }
const hub=L.hubPda(); const da=a=>L.delegAccts(a);
const delIx=(payer,pdaK,kind,id,owner)=>{ const a=da(pdaK); const data=Buffer.concat([Buffer.from([kind]),L.u64(id),owner?owner.toBuffer():Buffer.alloc(32)]); return ixp(2,[K(payer,true,true),K(SystemProgram.programId),K(pdaK,true),K(L.PROGRAM),K(a.buffer,true),K(a.record,true),K(a.meta,true),K(L.DLP),K(validator)],data); };
if(!st.hub){ log("SIG base InitHub (fund 0.06 SOL):",await L.sendBase([ixp(0,[K(O.publicKey,true,true),K(hub,true),K(SystemProgram.programId)],u64(60_000_000))],[O])); log("SIG base Delegate hub → TEE:",await L.sendBase([delIx(O.publicKey,hub,0,0,null)],[O])); st.hub=true; save(); }
if(!st.funded){ for(const p of players){ const t=new L.Transaction().add(SystemProgram.transfer({fromPubkey:O.publicKey,toPubkey:p.publicKey,lamports:30_000_000})); t.feePayer=O.publicKey; await L.sendAndConfirmTransaction(L.base,t,[O]); } log("funded",players.length,"players 0.03 SOL each:",players.map(p=>p.publicKey.toBase58().slice(0,6)).join(" ")); st.funded=true; save(); }
if(!st.mint){ const mint=await L.createMint(L.base,O,O.publicKey,null,0); st.mint=mint.toBase58(); log("mint (decimals 0):",st.mint); save(); }
const mint=new PublicKey(st.mint);
if(!st.minted){ for(const p of players){ const ata=await L.createAssociatedTokenAccountIdempotent(L.base,O,mint,p.publicKey); await L.mintTo(L.base,O,mint,ata,O,100); } log("minted 100 tokens to each player (base ATAs)"); st.minted=true; save(); }
const codes=L.loadPool(); const names=["Mom20th","RevZth","EMAcross","TrendSwitch","SwitchFade"]; st.names=names;
if(!st.regs){ for(let i=0;i<NP;i++){ const p=players[i], code=codes[names[i]].code, id=i+1; const reg=L.regPda(p.publicKey,id);
    const s1=await L.sendBase([ixp(1,[K(p.publicKey,true,true),K(reg,true),K(SystemProgram.programId)],Buffer.concat([L.u64(id),L.sha256(code)]))],[O,p]); log(`SIG base Register ${names[i]} (id ${id}, ${code.length} B, owner ${p.publicKey.toBase58().slice(0,6)}) hash ${L.sha256(code).toString("hex").slice(0,16)}:`,s1);
    const s2=await L.sendBase([delIx(p.publicKey,reg,1,id,p.publicKey)],[O,p]); log(`SIG base Delegate registry ${id} → TEE:`,s2); } st.regs=true; save(); }
st.sid=st.sid||(1000+Math.floor(Date.now()/1000)%100000); save(); const sid=st.sid; const pool=L.poolPda(sid), pe=L.eataOf(pool,mint);
if(!st.pool){ const a=da(pe); const buf=L.pda([Buffer.from("buffer"),pe.toBuffer()],L.ESPL);
  log("SIG base InitPool (eSPL eATA owned by pool PDA, delegated):",await L.sendBase([ixp(13,[K(O.publicKey,true,true),K(pe,true),K(pool),K(mint),K(SystemProgram.programId),K(L.ESPL),K(buf,true),K(a.record,true),K(a.meta,true),K(L.DLP),K(validator)],L.u64(sid))],[O])); st.pool=true; save(); }
if(!st.espl){ for(let i=0;i<NP;i++){ const p=players[i]; const ixs=await L.delegateSpl(p.publicKey,mint,50n,{validator,idempotent:false,payer:O.publicKey}); log(`SIG base delegateSpl player ${i+1} 50 tokens → TEE:`,await L.sendBase(ixs,[O,p])); } st.espl=true; save(); }
log("season id",sid,"arena",L.arenaPda(sid).toBase58(),"pool PDA",pool.toBase58(),"pool eATA",pe.toBase58()); const bal1=await L.base.getBalance(O.publicKey); log("payer balance after (lamports):",bal1,"| setup cost (SOL):",((bal0-bal1)/1e9).toFixed(4));
