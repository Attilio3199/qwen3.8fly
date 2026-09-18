const URL='ws://localhost:3001';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
class C{constructor(n){this.n=n;this.m=[];this.ws=new WebSocket(URL);this.ws.onmessage=e=>this.m.push(JSON.parse(e.data));}send(o){this.ws.send(JSON.stringify(o));}close(){try{this.ws.close()}catch{}}}
(async()=>{
  const A=new C('A'),B=new C('B');
  await new Promise(r=>A.ws.onopen=r);
  A.send({t:'join',name:'A',plane:'fighter',weapons:['cannon','cannon','rocket']});
  await new Promise(r=>B.ws.onopen=r);
  B.send({t:'join',name:'B',plane:'bomber',weapons:['rocket','rocket','bomb'],start:true});
  await sleep(400);
  A.send({t:'input',p:[100,200,300],q:[0,0,0,1],v:[10,0,0],th:0.8,h:100});
  await sleep(600);
  console.log('B messages:');
  for(const m of B.m) console.log(' ',m.t, JSON.stringify(m).slice(0,140));
  A.close();B.close();await sleep(200);process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
