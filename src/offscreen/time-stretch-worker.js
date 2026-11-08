// Local classic worker: no network, dependencies, or cached transferable data.
importScripts('time-stretch.js');
self.onmessage = ({data}) => {
  const samples = ntTimeStretch(data.samples, data.ratio, data.sampleRate);
  self.postMessage({id: data.id, samples}, [samples.buffer]);
};
