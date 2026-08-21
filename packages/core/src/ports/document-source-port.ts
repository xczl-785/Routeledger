/**
 * Reads a UTF-8 document relative to the host's workspace root.
 *
 * The host owns physical-root containment, including symlink handling. Core
 * validates business-facing entry-file syntax before it uses this port.
 */
export interface DocumentSourcePort {
  readUtf8(relativePath: string): Promise<string>;
}
