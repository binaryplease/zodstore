{
  description = "zodstore — native SQLite + Zod document-store library for Bun";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        # Development shell. Everything the mise tasks need to run:
        #   - bun  runs the TypeScript sources and the test suite directly
        #          (the library targets `bun:sqlite`, so bun is the runtime)
        #   - mise reads .mise.toml and drives the typecheck/test/build tasks
        #          it also pins the toolchain versions it declares
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.bun
            pkgs.mise
          ];
        };
      }
    );
}
