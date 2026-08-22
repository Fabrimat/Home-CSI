import { CsiFormat } from '@homecsi/protocol';
import { rootMeanSquare } from './dsp.js';

/** Raised when csi_data cannot be interpreted at all (corrupt/truncated/unknown format). */
export class CsiParseError extends Error {}

/** Raised when a configured explicit `subcarrierSelection` index doesn't fit this record's actual layout. */
export class SubcarrierSelectionError extends Error {}

export type SubcarrierSelection = 'all' | readonly number[];

export interface ParsedCsi {
  /** One entry per subcarrier: sqrt(I^2 + Q^2) from the raw signed 8-bit I/Q pair. Raw ADC-count units, not dBm — see normalizeAmplitudes for cross-time comparability. */
  amplitudes: Float64Array;
  /** Number of subcarriers this specific record's csi_data decoded to. Format-dependent (docs/architecture.md) — never assume this is constant across records. */
  subcarrierCount: number;
  /** Indices where I == Q == 0 — treated as guard/null subcarriers, not real measurements (see excludeNullSubcarriers). */
  nullSubcarrierIndices: readonly number[];
}

const KNOWN_CSI_FORMATS: ReadonlySet<number> = new Set([
  CsiFormat.Lltf,
  CsiFormat.HtLtf,
  CsiFormat.LltfHtLtf,
  CsiFormat.StbcHtLtf,
]);

export function isKnownCsiFormat(csiFormat: number): boolean {
  return KNOWN_CSI_FORMATS.has(csiFormat);
}

/**
 * Parses raw CSI bytes into per-subcarrier amplitude, deriving layout from
 * the record's own declared length rather than any assumed constant
 * (docs/architecture.md "Amplitude-first" / docs/protocol.md section 9.3):
 * each subcarrier is a signed 8-bit (I, Q) pair, so subcarrier count is
 * always `csiData.length / 2` regardless of which csi_format produced it.
 *
 * `csiFormat` still gates whether the bytes are usable at all: an
 * unassigned/unknown tag (docs/protocol.md section 9.3, values 4-255) means
 * the driver captured *something* but its layout isn't one we understand —
 * per the protocol doc such records "should [be] treat[ed] ... as
 * opaque/unusable for feature extraction", so this throws rather than
 * guessing.
 */
export function parseCsiAmplitudes(csiData: Buffer, csiFormat: number): ParsedCsi {
  if (!isKnownCsiFormat(csiFormat)) {
    throw new CsiParseError(
      `unrecognised csi_format ${csiFormat}; csi_data is opaque/unusable for feature extraction (docs/protocol.md section 9.3)`,
    );
  }
  if (csiData.length === 0) {
    throw new CsiParseError('empty csi_data');
  }
  if (csiData.length % 2 !== 0) {
    throw new CsiParseError(
      `csi_data length ${csiData.length} is not a whole number of signed 8-bit I/Q pairs`,
    );
  }

  const subcarrierCount = csiData.length / 2;
  const amplitudes = new Float64Array(subcarrierCount);
  const nullSubcarrierIndices: number[] = [];
  for (let i = 0; i < subcarrierCount; i++) {
    const iVal = csiData.readInt8(i * 2);
    const qVal = csiData.readInt8(i * 2 + 1);
    if (iVal === 0 && qVal === 0) {
      nullSubcarrierIndices.push(i);
    }
    amplitudes[i] = Math.sqrt(iVal * iVal + qVal * qVal);
  }

  return { amplitudes, subcarrierCount, nullSubcarrierIndices };
}

/**
 * Drops guard/null subcarriers (both I and Q reported as exactly zero) from
 * an amplitude array — these aren't real channel measurements, and letting
 * them into variance/MAD/mean calculations would bias every feature toward
 * "quieter than reality" by mixing in constant zeros. There is no
 * authoritative per-format guard-subcarrier index table in
 * docs/protocol.md, so this all-zero heuristic is used instead — documented
 * here rather than silently assumed.
 */
export function excludeNullSubcarriers(parsed: ParsedCsi): Float64Array {
  if (parsed.nullSubcarrierIndices.length === 0) return parsed.amplitudes;
  const nullSet = new Set(parsed.nullSubcarrierIndices);
  const kept: number[] = [];
  for (let i = 0; i < parsed.amplitudes.length; i++) {
    if (!nullSet.has(i)) kept.push(parsed.amplitudes[i] as number);
  }
  return Float64Array.from(kept);
}

/**
 * Applies `features.subcarrierSelection` to an already-null-filtered
 * amplitude array. "all" keeps everything. An explicit index list is
 * validated at runtime against *this record's* actual subcarrier count —
 * required because CSI record length/layout is format-dependent
 * (docs/architecture.md), so an index list tuned for e.g. LLTF+HT-LTF
 * (~192 subcarriers) is silently out of range for an LLTF-only record
 * (~64 subcarriers) unless checked per record.
 */
export function selectSubcarriers(
  amplitudes: Float64Array,
  selection: SubcarrierSelection,
  layoutSubcarrierCount: number,
): Float64Array {
  if (selection === 'all') {
    return amplitudes;
  }
  const outOfRange = selection.filter((idx) => idx < 0 || idx >= layoutSubcarrierCount);
  if (outOfRange.length > 0) {
    throw new SubcarrierSelectionError(
      `configured subcarrierSelection indices [${outOfRange.join(', ')}] are out of range for this record's actual layout (${layoutSubcarrierCount} subcarriers)`,
    );
  }
  const out = new Float64Array(selection.length);
  for (let i = 0; i < selection.length; i++) {
    out[i] = amplitudes[selection[i] as number] as number;
  }
  return out;
}

/**
 * Normalises a single record's amplitude vector by its own RMS so that AGC-
 * and RSSI-driven overall gain scaling doesn't masquerade as motion: the
 * ESP32's automatic gain control retargets received power independently of
 * multipath shape, so two captures of an identical (static) environment at
 * different AGC gain steps would otherwise show a large amplitude
 * *magnitude* change that has nothing to do with motion. Dividing by the
 * record's own RMS removes that absolute-gain component while preserving
 * the *shape* of the per-subcarrier amplitude pattern, which is what the
 * motion features below actually care about. Returns the input unchanged
 * (never divides by zero) when RMS is exactly 0 — callers should already
 * have dropped such records as corrupt before reaching here.
 */
export function normalizeAmplitudes(amplitudes: Float64Array): Float64Array {
  const rms = rootMeanSquare(Array.from(amplitudes));
  if (rms === 0) return amplitudes;
  const out = new Float64Array(amplitudes.length);
  for (let i = 0; i < amplitudes.length; i++) {
    out[i] = (amplitudes[i] as number) / rms;
  }
  return out;
}
