import { buildAnnotatedHexDump } from './example.js';

// Run with: npm run --workspace @homecsi/protocol print-example
// Prints the text that belongs between the GENERATED_EXAMPLE markers in
// docs/protocol.md section 13 — a convenience for keeping the doc's prose
// in sync after an intentional change to the example inputs. It does NOT
// by itself prove the bytes are correct (see the comment on
// buildAnnotatedHexDump in example.ts); that check is
// docs-example.test.ts's independent golden vector.
console.log(buildAnnotatedHexDump());
