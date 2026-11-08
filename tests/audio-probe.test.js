const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

test('audio probe records source scheduling on the audio clock before client polling',()=>{
  let receive,now=100000;
  class Source {
    constructor(){this.context={currentTime:10,state:'running'};}
    start(at){this.at=at;}
    stop(){}
  }
  const context=vm.createContext({fetch(){},AudioBufferSourceNode:Source,Date:{now:()=>now},
    chrome:{runtime:{onMessage:{addListener(fn){receive=fn;}}}},
    player:null,dubGain:null,playCtx:null,mediaVersion:7,mediaPaused:false,
    speech:{busy:false,queue:[],generation:1}});
  vm.runInContext(fs.readFileSync('tests/fixtures/audio-probe.js','utf8'),context);
  const source=new Source();source.start(10.06);now=105000;
  let result;receive({type:'NT_QA_AUDIO'},{},value=>{result=value;});
  assert.equal(result.starts,1);
  assert.ok(result.sourceStarts,'probe exposes source scheduling timestamps');
  assert.equal(result.sourceStarts[0].scheduledAt,100000);
  assert.equal(result.sourceStarts[0].startAt,100060);
  assert.equal(result.sourceStarts[0].version,7);
  assert.equal(result.sourceStarts[0].context,'running');
});
