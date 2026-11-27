// Which engine this app serves. public/engine/README.md says how the file was built and checked. The worker refuses a file whose hash differs.
export const ENGINE = {
  path: "/engine/conclave_author-20d30f39.wasm",
  sha256: "20d30f391d0e0b1161643c5d2aec896e4159b44c70773698f897d3300aff7e7c",
  bytes: 256285,
  ruleset: 2,
} as const;
