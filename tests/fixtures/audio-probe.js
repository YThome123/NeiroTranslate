// Loaded ONLY into the temporary E2E extension copy, never into a release.
// Substitute the HTTP boundary; retain real decoding, scheduling and WebAudio output.
const qa = {mode:'ok', requests:[], pending:[], starts:0, sourceStarts:[], stops:0, immediateStops:0, duration:8, analyser:null, gain:null};
const qaFetch = globalThis.fetch;
function qaWave() {
  const count = Math.floor(24000 * qa.duration), bytes = new ArrayBuffer(44 + count * 2), v = new DataView(bytes);
  const str = (at, s) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  str(0,'RIFF'); v.setUint32(4,36 + count * 2,true); str(8,'WAVEfmt ');
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,24000,true); v.setUint32(28,48000,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
  str(36,'data'); v.setUint32(40,count * 2,true);
  for (let i=0;i<count;i++) v.setInt16(44+i*2,Math.sin(i*2*Math.PI*330/24000)*5000,true);
  return bytes;
}
globalThis.fetch = async (url, options) => {
  if (!String(url).includes('/translate_tts')) return qaFetch(url, options);
  const request = {text:new URL(url).searchParams.get('q'), host:new URL(url).hostname, version:mediaVersion, at:Date.now(), aborted:false};
  qa.requests.push(request);
  options?.signal?.addEventListener('abort', () => {request.aborted=true;}, {once:true});
  if (qa.mode === 'live') {
    const response = await qaFetch(url, options);
    request.headersAt = Date.now(); request.status = response.status;
    return response;
  }
  if (qa.mode === 'delay') await new Promise(resolve=>setTimeout(resolve,450));
  if (qa.mode === 'hold' || (qa.mode === 'hold-future' && request.text.includes('UPCOMING')) || (qa.mode === 'slow-primary' && request.host === 'translate.google.com') ||
      (qa.mode === 'hold-tail' && request.text.includes('SECONDCHUNK'))) {
    await new Promise(resolve => qa.pending.push(resolve));
  }
  if (qa.mode === 'error') return new Response('', {status:503});
  return new Response(qaWave(), {headers:{'Content-Type':'audio/wav'}});
};
const qaStart = AudioBufferSourceNode.prototype.start, qaStop = AudioBufferSourceNode.prototype.stop;
AudioBufferSourceNode.prototype.start = function(...args) {
  const scheduledAt=Date.now(), audioNow=this.context.currentTime;
  const result=qaStart.apply(this,args);
  qa.starts++;
  qa.sourceStarts.push({scheduledAt,startAt:scheduledAt+Math.max(0,(args[0] || 0)-audioNow)*1000,
    version:mediaVersion,context:this.context.state});
  return result;
};
AudioBufferSourceNode.prototype.stop = function(...args) {qa.stops++;if(!args.length)qa.immediateStops++;return qaStop.apply(this,args);};
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type !== 'NT_QA_AUDIO') return false;
  if (msg.mode) qa.mode = msg.mode;
  if (msg.duration>0 && msg.duration<=20) qa.duration=msg.duration;
  if (msg.release) qa.pending.splice(0).forEach(resolve => resolve());
  if (player && dubGain && qa.gain !== dubGain) {
    qa.analyser = playCtx.createAnalyser(); qa.analyser.fftSize=256;
    dubGain.connect(qa.analyser); qa.gain=dubGain;
  }
  const samples = new Float32Array(256);
  qa.analyser?.getFloatTimeDomainData(samples);
  reply({ok:true, requests:qa.requests, pending:qa.pending.length, starts:qa.starts, sourceStarts:qa.sourceStarts, stops:qa.stops, immediateStops:qa.immediateStops,
    sources:player?.sources.size || 0, ahead:player?.aheadSec || 0, speaking:!!player?.speaking,
    rms:Math.sqrt(samples.reduce((sum,x) => sum+x*x,0)/samples.length),
    busy:speech.busy, queue:speech.queue.length, generation:speech.generation, paused:mediaPaused,
    version:mediaVersion, context:playCtx?.state});
  return false;
});
