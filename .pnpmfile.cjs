// Strips dev-only fields before packing: `scripts`, and `imports` (points at the unshipped `src/`).
const PACKED = new Set(["@bosdev/sentra-core", "@bosdev/sentra-cli"]);

function beforePacking(pkg) {
  if (!PACKED.has(pkg.name)) {
    return pkg;
  }
  const { imports: _imports, scripts: _scripts, ...rest } = pkg;
  return rest;
}

module.exports = { hooks: { beforePacking } };
