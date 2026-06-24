import { defineConfig } from "tsdown";

// Bundle the bridge into a single ESM file for the runtime image.
//
// `serialport` is marked EXTERNAL on purpose: it carries a native binding that
// must be installed/built separately (the monorepo's pnpm-workspace.yaml sets
// `allowBuilds: "@serialport/bindings-cpp": false`, which skips that build). The
// Docker image installs a working `serialport` in a dedicated stage and the
// bundle resolves it from node_modules at runtime.
//
// Everything else (@meshtastic/sdk, @meshtastic/transport-node-serial,
// @meshtastic/protobufs from JSR, @bufbuild/protobuf) is bundled in, so the
// runtime image does not need to resolve `workspace:*`/`jsr:` specifiers.
export default defineConfig({
  entry: { server: "src/server.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  deps: {
    // Inline the SDK, serial transport, and protobuf runtime (workspace:* and
    // jsr: packages) so the runtime image needs no special resolution.
    // Regex (not bare strings) so subpath imports like
    // `@bufbuild/protobuf/codegenv1` and `@meshtastic/sdk/protobuf` are matched.
    alwaysBundle: [
      /^@meshtastic\//,
      /^@jsr\/meshtastic__/, // pnpm's on-disk alias for jsr:@meshtastic/protobufs
      /^@bufbuild\/protobuf/,
    ],
    // serialport carries a native binding installed separately in the image.
    neverBundle: ["serialport", /^@serialport\//],
  },
  dts: false,
  clean: true,
  sourcemap: false,
  minify: false,
  treeshake: true,
  report: false,
});
