/**
 * `server-only` exists to make Next fail a build that pulls a server module
 * into a client bundle. Under Vitest there is no such bundle, and the package
 * resolves to its client stub, which throws on import — so a test that
 * exercises real server code (src/lib/db/*, src/server/*) cannot load it.
 *
 * Aliasing the package to this empty module keeps the guard working where it
 * matters (the Next build) while letting the tests import the same code the
 * application runs.
 */
export {};
