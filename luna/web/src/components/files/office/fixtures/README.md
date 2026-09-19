# x2t format fixtures

Real legacy OLE Office files used by `../x2tFormats.test.js`. The OLE
compound format can't be synthesized by hand, so these are genuine
application output — not stub bytes.

| File | Source |
|---|---|
| `real.xls` | Python `xlwt` (valid BIFF8 workbook) |
| `real.xlt` | LibreOffice `--convert-to xlt` (MS Excel 97 template filter) |
| `real.ppt` | LibreOffice `--convert-to ppt` (MS PowerPoint 97 filter) |
| `real.pps` | LibreOffice `--convert-to pps` (MS PowerPoint 97 AutoPlay filter) |
| `real.doc` | LibreOffice `--convert-to doc` (MS Word 97 filter) — negative-test fixture; this build has **no** .doc reader, so it must fail |

All other extensions in `OFFICE_FORMATS` are covered by minimal-but-valid
packages the test builds in-memory (OOXML zips, zipped/flat ODF, RTF). `xlsb`
is bootstrapped at runtime by converting an xlsx fixture through x2t itself.

To regenerate the OLE fixtures, install LibreOffice and run:

```sh
soffice --headless --convert-to ppt --outdir . some.pptx
soffice --headless --convert-to pps --outdir . some.pptx
soffice --headless --convert-to xlt --outdir . some.xlsx
```
