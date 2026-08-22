/**
 * CSI amplitude decoding.
 *
 * docs/protocol.md section 9.2/9.3: raw `csi_data` is "signed 8-bit
 * interleaved I/Q pairs" for every `csi_format` value (the format only
 * changes *which* training fields were captured, i.e. how many pairs there
 * are — never the per-subcarrier byte width). We therefore derive the
 * subcarrier count purely from the byte length of the data we actually
 * have (`csi_len / 2`), never from `csi_format` or any assumed constant
 * (docs/architecture.md "Amplitude-first" / "No component may assume a
 * fixed subcarrier count").
 */
export function decodeAmplitudes(csiData: Buffer): number[] {
  const pairCount = Math.floor(csiData.length / 2);
  const amplitudes = new Array<number>(pairCount);
  for (let i = 0; i < pairCount; i++) {
    const iComponent = csiData.readInt8(i * 2);
    const qComponent = csiData.readInt8(i * 2 + 1);
    amplitudes[i] = Math.sqrt(iComponent * iComponent + qComponent * qComponent);
  }
  return amplitudes;
}
