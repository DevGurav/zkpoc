const path = require("path");

require("@nomicfoundation/hardhat-toolbox");

// .cjs, not .js: the repo root's package.json declares "type": "module", so
// a plain hardhat.config.js here would be parsed as ESM and Hardhat's
// CommonJS-style config loading would fail. The extension sidesteps that
// regardless of any package.json in scope.
//
// paths.sources points OUTSIDE this directory, at the top-level contracts/
// -- see zk/README.md for why the toolchain lives here in zk/ (an isolated,
// explicitly-heavy devDependency tree) while its content lives in the
// already-documented top-level circuits/ and contracts/ directories.
//
// paths.root is pushed up to the repo root for exactly that reason: Hardhat
// 2 refuses to compile a source file it considers "outside the project"
// (HH1007), where "the project" defaults to the directory containing this
// config file. Since contracts/ is a sibling of zk/, not a child, the
// default root rejects it -- confirmed by direct experiment, not docs.
// Rooting one level up makes contracts/ a genuine descendant again.
module.exports = {
  solidity: "0.8.20",
  paths: {
    root: path.join(__dirname, ".."),
    sources: "contracts",
    tests: "zk/test",
    cache: "zk/build/cache",
    artifacts: "zk/build/artifacts",
  },
};
