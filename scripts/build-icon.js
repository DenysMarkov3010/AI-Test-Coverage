/**
 * Build assets/ai-test-coverage.ico from assets/ai-test-coverage.png (multi-size, Windows-friendly).
 */
const fs = require("fs");
const path = require("path");
const pngToIco = require("png-to-ico");

async function main() {
  const assets = path.join(__dirname, "..", "assets");
  const pngPath = path.join(assets, "ai-test-coverage.png");
  const icoPath = path.join(assets, "ai-test-coverage.ico");
  if (!fs.existsSync(pngPath)) {
    console.error("Missing:", pngPath);
    process.exit(1);
  }
  const buf = await pngToIco([pngPath]);
  fs.writeFileSync(icoPath, buf);
  console.log("Wrote", icoPath, "(" + buf.length + " bytes)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
