# Repository banner

`og.png` is the 1200 × 630 README banner. `og.svg` is its vector export; edit the artwork in `generate-og.mjs`.

Regenerate from the repository root using an isolated renderer installation (no application dependency changes):

```sh
renderer=$(mktemp -d)
npm install --prefix "$renderer" takumi-js
node assets/generate-og.mjs "$renderer"
```

Inspect the generated PNG before committing both exports. Uses Takumi's bundled sans-serif font and original artwork, with no external brand logos.

To also use this image as GitHub's social preview, upload `og.png` under repository **Settings → General → Social preview**. A README image alone does not configure GitHub's social-preview metadata.
