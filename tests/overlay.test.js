const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function overlay(initial = {}, delayed = false, delayedState = false) {
  const elements = new Map(['line','orig','bg','size','clear'].map(id => [id,
    {value:'',textContent:'',events:{},addEventListener(type, fn) {this.events[type] = fn;}}]));
  const changes = [], messages = [], timers = new Map(), styles = {};
  let read, stateReply, timer = 0;
  const ctx = vm.createContext({window:{},document:{getElementById:id=>elements.get(id),
    body:{className:'',style:{setProperty:(key,value)=>{styles[key]=value;}}}},
    ntSetLang(){}, ntApplyI18n(){}, Date,
    setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),
    chrome:{storage:{local:{
      get(defaults, callback) {read=()=>callback({...defaults,...initial});if(!delayed)read();},
      set:async()=>{}
    },onChanged:{addListener:fn=>changes.push(fn)}},runtime:{
      onMessage:{addListener:fn=>messages.push(fn)},
      sendMessage:()=>delayedState ? new Promise(resolve=>{stateReply=resolve;}) : Promise.resolve({})
    }}
  });
  vm.runInContext(fs.readFileSync('src/overlay/overlay.js','utf8'),ctx);
  return {elements,ctx,styles,read:()=>read(),stateReply:reply=>stateReply(reply),
    change:(patch,area='local')=>changes.forEach(fn=>fn(patch,area)),
    show:msg=>messages.forEach(fn=>fn({type:'NT_SUBTITLE',...msg})),
    expire:()=>[...timers.values()].forEach(fn=>fn())};
}

test('an open OBS overlay immediately hides original text when the local setting changes', () => {
  const h=overlay({showOriginal:true,obsBg:'black',obsSize:52});
  h.show({text:'Translation',original:'Original'});
  assert.equal(h.elements.get('orig').textContent,'Original');
  h.change({showOriginal:{oldValue:true,newValue:false}});
  assert.equal(h.elements.get('orig').textContent,'');
  assert.equal(h.ctx.document.body.className,'bg-black');
  assert.equal(h.styles['--size'],'52px');
  h.show({text:'Next',original:'Next original'});
  assert.equal(h.elements.get('orig').textContent,'');
});

test('removing OBS preferences restores defaults without affecting other current settings', () => {
  const h=overlay({showOriginal:false,obsBg:'black',obsSize:52});
  h.show({text:'Translation',original:'Original'});
  h.change({showOriginal:{oldValue:false},obsBg:{oldValue:'black'}});
  assert.equal(h.elements.get('orig').textContent,'Original');
  assert.equal(h.ctx.document.body.className,'bg-green');
  assert.equal(h.styles['--size'],'52px');
  h.change({obsSize:{oldValue:52}});
  assert.equal(h.styles['--size'],'40px');
});

test('a late initial OBS read cannot override newer preference changes', () => {
  const h=overlay({showOriginal:true,obsBg:'black',obsSize:52},true);
  h.change({showOriginal:{newValue:false}});
  h.read();
  h.show({text:'Translation',original:'Original'});
  assert.equal(h.elements.get('orig').textContent,'');
  assert.equal(h.ctx.document.body.className,'bg-black');
  assert.equal(h.styles['--size'],'52px');
});

test('OBS waits for the stored original-text preference before exposing source text', () => {
  const h=overlay({showOriginal:false},true);
  h.show({text:'Translation',original:'Private original'});
  assert.equal(h.elements.get('orig').textContent,'');
  h.read();
  assert.equal(h.elements.get('orig').textContent,'');
});

test('OBS ignores settings from sync storage and unrelated local changes', () => {
  const h=overlay({showOriginal:true,obsBg:'black',obsSize:52});
  h.show({text:'Translation',original:'Original'});
  h.change({showOriginal:{newValue:false}},'sync');
  h.change({nt_sessions:{newValue:[]}});
  assert.equal(h.elements.get('orig').textContent,'Original');
  assert.equal(h.ctx.document.body.className,'bg-black');
  assert.equal(h.styles['--size'],'52px');
});

test('re-enabling original text cannot resurrect an expired or cleared OBS caption', () => {
  const h=overlay({showOriginal:false});
  h.show({text:'Translation',original:'Expired original'});h.expire();
  h.change({showOriginal:{newValue:true}});
  assert.equal(h.elements.get('orig').textContent,'');
  h.show({text:'New translation',original:'New original'});
  h.elements.get('clear').events.click();
  h.change({showOriginal:{newValue:false}});h.change({showOriginal:{newValue:true}});
  assert.equal(h.elements.get('orig').textContent,'');
});

test('a delayed initial state cannot replace a newer OBS caption or undo Clear', async () => {
  for (const clear of [false,true]) {
    const h=overlay({},false,true);
    h.show({text:'New translation',original:'New original'});
    if(clear)h.elements.get('clear').events.click();
    h.stateReply({subtitle:{text:'Old translation',original:'Old original'}});
    await new Promise(setImmediate);
    assert.equal(h.elements.get('line').textContent,clear?'':'New translation');
  }
});
