// Dev-only manifest fields; `src/` is not shipped, so `imports` would point nowhere.
const PACKED = new Set(["@boshold/sentra-core", "@boshold/sentra-cli"]);

function beforePacking(pkg) {
  if (!PACKED.has(pkg.name)) {
    return pkg;
  }
  const { imports: _imports, scripts: _scripts, ...rest } = pkg;
  return rest;
}

module.exports = { hooks: { beforePacking } };
