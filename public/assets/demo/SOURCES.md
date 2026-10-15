# Demo photos

Built by `tools/make_demo.py` from the labelled set in `bench/`, so the interface can
show the flow without the user supplying a photo. Each source is verified against the
sha256 recorded in `bench/manifest.json` before it is used.

These are the publishers' own published photographs, included as test fixtures. They
remain the property of their publishers and are included here as test fixtures only.

## `implant.jpg`

- A real Gen-1 Ledger Nano X implant: an add-on board glued into the case, with enamelled wires to the test pads.
- source: https://grandideastudio.com/media/_portfolio/ledger_implant_img1.jpg
- case: `implant-ledger-gen1-gis` · sha256 `7d18a9a528ee4c7d…`
- as published · 1874x1244

## `genuine.jpg`

- A genuine Ledger Nano X revision-4 board, photographed by Ledger as a reference for owners checking their own unit. Reads clean, and its MCU is the STM32WB35 that revision 4 carries.
- source: https://ledgercustomersuccess.file.force.com/file-asset-public/asset_4404382029329F?oid=00D06000001SxsQ
- case: `genuine-nanox-rev4-green-front` · sha256 `5b524756b22ae16d…`
- as published · 2054x636

## `injection.jpg`

- The genuine reference photo with a note overlaid on it that tries to instruct the checker. Synthesised here to exercise the hardening; the photo underneath is the same source as genuine.jpg.
- source: https://ledgercustomersuccess.file.force.com/file-asset-public/asset_4404382029329F?oid=00D06000001SxsQ
- case: `genuine-nanox-rev4-green-front` · sha256 `5b524756b22ae16d…`
- synthesised from that photo · 2054x636
