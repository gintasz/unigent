const MINIMUM_NODE_MAJOR_VERSION = 24;

function assertSupportedNodeVersion(version: string): void {
  const majorVersion = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  if (!Number.isInteger(majorVersion) || majorVersion < MINIMUM_NODE_MAJOR_VERSION) {
    throw new Error(
      `Node.js ${MINIMUM_NODE_MAJOR_VERSION} or newer is required; current version is ${version}.`,
    );
  }
}

export { assertSupportedNodeVersion };
