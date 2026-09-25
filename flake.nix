{
  description = "harnexus development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Last nixpkgs revision that packages Bun 1.3.13, the version pinned in package.json and CI.
    nixpkgs-bun.url = "github:NixOS/nixpkgs/e439af0fbc7197adb2c600a537511828d5c6adb7";
  };

  outputs =
    {
      nixpkgs,
      nixpkgs-bun,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          bunPkgs = import nixpkgs-bun { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              bunPkgs.bun
              pkgs.lefthook
            ];

            shellHook = ''
              export DO_NOT_TRACK=1
            '';
          };
        }
      );

      formatter = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.nixfmt
      );
    };
}
