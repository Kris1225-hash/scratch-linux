'use strict';
// the two memory models, as the pieces of SBL text that differ between them.
//
// flat (the default): ram is one list of 32-bit words and the tlb is one entry per linear page. simple and as
// fast as it gets, but both lists have millions of entries that must sit in the project file.
//
// paged (cfg.paged): for a project small enough to be saved on scratch.mit.edu (project.json <= 5 MB) nothing
// big may be in the file, and a list built by blocks stops growing at 200,000 items. so ram is split over
// "cold" lists of 195 pages each, and the cpu works on a "hot" list of 195 page frames (memw) that pages are
// copied into and out of. the tlb hands out addresses inside the frames, which keeps the handlers' fast paths
// the same as in the flat build; it becomes two levels deep (a table per 4 MB of address space).
module.exports = function mem(cfg) {
  const paged = !!cfg.paged;
  const simple = (x) => (/^[A-Za-z_0-9]+(\[[A-Za-z_0-9]+\])?$/.test(x) ? x : `(${x})`);
  const two = (l1, x) => `itemf(tlbP, itemf(${l1}, ${simple(x)} / 4194304 + tlbOff) + (${simple(x)} / 4096) % 1024)`;
  return {
    paged,
    NF: 195,                 // hot frames
    CPP: 195,                // pages per cold list
    // read / write tlb entry for the linear address expression x (0 = not cached). proc form and handler form:
    // in the flat build the handlers let scratch floor the index, the procs do it themselves
    TR: (x) => (paged ? two('tlb1R', x) : `tlbR[floor(${x} / 4096) + tlbOff]`),
    TW: (x) => (paged ? two('tlb1W', x) : `tlbW[floor(${x} / 4096) + tlbOff]`),
    TRf: (x) => (paged ? two('tlb1R', x) : `itemf(tlbR, ${x} / 4096 + tlbOff)`),
    TWf: (x) => (paged ? two('tlb1W', x) : `itemf(tlbW, ${x} / 4096 + tlbOff)`),
    coldLists(ramPages) {
      const n = Math.ceil((ramPages + 1) / 195), out = [];
      for (let k = 0; k < n; k++) out.push({ name: 'c' + k, pages: Math.min(195, ramPages + 1 - k * 195) });
      return out;
    },
  };
};
