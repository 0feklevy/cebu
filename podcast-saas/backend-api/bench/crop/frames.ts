/*
 * D-16 regression bench — what the RGB skin rule actually locates.
 *
 * Runs the real `SceneAnalyzer` + `locateHeads` over synthetic frames spanning skin tones
 * and warm set dressing (`.audit-ledger/vertical-crop-investigation.md` §2/BUG-2). Pure CPU.
 *
 * These are flat-colour blobs: they demonstrate the MECHANISM, not the rate. Sizing the
 * rate needs hand-labelled real frames (investigation measurement M1).
 *
 * Note this calls `locateHeads` with no speech signal — the audio-blind path — so it
 * reports the fallback behaviour a silent or undecodable track still gets.
 */
import { SceneAnalyzer, PROFILE_COLS } from '../../src/services/crop/sceneAnalyzer.js';
import { locateHeads } from '../../src/services/crop/headLocator.js';
const W=320,H=180;
function frame(spec:{blobs:{x:number,y:number,r:number,rgb:[number,number,number]}[],bg:[number,number,number]}):Uint8Array{
  const f=new Uint8Array(W*H*3);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const p=(y*W+x)*3;let c=spec.bg;
    for(const b of spec.blobs) if(Math.hypot(x-b.x,y-b.y)<b.r) c=b.rgb;
    f[p]=c[0];f[p+1]=c[1];f[p+2]=c[2];}
  return f;
}
const SKIN:[number,number,number]=[200,140,115];      // light skin, passes Kovac
const DARK:[number,number,number]=[85,55,42];         // deep skin tone
const WOOD:[number,number,number]=[150,95,60];        // warm wooden panel
const BG:[number,number,number]=[35,40,50];
const a=new SceneAnalyzer(W,H);
function run(label:string,f:Uint8Array){
  const g=a.toGray(f); const p=a.analyze(f,g,null);
  const skS=Float64Array.from(p.skin), saS=Float64Array.from(p.saliency), acS=new Float64Array(PROFILE_COLS);
  const hm=locateHeads(skS,saS,acS);
  console.log(`${label.padEnd(46)} interestX=${p.interestX.toFixed(3)}  heads=[${hm.heads.map(h=>h.toFixed(3)).join(', ')}] twoShot=${hm.isTwoShot}  skinMax=${Math.max(...p.skin).toFixed(0)}`);
}
run('two light-skin faces @0.30/0.70 (no audio path)', frame({bg:BG,blobs:[{x:96,y:70,r:26,rgb:SKIN},{x:224,y:70,r:26,rgb:SKIN}]}));
run('ONE light-skin face @0.30',                        frame({bg:BG,blobs:[{x:96,y:70,r:26,rgb:SKIN}]}));
run('ONE deep-skin-tone face @0.30',                    frame({bg:BG,blobs:[{x:96,y:70,r:26,rgb:DARK}]}));
run('deep-skin face @0.30 + wooden panel @0.75',        frame({bg:BG,blobs:[{x:96,y:70,r:26,rgb:DARK},{x:240,y:60,r:34,rgb:WOOD}]}));
run('light-skin face @0.30 + wooden panel @0.75',       frame({bg:BG,blobs:[{x:96,y:70,r:26,rgb:SKIN},{x:240,y:60,r:34,rgb:WOOD}]}));
run('slide: 2 bright text blocks, NO skin',             frame({bg:[20,20,20],blobs:[{x:80,y:70,r:30,rgb:[235,235,235]},{x:240,y:70,r:30,rgb:[235,235,235]}]}));
