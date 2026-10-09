# @homecsi/box

Owned by brief B3. Implements the "hand in a closed box" recreational
gesture-classification experiment: labelled take recording, raw-CSI
preservation, and an offline leave-one-take-out k-NN classifier with honest
accuracy reporting. See `docs/box-experiment.md` for the framing (why a
per-window classifier is legitimate here and forbidden for house occupancy)
and `server/packages/cli/CONTRACTS.md` for this package's exact exported
function contracts (`runBoxCli`).

**Structural fence:** this package is never imported by `@homecsi/features`
or `@homecsi/occupancy`, and its own preservation query only ever reads
`csi_records` rows from `role = 'box'` nodes (`nodes.role`, migration 011) --
see `docs/box-experiment.md` for why this, not a comment, is what actually
keeps a box gesture from ever contaminating whole-house occupancy data.
