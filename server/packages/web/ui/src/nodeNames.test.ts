import { describe, it, expect } from 'vitest';
import { NodeDirectory, normalizeMac, sortByRecency, type NodeInfo } from './nodeNames.js';

const NODES: NodeInfo[] = [
  { id: 1, name: 'lab-vessel', room: 'bring-up bench', expectedMac: '3c:61:05:0f:ff:bc' },
  { id: 2, name: 'lab-beacon', room: 'bring-up bench', expectedMac: '3C-61-05-10-7B-60' },
  { id: 3, name: 'unprovisioned', room: 'hall', expectedMac: null },
];

describe('normalizeMac', () => {
  it('reduces every written form of one address to the same key', () => {
    const forms = ['3c:61:05:0f:ff:bc', '3C:61:05:0F:FF:BC', '3c-61-05-0f-ff-bc', '3c61050fffbc'];
    const keys = new Set(forms.map(normalizeMac));
    expect(keys.size).toBe(1);
  });
});

describe('NodeDirectory', () => {
  const dir = new NodeDirectory(NODES);

  it('names a node by id, and falls back to the id when it is not registered', () => {
    expect(dir.nodeLabel(1)).toBe('lab-vessel');
    expect(dir.nodeLabel(99)).toBe('node 99');
  });

  it('resolves a MAC to a node name regardless of separators or case', () => {
    expect(dir.macLabel('3C:61:05:10:7B:60')).toBe('lab-beacon');
    expect(dir.macLabel('3c6105107b60')).toBe('lab-beacon');
  });

  it('returns an unknown MAC verbatim rather than inventing a name', () => {
    // The common case in this deployment: a foreign transmitter the node
    // overheard. It must stay copy-pasteable.
    expect(dir.macLabel('06:cb:76:a3:7c:10')).toBe('06:cb:76:a3:7c:10');
  });

  it('labels the broadcast address as broadcast', () => {
    expect(dir.macLabel('ff:ff:ff:ff:ff:ff')).toBe('broadcast');
  });

  it('ignores a node with no expectedMac instead of matching everything to it', () => {
    expect(dir.nodeForMac('00:00:00:00:00:00')).toBeUndefined();
  });

  it('keeps the first claimant when two nodes declare the same MAC', () => {
    // A provisioning mistake. Resolving it silently by last-write-wins would
    // render a confidently wrong name; the second node stays a bare MAC.
    const dup = new NodeDirectory([
      { id: 1, name: 'first', room: 'a', expectedMac: 'aa:bb:cc:dd:ee:ff' },
      { id: 2, name: 'second', room: 'b', expectedMac: 'AA:BB:CC:DD:EE:FF' },
    ]);
    expect(dup.macLabel('aa:bb:cc:dd:ee:ff')).toBe('first');
  });

  it('renders a full link with the capturing node first', () => {
    expect(dir.linkLabel({ nodeId: 1, srcMac: '3c:61:05:10:7b:60', dstMac: 'ff:ff:ff:ff:ff:ff' })).toBe(
      'lab-vessel ⟵ lab-beacon → broadcast',
    );
  });

  it('drops the destination for source-only views', () => {
    expect(dir.sourceLabel({ nodeId: 2, srcMac: '3c:61:05:0f:ff:bc' })).toBe('lab-beacon ⟵ lab-vessel');
  });

  it('degrades to ids and MACs when the registry is empty', () => {
    const empty = new NodeDirectory([]);
    expect(empty.linkLabel({ nodeId: 4, srcMac: 'aa:bb:cc:dd:ee:ff', dstMac: '11:22:33:44:55:66' })).toBe(
      'node 4 ⟵ aa:bb:cc:dd:ee:ff → 11:22:33:44:55:66',
    );
  });
});

describe('sortByRecency', () => {
  it('puts the most recently heard link first', () => {
    const sorted = sortByRecency([
      { lastSeenAt: '2026-08-29T13:00:00.000Z', tag: 'old' },
      { lastSeenAt: '2026-08-29T13:20:00.000Z', tag: 'newest' },
      { lastSeenAt: '2026-08-29T13:10:00.000Z', tag: 'middle' },
    ]);
    expect(sorted.map((l) => l.tag)).toEqual(['newest', 'middle', 'old']);
  });

  it('does not mutate its input', () => {
    const input = [{ lastSeenAt: '2026-08-29T13:00:00.000Z' }, { lastSeenAt: '2026-08-29T13:20:00.000Z' }];
    const before = input.map((l) => l.lastSeenAt);
    sortByRecency(input);
    expect(input.map((l) => l.lastSeenAt)).toEqual(before);
  });

  it('sorts unparseable timestamps last instead of scrambling the rest', () => {
    const sorted = sortByRecency([
      { lastSeenAt: 'not a date', tag: 'bad' },
      { lastSeenAt: '2026-08-29T13:00:00.000Z', tag: 'old' },
      { lastSeenAt: '2026-08-29T13:20:00.000Z', tag: 'new' },
    ]);
    expect(sorted.map((l) => l.tag)).toEqual(['new', 'old', 'bad']);
  });
});
