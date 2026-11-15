// Deterministically generate the small, original Hi5Central EPM shield icon.
// Run: node build-icon.js (no external dependencies).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const width = 128, height = 128;
function distance(x,y, ax,ay,bx,by) {
  const t = Math.max(0,Math.min(1,((x-ax)*(bx-ax)+(y-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2)));
  return Math.hypot(x-(ax+(bx-ax)*t),y-(ay+(by-ay)*t));
}
const image=Buffer.alloc((width*4+1)*height);
for(let y=0;y<height;y++){
  image[y*(width*4+1)]=0;
  for(let x=0;x<width;x++){
    const i=y*(width*4+1)+1+x*4;
    const edge=y<32 ? 23 : 23+Math.max(0,y-32)*0.44;
    const inside=y>=12&&y<116&&x>=edge&&x<width-edge;
    const check=distance(x,y,42,68,58,83)<5 || distance(x,y,58,83,88,48)<5;
    let rgba=[0,0,0,0];
    if(inside)rgba=[22,126,164,255];
    if(check&&inside)rgba=[255,255,255,255];
    for(let c=0;c<4;c++)image[i+c]=rgba[c];
  }
}
const table=new Uint32Array(256);
for(let n=0;n<256;n++){
  let c=n;
  for(let j=0;j<8;j++)c=(c&1) ? 0xEDB88320^(c>>>1) : c>>>1;
  table[n]=c>>>0;
}
function crc32(buffer){
  let crc=0xFFFFFFFF;
  for(const b of buffer)crc=table[(crc^b)&0xFF]^(crc>>>8);
  return (crc^0xFFFFFFFF)>>>0;
}
function chunk(name,data){
  const n=Buffer.from(name,"ascii"),size=Buffer.alloc(4),crc=Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([n,data])));
  return Buffer.concat([size,n,data,crc]);
}
const hdr=Buffer.alloc(13);
hdr.writeUInt32BE(width,0);hdr.writeUInt32BE(height,4);
hdr[8]=8;hdr[9]=6;
const png=Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]),
  chunk("IHDR",hdr),chunk("IDAT",zlib.deflateSync(image)),chunk("IEND",Buffer.alloc(0))
]);
fs.writeFileSync(path.join(__dirname,"icon-128.png"),png);
