// An isolated clock for VM-based deadline tests; never changes Node globals.
function fakeClock(initial = 0) {
  let now = initial, next = 0;
  const timers = new Map();
  class Clock extends Date {
    constructor(...args) {super(...(args.length ? args : [now]));}
    static now() {return now;}
  }
  return {
    now:()=>now,
    globals:{Date:Clock,
      setTimeout(callback, delay=0) {const id=++next;timers.set(id,{at:now+Math.max(0,Number(delay)||0),callback});return id;},
      clearTimeout:id=>timers.delete(id)},
    async advance(milliseconds) {
      const until=now+milliseconds;
      for (;;) {
        await new Promise(setImmediate);
        const nextTimer=[...timers].filter(([,timer])=>timer.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!nextTimer)break;
        now=nextTimer[1].at;timers.delete(nextTimer[0]);nextTimer[1].callback();
      }
      now=until;await new Promise(setImmediate);
    }
  };
}
module.exports={fakeClock};
